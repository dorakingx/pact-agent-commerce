/**
 * SimulatedProvider — an in-process stand-in for PayPal, used ONLY when no Sandbox credentials
 * are configured (keyless local development, CI). No money, real or sandbox, is involved, and
 * every id it mints starts with "SIM-" so a simulated payment can never be mistaken for a real one.
 *
 * It mirrors PayPal's observable semantics — statuses, idempotent replays, and the error issues
 * PayPal raises for out-of-order calls — closely enough that the payment orchestrator runs the
 * exact same code path against it.
 */
import { z } from "zod";
import { sha256Hex } from "../domain/canonical";
import { assertNever } from "../domain/format";
import { CURRENCY, isMinor } from "../domain/money";
import { AUTHORIZATION_STATUSES, CAPTURE_STATUSES, ORDER_STATUSES } from "./info-schemas";
import { maskEmail } from "./mask";
import {
  PaymentError,
  type AuthorizationInfo,
  type CaptureInfo,
  type CaptureInput,
  type CreateOrderInput,
  type OrderInfo,
  type PaymentProvider,
  type SimulatedStore,
  type VaultSetupInfo,
  type VaultTokenInfo,
  type WebhookVerification,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
/** PayPal holds an authorization for 29 days. */
const AUTHORIZATION_VALIDITY_MS = 29 * DAY_MS;
/** PayPal refuses to reauthorize inside the 3-day honor period. */
const HONOR_PERIOD_MS = 3 * DAY_MS;
const SIMULATED_PAYER_EMAIL = "sim-buyer@personal.example.com";
const TERMS_HASH = /^[a-f0-9]{64}$/;

/** Where the simulated approval page for an order lives. Relative: the caller knows the origin. */
export function simulatedApprovePath(orderId: string): string {
  return `/pay/simulated/${encodeURIComponent(orderId)}`;
}

/* -------------------------------------------------------------------------- */
/*  Stored documents                                                           */
/* -------------------------------------------------------------------------- */

const OrderDocSchema = z.object({
  type: z.literal("order"),
  id: z.string(),
  dealId: z.string(),
  status: z.enum(ORDER_STATUSES),
  amountMinor: z.number().int().min(1),
  customId: z.string(),
  invoiceId: z.string(),
  description: z.string(),
  returnUrl: z.string(),
  cancelUrl: z.string(),
  /** Created against a vaulted wallet, so the payer was known from the start. */
  delegated: z.boolean(),
  authorizationId: z.string().nullable(),
  /** Idempotency key of the authorize call that completed the order. */
  authorizeKey: z.string().nullable(),
  createdAt: z.string(),
});
type OrderDoc = z.infer<typeof OrderDocSchema>;

const CaptureDocSchema = z.object({
  id: z.string(),
  key: z.string(),
  status: z.enum(CAPTURE_STATUSES),
  amountMinor: z.number().int().min(1),
  finalCapture: z.boolean(),
});

const AuthorizationDocSchema = z.object({
  type: z.literal("authorization"),
  id: z.string(),
  orderId: z.string(),
  status: z.enum(AUTHORIZATION_STATUSES),
  amountMinor: z.number().int().min(1),
  customId: z.string(),
  invoiceId: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  capture: CaptureDocSchema.nullable(),
  /** Idempotency key of the void, so the same key replays and a different one is PREVIOUSLY_VOIDED. */
  voidKey: z.string().nullable(),
});
type AuthorizationDoc = z.infer<typeof AuthorizationDocSchema>;

const VaultSetupDocSchema = z.object({
  type: z.literal("vault_setup"),
  id: z.string(),
  createdAt: z.string(),
});

const VaultDocSchema = z.object({
  type: z.literal("vault"),
  id: z.string(),
  setupTokenId: z.string(),
  createdAt: z.string(),
});

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

type IdKind = "O" | "A" | "C" | "S" | "V";

/**
 * Ids are derived from the idempotency key (or parent id) instead of being random: the same
 * request always names the same resource, which is what makes replays idempotent without a
 * separate key index.
 */
function simulatedId(kind: IdKind, seed: string): string {
  return `SIM-${kind}-${sha256Hex(`${kind}:${seed}`).slice(0, 16).toUpperCase()}`;
}

function refuse(issue: string, message: string, httpStatus: number): PaymentError {
  return new PaymentError({ issue, message, httpStatus, debugId: null, retryable: false });
}

function notFound(what: string): PaymentError {
  return refuse("INVALID_RESOURCE_ID", `The simulated ${what} does not exist.`, 404);
}

/** The issue PayPal raises when an authorization that is no longer open is captured or reauthorized. */
function notCapturable(status: Exclude<AuthorizationDoc["status"], "CREATED">): PaymentError {
  switch (status) {
    case "VOIDED":
      return refuse("AUTHORIZATION_VOIDED", "The authorization has been voided.", 422);
    case "CAPTURED":
    case "PARTIALLY_CAPTURED":
      return refuse("AUTHORIZATION_ALREADY_CAPTURED", "The authorization has already been captured.", 422);
    case "DENIED":
    case "PENDING":
      return refuse("AUTHORIZATION_DENIED", `The authorization is ${status.toLowerCase()} and holds no funds.`, 422);
    default:
      return assertNever(status);
  }
}

/** Process-wide in-memory store. Lives on globalThis so it survives Next.js dev module reloads. */
function defaultStore(): SimulatedStore {
  const scope = globalThis as typeof globalThis & { __pactSimulatedPayments?: Map<string, Record<string, unknown>> };
  scope.__pactSimulatedPayments ??= new Map();
  return createMemorySimulatedStore(scope.__pactSimulatedPayments);
}

/** An isolated in-memory store (tests), optionally backed by an existing map. */
export function createMemorySimulatedStore(documents = new Map<string, Record<string, unknown>>()): SimulatedStore {
  return {
    // Clone on both sides so callers can never mutate stored state by reference, as with a real database.
    async load(id) {
      const document = documents.get(id);
      return document === undefined ? null : structuredClone(document);
    },
    async save(id, document) {
      documents.set(id, structuredClone(document));
    },
  };
}

export interface SimulatedCheckout {
  order: OrderInfo;
  description: string;
  returnUrl: string;
  cancelUrl: string;
}

/* -------------------------------------------------------------------------- */
/*  Provider                                                                   */
/* -------------------------------------------------------------------------- */

export class SimulatedProvider implements PaymentProvider {
  readonly kind = "simulated" as const;
  readonly supportsVault = true;

  private readonly store: SimulatedStore;
  private readonly now: () => Date;

  constructor(store?: SimulatedStore, options: { now?: () => Date } = {}) {
    this.store = store ?? defaultStore();
    this.now = options.now ?? (() => new Date());
  }

  /* -------------------------------- Orders ------------------------------- */

  async createOrder(input: CreateOrderInput): Promise<OrderInfo> {
    if (!TERMS_HASH.test(input.contractHash)) {
      throw new RangeError("contractHash must be the 64-character lowercase hex terms hash");
    }
    if (!isMinor(input.amountMinor) || input.amountMinor === 0) {
      throw refuse("INVALID_PARAMETER_VALUE", "The order amount must be greater than zero.", 400);
    }
    const orderId = simulatedId("O", input.idempotencyKey);
    const existing = await this.findOrder(orderId);
    // Same PayPal-Request-Id: answer with the order as it is now, like PayPal's idempotent replay.
    if (existing !== null) return this.describeOrder(existing);

    const delegated = input.vaultId !== undefined;
    if (input.vaultId !== undefined && (await this.loadDoc(input.vaultId, VaultDocSchema)) === null) {
      throw notFound("vaulted wallet");
    }
    const createdAt = this.now().toISOString();
    const order: OrderDoc = {
      type: "order",
      id: orderId,
      dealId: input.dealId,
      status: "PAYER_ACTION_REQUIRED",
      amountMinor: input.amountMinor,
      customId: `pact:v1:${input.contractHash}`,
      invoiceId: input.contractId,
      description: input.description,
      returnUrl: input.returnUrl,
      cancelUrl: input.cancelUrl,
      delegated,
      authorizationId: null,
      authorizeKey: null,
      createdAt,
    };
    // A vaulted wallet carries the payer's standing consent, so the order is authorized in this one step.
    const stored = delegated ? await this.authorize(order, input.idempotencyKey) : await this.saveOrder(order);
    return this.describeOrder(stored);
  }

  async getOrder(orderId: string): Promise<OrderInfo> {
    return this.describeOrder(await this.requireOrder(orderId));
  }

  async authorizeOrder(orderId: string, idempotencyKey: string): Promise<OrderInfo> {
    const order = await this.requireOrder(orderId);
    switch (order.status) {
      case "APPROVED":
        return this.describeOrder(await this.authorize(order, idempotencyKey));
      case "COMPLETED":
        if (order.authorizeKey === idempotencyKey) return this.describeOrder(order);
        throw refuse("ORDER_ALREADY_AUTHORIZED", "The order has already been authorized.", 422);
      case "VOIDED":
        throw refuse("ORDER_COMPLETED_OR_VOIDED", "The order was cancelled and can no longer be authorized.", 422);
      case "CREATED":
      case "SAVED":
      case "PAYER_ACTION_REQUIRED":
        throw refuse("ORDER_NOT_APPROVED", "The payer has not approved this order yet.", 422);
      default:
        return assertNever(order.status);
    }
  }

  /* ------------------------ Simulator-only operations ------------------------ */

  /** What the simulated approval page calls when the "payer" approves. Safe to call twice. */
  async approve(orderId: string): Promise<OrderInfo> {
    const order = await this.requireOrder(orderId);
    switch (order.status) {
      case "CREATED":
      case "SAVED":
      case "PAYER_ACTION_REQUIRED":
        return this.describeOrder(await this.saveOrder({ ...order, status: "APPROVED" }));
      case "APPROVED":
        return this.describeOrder(order);
      case "COMPLETED":
      case "VOIDED":
        throw refuse("ORDER_COMPLETED_OR_VOIDED", "The order is already completed or cancelled.", 422);
      default:
        return assertNever(order.status);
    }
  }

  /**
   * What the simulated approval page calls when the "payer" backs out. The order becomes VOIDED so
   * it cannot be approved later behind PACT's back. Safe to call twice.
   */
  async cancel(orderId: string): Promise<OrderInfo> {
    const order = await this.requireOrder(orderId);
    switch (order.status) {
      case "CREATED":
      case "SAVED":
      case "PAYER_ACTION_REQUIRED":
      case "APPROVED":
        return this.describeOrder(await this.saveOrder({ ...order, status: "VOIDED" }));
      case "VOIDED":
        return this.describeOrder(order);
      case "COMPLETED":
        throw refuse("ORDER_COMPLETED_OR_VOIDED", "The order is already authorized; void the authorization instead.", 422);
      default:
        return assertNever(order.status);
    }
  }

  /** Everything the simulated approval page needs to render and to send the payer back. */
  async checkout(orderId: string): Promise<SimulatedCheckout> {
    const order = await this.requireOrder(orderId);
    return {
      order: await this.describeOrder(order),
      description: order.description,
      returnUrl: order.returnUrl,
      cancelUrl: order.cancelUrl,
    };
  }

  /* ------------------------------- Payments ------------------------------ */

  async getAuthorization(authorizationId: string): Promise<AuthorizationInfo> {
    return toAuthorizationInfo(await this.requireAuthorization(authorizationId));
  }

  async captureAuthorization(input: CaptureInput): Promise<CaptureInfo> {
    const authorization = await this.requireAuthorization(input.authorizationId);
    const previous = authorization.capture;
    if (previous !== null) {
      // Same PayPal-Request-Id replays the original capture; any other request is a second capture.
      if (previous.key === input.idempotencyKey) return toCaptureInfo(previous);
      throw refuse("AUTHORIZATION_ALREADY_CAPTURED", "The authorization has already been captured.", 422);
    }
    if (authorization.status !== "CREATED") throw notCapturable(authorization.status);
    if (this.now().getTime() >= Date.parse(authorization.expiresAt)) {
      throw refuse("AUTHORIZATION_EXPIRED", "The authorization has expired.", 422);
    }
    if (!isMinor(input.amountMinor) || input.amountMinor === 0) {
      throw refuse("INVALID_PARAMETER_VALUE", "The capture amount must be greater than zero.", 400);
    }
    if (input.amountMinor > authorization.amountMinor) {
      throw refuse("MAX_CAPTURE_AMOUNT_EXCEEDED", "The capture amount exceeds the authorized amount.", 422);
    }
    const capture = {
      id: simulatedId("C", input.idempotencyKey),
      key: input.idempotencyKey,
      status: "COMPLETED" as const,
      amountMinor: input.amountMinor,
      finalCapture: input.finalCapture,
    };
    await this.saveAuthorization({
      ...authorization,
      // PayPal's definition: CAPTURED once captures cover the authorized amount, otherwise PARTIALLY_CAPTURED.
      status: input.amountMinor === authorization.amountMinor ? "CAPTURED" : "PARTIALLY_CAPTURED",
      capture,
    });
    return toCaptureInfo(capture);
  }

  async voidAuthorization(authorizationId: string, idempotencyKey: string): Promise<void> {
    const authorization = await this.requireAuthorization(authorizationId);
    if (authorization.capture !== null) {
      throw refuse("PREVIOUSLY_CAPTURED", "A captured authorization cannot be voided.", 422);
    }
    if (authorization.status === "VOIDED") {
      if (authorization.voidKey === idempotencyKey) return;
      throw refuse("PREVIOUSLY_VOIDED", "The authorization has already been voided.", 422);
    }
    await this.saveAuthorization({ ...authorization, status: "VOIDED", voidKey: idempotencyKey });
  }

  async reauthorize(authorizationId: string, amountMinor: number, idempotencyKey: string): Promise<AuthorizationInfo> {
    const renewedId = simulatedId("A", idempotencyKey);
    const renewed = await this.loadDoc(renewedId, AuthorizationDocSchema);
    if (renewed !== null) return toAuthorizationInfo(renewed);

    const authorization = await this.requireAuthorization(authorizationId);
    if (authorization.status !== "CREATED") throw notCapturable(authorization.status);
    const now = this.now();
    if (now.getTime() - Date.parse(authorization.createdAt) < HONOR_PERIOD_MS) {
      throw refuse("REAUTHORIZATION_TOO_SOON", "The authorization is still inside its honor period.", 422);
    }
    if (!isMinor(amountMinor) || amountMinor === 0 || amountMinor > authorization.amountMinor) {
      throw refuse("INVALID_PARAMETER_VALUE", "The reauthorization amount must be between 0.01 and the authorized amount.", 400);
    }
    // PayPal issues a new authorization id; the old hold is retired so funds are never held twice.
    const replacement: AuthorizationDoc = {
      ...authorization,
      id: renewedId,
      amountMinor,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + AUTHORIZATION_VALIDITY_MS).toISOString(),
    };
    await this.saveAuthorization(replacement);
    await this.saveAuthorization({ ...authorization, status: "VOIDED", voidKey: idempotencyKey });
    const order = await this.findOrder(authorization.orderId);
    if (order !== null) await this.saveOrder({ ...order, authorizationId: renewedId });
    return toAuthorizationInfo(replacement);
  }

  /* --------------------------------- Vault -------------------------------- */

  /**
   * There is no simulated consent screen: the "approval" link goes straight back to the caller's
   * return URL, with the setup token appended the way PayPal does (approval_token_id).
   */
  async createVaultSetup(input: { returnUrl: string; cancelUrl: string; idempotencyKey: string }): Promise<VaultSetupInfo> {
    const setupTokenId = simulatedId("S", input.idempotencyKey);
    await this.store.save(setupTokenId, {
      type: "vault_setup",
      id: setupTokenId,
      createdAt: this.now().toISOString(),
    } satisfies z.infer<typeof VaultSetupDocSchema>);
    const approveUrl = new URL(input.returnUrl);
    approveUrl.searchParams.set("approval_token_id", setupTokenId);
    return { setupTokenId, approveUrl: approveUrl.toString() };
  }

  /**
   * The vault id is derived from the setup token, so a replay names the same wallet whatever key
   * it carries. (Declared with the contract's type so callers still pass the idempotency key.)
   */
  readonly exchangeVaultSetup: PaymentProvider["exchangeVaultSetup"] = async (setupTokenId): Promise<VaultTokenInfo> => {
    if ((await this.loadDoc(setupTokenId, VaultSetupDocSchema)) === null) throw notFound("vault setup token");
    const vaultId = simulatedId("V", setupTokenId);
    await this.store.save(vaultId, {
      type: "vault",
      id: vaultId,
      setupTokenId,
      createdAt: this.now().toISOString(),
    } satisfies z.infer<typeof VaultDocSchema>);
    return { vaultId, payerEmailMasked: maskEmail(SIMULATED_PAYER_EMAIL) };
  };

  /* -------------------------------- Webhooks ------------------------------- */

  /** The simulator never sends webhooks, so nothing that claims to be one can be genuine. */
  readonly verifyWebhook: PaymentProvider["verifyWebhook"] = async (): Promise<WebhookVerification> => ({
    verified: false,
    method: "simulated",
    reason: "simulated_provider",
  });

  /* -------------------------------- Internals ------------------------------ */

  private async authorize(order: OrderDoc, idempotencyKey: string): Promise<OrderDoc> {
    const now = this.now();
    const authorization: AuthorizationDoc = {
      type: "authorization",
      id: simulatedId("A", order.id),
      orderId: order.id,
      status: "CREATED",
      amountMinor: order.amountMinor,
      customId: order.customId,
      invoiceId: order.invoiceId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + AUTHORIZATION_VALIDITY_MS).toISOString(),
      capture: null,
      voidKey: null,
    };
    await this.saveAuthorization(authorization);
    return this.saveOrder({ ...order, status: "COMPLETED", authorizationId: authorization.id, authorizeKey: idempotencyKey });
  }

  private async describeOrder(order: OrderDoc): Promise<OrderInfo> {
    const authorization =
      order.authorizationId === null ? null : await this.loadDoc(order.authorizationId, AuthorizationDocSchema);
    const awaitingPayer = order.status === "PAYER_ACTION_REQUIRED" || order.status === "CREATED";
    // The payer is only known once they approved (or up front, for a vaulted wallet).
    const payerKnown = order.delegated || order.status === "APPROVED" || order.status === "COMPLETED";
    return {
      orderId: order.id,
      status: order.status,
      amountMinor: order.amountMinor,
      currency: CURRENCY,
      customId: order.customId,
      invoiceId: order.invoiceId,
      approveUrl: awaitingPayer ? simulatedApprovePath(order.id) : null,
      authorization: authorization === null ? null : toAuthorizationInfo(authorization),
      payerEmailMasked: payerKnown ? maskEmail(SIMULATED_PAYER_EMAIL) : null,
      vaultId: null,
    };
  }

  private async loadDoc<T>(id: string, schema: z.ZodType<T>): Promise<T | null> {
    const document = await this.store.load(id);
    if (document === null) return null;
    const parsed = schema.safeParse(document);
    // An id of the wrong kind (e.g. an order id where an authorization id is expected) is simply unknown.
    return parsed.success ? parsed.data : null;
  }

  private findOrder(orderId: string): Promise<OrderDoc | null> {
    return this.loadDoc(orderId, OrderDocSchema);
  }

  private async requireOrder(orderId: string): Promise<OrderDoc> {
    const order = await this.findOrder(orderId);
    if (order === null) throw notFound("order");
    return order;
  }

  private async requireAuthorization(authorizationId: string): Promise<AuthorizationDoc> {
    const authorization = await this.loadDoc(authorizationId, AuthorizationDocSchema);
    if (authorization === null) throw notFound("authorization");
    return authorization;
  }

  private async saveOrder(order: OrderDoc): Promise<OrderDoc> {
    await this.store.save(order.id, order);
    return order;
  }

  private async saveAuthorization(authorization: AuthorizationDoc): Promise<void> {
    await this.store.save(authorization.id, authorization);
  }
}

function toAuthorizationInfo(authorization: AuthorizationDoc): AuthorizationInfo {
  return {
    authorizationId: authorization.id,
    status: authorization.status,
    amountMinor: authorization.amountMinor,
    currency: CURRENCY,
    expiresAt: authorization.expiresAt,
    customId: authorization.customId,
    invoiceId: authorization.invoiceId,
  };
}

function toCaptureInfo(capture: z.infer<typeof CaptureDocSchema>): CaptureInfo {
  return {
    captureId: capture.id,
    status: capture.status,
    amountMinor: capture.amountMinor,
    currency: CURRENCY,
    finalCapture: capture.finalCapture,
  };
}
