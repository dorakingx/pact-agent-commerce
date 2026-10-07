/**
 * PayPal Sandbox payment provider: Orders v2 (intent AUTHORIZE), Payments v2 (capture / void /
 * reauthorize), Vault v3 (delegated agent wallet) and Webhooks v1 (signature verification).
 *
 * This class translates between PACT's provider contract and PayPal's wire format and nothing
 * else: it holds no deal state and makes no decisions. Whether a call may happen at all is
 * decided by the payment orchestrator, which is the only caller.
 */
import "server-only";
import { z } from "zod";
import { getPayPalConfig } from "../config";
import { CURRENCY, fromPayPalValue, toPayPalValue } from "../domain/money";
import { AUTHORIZATION_STATUSES, CAPTURE_STATUSES, ORDER_STATUSES } from "./info-schemas";
import { maskEmail } from "./mask";
import { PayPalHttp, unexpectedResponse, type PayPalResponse } from "./paypal-http";
import {
  PaymentError,
  type AuthorizationInfo,
  type CaptureInfo,
  type CaptureInput,
  type CreateOrderInput,
  type OrderInfo,
  type PaymentProvider,
  type VaultSetupInfo,
  type VaultTokenInfo,
  type WebhookVerification,
  type WebhookVerifyOptions,
} from "./types";
import {
  CertificateCache,
  SUPPORTED_AUTH_ALGO,
  isTrustedCertUrl,
  readSignatureHeaders,
  signedMessage,
  transmissionTimeProblem,
  verifySignature,
  type WebhookSignatureHeaders,
} from "./webhook-signature";

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  apiBase: string;
  webhookId?: string;
  fetchImpl?: typeof fetch;
  /** Epoch milliseconds. */
  now?: () => number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** PayPal field limits (Orders v2 / Payments v2). */
const MAX_DESCRIPTION = 127;
const MAX_NOTE_TO_PAYER = 255;
const TERMS_HASH = /^[a-f0-9]{64}$/;

/* -------------------------------------------------------------------------- */
/*  Wire schemas — deliberately loose: only the fields PACT reads are checked  */
/* -------------------------------------------------------------------------- */

const WireMoneySchema = z.object({ currency_code: z.string(), value: z.string() });
const WireLinkSchema = z.object({ rel: z.string(), href: z.string() });

const WireAuthorizationSchema = z.object({
  id: z.string().min(1),
  status: z.enum(AUTHORIZATION_STATUSES),
  amount: WireMoneySchema.nullish(),
  custom_id: z.string().nullish(),
  invoice_id: z.string().nullish(),
  expiration_time: z.string().nullish(),
});
type WireAuthorization = z.infer<typeof WireAuthorizationSchema>;

const WirePurchaseUnitSchema = z.object({
  amount: WireMoneySchema.nullish(),
  custom_id: z.string().nullish(),
  invoice_id: z.string().nullish(),
  payments: z.object({ authorizations: z.array(WireAuthorizationSchema).nullish() }).nullish(),
});

const WirePayPalSourceSchema = z.object({
  email_address: z.string().nullish(),
  attributes: z.object({ vault: z.object({ id: z.string().nullish() }).nullish() }).nullish(),
});

const WireOrderSchema = z.object({
  id: z.string().min(1),
  status: z.enum(ORDER_STATUSES),
  purchase_units: z.array(WirePurchaseUnitSchema).nullish(),
  links: z.array(WireLinkSchema).nullish(),
  payer: z.object({ email_address: z.string().nullish() }).nullish(),
  payment_source: z.object({ paypal: WirePayPalSourceSchema.nullish() }).nullish(),
});
type WireOrder = z.infer<typeof WireOrderSchema>;

const WireCaptureSchema = z.object({
  id: z.string().min(1),
  status: z.enum(CAPTURE_STATUSES),
  amount: WireMoneySchema.nullish(),
  final_capture: z.boolean().nullish(),
});
type WireCapture = z.infer<typeof WireCaptureSchema>;

const WireSetupTokenSchema = z.object({
  id: z.string().min(1),
  links: z.array(WireLinkSchema).nullish(),
});

const WirePaymentTokenSchema = z.object({
  id: z.string().min(1),
  payment_source: z.object({ paypal: WirePayPalSourceSchema.nullish() }).nullish(),
});

const WirePostbackSchema = z.object({ verification_status: z.string() });

/* -------------------------------------------------------------------------- */
/*  Wire -> PACT mapping                                                       */
/* -------------------------------------------------------------------------- */

function parseWire<T>(schema: z.ZodType<T>, what: string, response: PayPalResponse): T {
  const parsed = schema.safeParse(response.body);
  if (!parsed.success) throw unexpectedResponse(what, response);
  return parsed.data;
}

/** Minor units of a PayPal amount, or null when it is absent, malformed or not in USD. */
function minorOf(amount: z.infer<typeof WireMoneySchema> | null | undefined): number | null {
  if (!amount || amount.currency_code !== CURRENCY) return null;
  try {
    return fromPayPalValue(amount.value);
  } catch {
    return null;
  }
}

/** PayPal timestamps are already ISO-8601 UTC; re-rendering them guarantees one format everywhere. */
function isoOrNull(timestamp: string | null | undefined): string | null {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function toAuthorizationInfo(
  wire: WireAuthorization,
  what: string,
  response: PayPalResponse,
  /** An authorization nested in an order inherits the binding fields of its purchase unit. */
  inherited: { customId: string | null; invoiceId: string | null } = { customId: null, invoiceId: null },
): AuthorizationInfo {
  const amountMinor = minorOf(wire.amount);
  if (amountMinor === null) throw unexpectedResponse(what, response);
  return {
    authorizationId: wire.id,
    status: wire.status,
    amountMinor,
    currency: CURRENCY,
    expiresAt: isoOrNull(wire.expiration_time),
    customId: wire.custom_id ?? inherited.customId,
    invoiceId: wire.invoice_id ?? inherited.invoiceId,
  };
}

function toOrderInfo(wire: WireOrder, what: string, response: PayPalResponse): OrderInfo {
  const unit = wire.purchase_units?.[0];
  const amountMinor = minorOf(unit?.amount);
  if (!unit || amountMinor === null) throw unexpectedResponse(what, response);
  const customId = unit.custom_id ?? null;
  const invoiceId = unit.invoice_id ?? null;
  const authorization = unit.payments?.authorizations?.[0];
  const links = wire.links ?? [];
  // With payment_source.paypal the approval link is "payer-action"; without it PayPal calls it "approve".
  const approveLink = links.find((link) => link.rel === "payer-action") ?? links.find((link) => link.rel === "approve");
  const paypalSource = wire.payment_source?.paypal;
  return {
    orderId: wire.id,
    status: wire.status,
    amountMinor,
    currency: CURRENCY,
    customId,
    invoiceId,
    approveUrl: approveLink?.href ?? null,
    authorization: authorization ? toAuthorizationInfo(authorization, what, response, { customId, invoiceId }) : null,
    payerEmailMasked: maskEmail(wire.payer?.email_address ?? paypalSource?.email_address),
    vaultId: paypalSource?.attributes?.vault?.id ?? null,
  };
}

function resourcePath(prefix: string, id: string, suffix = ""): string {
  if (id === "") throw new RangeError("PayPal resource id must not be empty");
  return `${prefix}/${encodeURIComponent(id)}${suffix}`;
}

/* -------------------------------------------------------------------------- */
/*  Provider                                                                   */
/* -------------------------------------------------------------------------- */

export class PayPalSandboxProvider implements PaymentProvider {
  readonly kind = "paypal_sandbox" as const;
  readonly supportsVault = true;

  private readonly http: PayPalHttp;
  private readonly webhookId: string | undefined;
  private readonly now: () => number;
  private readonly certificates: CertificateCache;

  constructor(options: PayPalClientOptions) {
    // Throws for anything that is not the Sandbox (or a loopback emulator): PACT never touches live funds.
    this.http = new PayPalHttp(options);
    this.webhookId = options.webhookId;
    this.now = options.now ?? Date.now;
    this.certificates = new CertificateCache({
      fetchImpl: options.fetchImpl ?? ((input, init) => fetch(input, init)),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      now: this.now,
    });
  }

  /* ------------------------------ Orders v2 ------------------------------ */

  async createOrder(input: CreateOrderInput): Promise<OrderInfo> {
    if (!TERMS_HASH.test(input.contractHash)) {
      throw new RangeError("contractHash must be the 64-character lowercase hex terms hash");
    }
    const paypalSource =
      input.vaultId === undefined
        ? {
            experience_context: {
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
              user_action: "PAY_NOW",
              brand_name: "PACT",
              shipping_preference: "NO_SHIPPING",
              landing_page: "LOGIN",
            },
          }
        : // Delegated agent wallet: the payer consented once when vaulting, so PayPal authorizes in this call.
          { vault_id: input.vaultId };
    const response = await this.http.request({
      method: "POST",
      path: "/v2/checkout/orders",
      template: "/v2/checkout/orders",
      idempotencyKey: input.idempotencyKey,
      representation: true,
      context: { dealId: input.dealId },
      body: {
        intent: "AUTHORIZE",
        // Exactly one purchase unit: PayPal does not support AUTHORIZE with several.
        purchase_units: [
          {
            reference_id: input.dealId,
            description: input.description.slice(0, MAX_DESCRIPTION),
            // PayPal's own record of the order carries the contract fingerprint from the first call on.
            custom_id: `pact:v1:${input.contractHash}`,
            invoice_id: input.contractId,
            amount: { currency_code: input.currency, value: toPayPalValue(input.amountMinor) },
          },
        ],
        payment_source: { paypal: paypalSource },
      },
    });
    return this.completeOrder(response, "create order", { dealId: input.dealId });
  }

  async getOrder(orderId: string): Promise<OrderInfo> {
    return this.fetchOrder(orderId, { paypalOrderId: orderId });
  }

  async authorizeOrder(orderId: string, idempotencyKey: string): Promise<OrderInfo> {
    const response = await this.http.request({
      method: "POST",
      path: resourcePath("/v2/checkout/orders", orderId, "/authorize"),
      template: "/v2/checkout/orders/{id}/authorize",
      idempotencyKey,
      representation: true,
      context: { paypalOrderId: orderId },
      body: {},
    });
    const order = await this.completeOrder(response, "authorize order", { paypalOrderId: orderId });
    // The authorization id is the whole point of this call; if a replay answered without it, read it back.
    return order.authorization === null ? this.getOrder(orderId) : order;
  }

  /**
   * Orders answered in PayPal's minimal form are completed with a GET. "Minimal" is not always
   * empty: without the full representation, an authorize (and a create against a vaulted wallet)
   * answers with a purchase unit that holds only `reference_id` and `payments` — no amount and
   * no custom_id. The POST succeeded and the order id is known, so reading the order back is
   * always the safe completion; failing here would book a held authorization as a refusal.
   */
  private async completeOrder(response: PayPalResponse, what: string, context: Record<string, string>): Promise<OrderInfo> {
    const wire = parseWire(WireOrderSchema, what, response);
    if (wire.purchase_units?.[0]?.amount) return toOrderInfo(wire, what, response);
    return this.fetchOrder(wire.id, context);
  }

  private async fetchOrder(orderId: string, context: Record<string, string>): Promise<OrderInfo> {
    const response = await this.http.request({
      method: "GET",
      path: resourcePath("/v2/checkout/orders", orderId),
      template: "/v2/checkout/orders/{id}",
      context,
    });
    return toOrderInfo(parseWire(WireOrderSchema, "get order", response), "get order", response);
  }

  /* ----------------------------- Payments v2 ----------------------------- */

  async getAuthorization(authorizationId: string): Promise<AuthorizationInfo> {
    const response = await this.http.request({
      method: "GET",
      path: resourcePath("/v2/payments/authorizations", authorizationId),
      template: "/v2/payments/authorizations/{id}",
      context: { paypalAuthorizationId: authorizationId },
    });
    const wire = parseWire(WireAuthorizationSchema, "get authorization", response);
    return toAuthorizationInfo(wire, "get authorization", response);
  }

  async captureAuthorization(input: CaptureInput): Promise<CaptureInfo> {
    const response = await this.http.request({
      method: "POST",
      path: resourcePath("/v2/payments/authorizations", input.authorizationId, "/capture"),
      template: "/v2/payments/authorizations/{id}/capture",
      idempotencyKey: input.idempotencyKey,
      representation: true,
      context: { paypalAuthorizationId: input.authorizationId },
      body: {
        amount: { currency_code: input.currency, value: toPayPalValue(input.amountMinor) },
        // PayPal defaults to false, which would keep the remainder held after a partial capture.
        final_capture: input.finalCapture,
        invoice_id: input.invoiceId,
        note_to_payer: input.noteToPayer.slice(0, MAX_NOTE_TO_PAYER),
      },
    });
    const wire = parseWire(WireCaptureSchema, "capture", response);
    return this.toCaptureInfo(wire.amount ? wire : await this.fetchCapture(wire.id), response);
  }

  /** The captured amount is never assumed from the request: if PayPal omitted it, read the capture back. */
  private async fetchCapture(captureId: string): Promise<WireCapture> {
    const response = await this.http.request({
      method: "GET",
      path: resourcePath("/v2/payments/captures", captureId),
      template: "/v2/payments/captures/{id}",
      context: { paypalCaptureId: captureId },
    });
    return parseWire(WireCaptureSchema, "get capture", response);
  }

  private toCaptureInfo(wire: WireCapture, response: PayPalResponse): CaptureInfo {
    const amountMinor = minorOf(wire.amount);
    if (amountMinor === null) throw unexpectedResponse("capture", response);
    return {
      captureId: wire.id,
      status: wire.status,
      amountMinor,
      currency: CURRENCY,
      // PACT always sends final_capture: true, so an answer that omits the flag was a final capture.
      finalCapture: wire.final_capture ?? true,
    };
  }

  async voidAuthorization(authorizationId: string, idempotencyKey: string): Promise<void> {
    // No Prefer header: PayPal answers 204 No Content, which is all a void needs.
    await this.http.request({
      method: "POST",
      path: resourcePath("/v2/payments/authorizations", authorizationId, "/void"),
      template: "/v2/payments/authorizations/{id}/void",
      idempotencyKey,
      context: { paypalAuthorizationId: authorizationId },
    });
  }

  async reauthorize(authorizationId: string, amountMinor: number, idempotencyKey: string): Promise<AuthorizationInfo> {
    const response = await this.http.request({
      method: "POST",
      path: resourcePath("/v2/payments/authorizations", authorizationId, "/reauthorize"),
      template: "/v2/payments/authorizations/{id}/reauthorize",
      idempotencyKey,
      representation: true,
      context: { paypalAuthorizationId: authorizationId },
      body: { amount: { currency_code: CURRENCY, value: toPayPalValue(amountMinor) } },
    });
    const wire = parseWire(WireAuthorizationSchema, "reauthorize", response);
    // Reauthorizing yields a NEW authorization id; read it back if the answer was minimal.
    return wire.amount ? toAuthorizationInfo(wire, "reauthorize", response) : this.getAuthorization(wire.id);
  }

  /* ------------------------------- Vault v3 ------------------------------ */

  async createVaultSetup(input: { returnUrl: string; cancelUrl: string; idempotencyKey: string }): Promise<VaultSetupInfo> {
    const response = await this.http.request({
      method: "POST",
      path: "/v3/vault/setup-tokens",
      template: "/v3/vault/setup-tokens",
      idempotencyKey: input.idempotencyKey,
      body: {
        payment_source: {
          paypal: {
            description: "PACT delegated agent wallet",
            usage_type: "MERCHANT",
            experience_context: {
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
              shipping_preference: "NO_SHIPPING",
            },
          },
        },
      },
    });
    const wire = parseWire(WireSetupTokenSchema, "vault setup", response);
    const approveUrl = wire.links?.find((link) => link.rel === "approve")?.href;
    if (approveUrl === undefined) throw unexpectedResponse("vault setup", response);
    return { setupTokenId: wire.id, approveUrl };
  }

  async exchangeVaultSetup(setupTokenId: string, idempotencyKey: string): Promise<VaultTokenInfo> {
    const response = await this.http.request({
      method: "POST",
      path: "/v3/vault/payment-tokens",
      template: "/v3/vault/payment-tokens",
      idempotencyKey,
      body: { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } },
    });
    const wire = parseWire(WirePaymentTokenSchema, "vault exchange", response);
    return { vaultId: wire.id, payerEmailMasked: maskEmail(wire.payment_source?.paypal?.email_address) };
  }

  /* ------------------------------ Webhooks v1 ----------------------------- */

  /**
   * Nothing in a delivery is trusted before its signature verifies, and that includes what it
   * costs to check: every outbound call below is first cleared with `options.mayCallOut`, a
   * certificate URL that failed is not fetched again for a while, and a signature in an
   * algorithm PayPal does not use is refused outright instead of being sent to PayPal to judge.
   */
  async verifyWebhook(headers: Headers, rawBody: string, options: WebhookVerifyOptions = {}): Promise<WebhookVerification> {
    const webhookId = this.webhookId;
    if (!webhookId) return { verified: false, method: "none", reason: "webhook_id_not_configured" };
    const signature = readSignatureHeaders(headers);
    if (signature === null) return { verified: false, method: "none", reason: "missing_signature_headers" };
    // Checked before anything is fetched: the header is attacker-controlled.
    if (!isTrustedCertUrl(signature.certUrl)) return { verified: false, method: "self", reason: "untrusted_cert_url" };
    const timeProblem = transmissionTimeProblem(signature.transmissionTime, this.now());
    if (timeProblem !== null) return { verified: false, method: "self", reason: timeProblem };
    // PayPal signs with one algorithm. Naming another is not a reason to ask PayPal about it.
    if (signature.authAlgo !== null && signature.authAlgo !== SUPPORTED_AUTH_ALGO) {
      return { verified: false, method: "self", reason: "unsupported_auth_algo" };
    }

    const mayCallOut = options.mayCallOut ?? (async () => true);
    const key = await this.certificates.load(signature.certUrl, mayCallOut);
    if (key !== null) {
      const verified = verifySignature(key, signedMessage(signature, webhookId, rawBody), signature.signature);
      return { verified, method: "self", reason: verified ? null : "signature_mismatch" };
    }
    // The certificate could not be obtained, so the signature was never checked: ask PayPal instead.
    if (!isJsonObject(rawBody)) return { verified: false, method: "postback", reason: "body_not_json" };
    // "Not now" rather than "no": PayPal redelivers, and a genuine event verifies once there is room again.
    if (!(await mayCallOut())) return { verified: false, method: "postback", reason: "verification_budget_spent" };
    return this.verifyByPostback(signature, webhookId, rawBody);
  }

  private async verifyByPostback(
    signature: WebhookSignatureHeaders,
    webhookId: string,
    rawBody: string,
  ): Promise<WebhookVerification> {
    const envelope = JSON.stringify({
      auth_algo: signature.authAlgo ?? SUPPORTED_AUTH_ALGO,
      cert_url: signature.certUrl,
      transmission_id: signature.transmissionId,
      transmission_sig: signature.signature,
      transmission_time: signature.transmissionTime,
      webhook_id: webhookId,
    });
    // webhook_event must be the event as a JSON object, yet PayPal recomputes the checksum over it:
    // splicing the received bytes in (instead of parse + stringify) keeps number formatting,
    // escapes and key order exactly as PayPal sent them.
    const body = `${envelope.slice(0, -1)},"webhook_event":${rawBody}}`;
    try {
      const response = await this.http.request({
        method: "POST",
        path: "/v1/notifications/verify-webhook-signature",
        template: "/v1/notifications/verify-webhook-signature",
        rawBody: body,
      });
      const verified = parseWire(WirePostbackSchema, "verify webhook", response).verification_status === "SUCCESS";
      return { verified, method: "postback", reason: verified ? null : "postback_failure" };
    } catch (error) {
      if (!(error instanceof PaymentError)) throw error;
      // "Could not ask" is not "PayPal said no": the caller should let PayPal redeliver the event.
      return { verified: false, method: "postback", reason: "postback_unavailable" };
    }
  }
}

function isJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** The provider for the configured Sandbox credentials, or null when none are configured. */
export function createPayPalProviderFromEnv(): PayPalSandboxProvider | null {
  const config = getPayPalConfig();
  if (config === null) return null;
  return new PayPalSandboxProvider({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    apiBase: config.apiBase,
    webhookId: config.webhookId,
  });
}
