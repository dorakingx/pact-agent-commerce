/**
 * PayPalSandboxProvider against a scripted, in-memory PayPal.
 *
 * The fake below answers with the status codes and bodies PayPal documents (Orders v2,
 * Payments v2, Vault v3, OAuth), so these tests pin the exact requests PACT sends — URL, method,
 * headers, body — and how every kind of answer is mapped, without any network access.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/lib/domain/canonical";
import { getPaymentProvider } from "@/lib/payments";
import { PayPalSandboxProvider, createPayPalProviderFromEnv } from "@/lib/payments/paypal-client";
import { SimulatedProvider } from "@/lib/payments/simulated";
import { PaymentError, type CreateOrderInput } from "@/lib/payments/types";

const API = "https://api-m.sandbox.paypal.com";
const CLIENT_ID = "sandbox-client-id";
const CLIENT_SECRET = "sandbox-client-secret-value";
const VAULT_ID = "8kk8451t-vault-token";
const PAYER_EMAIL = "sb-buyer4711@personal.example.com";
const CONTRACT_HASH = sha256Hex("paypal-client-test-contract");
const EXPIRATION = "2026-11-04T12:00:00Z";

/* -------------------------------------------------------------------------- */
/*  Scripted PayPal                                                            */
/* -------------------------------------------------------------------------- */

interface Recorded {
  method: string;
  path: string;
  headers: Headers;
  /** Raw request body exactly as sent, or null. */
  text: string | null;
  json: unknown;
}

interface FakeOrder {
  id: string;
  status: string;
  unit: Record<string, unknown>;
  vaulted: boolean;
  authorizationId: string | null;
}

interface FakeAuthorization {
  id: string;
  orderId: string;
  status: string;
  amount: { currency_code: string; value: string };
  custom_id: string;
  invoice_id: string;
  captureId: string | null;
}

interface Interceptor {
  matches: (request: Recorded) => boolean;
  respond: (request: Recorded) => Response | Promise<Response>;
}

function json(status: number, body: unknown, debugId = "f6c1a2b3d4e5f"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "paypal-debug-id": debugId },
  });
}

function paypalError(status: number, name: string, issue: string, description: string, debugId = "b14b9a1c2a3d4"): Response {
  return json(
    status,
    {
      name,
      details: [{ issue, description }],
      message: "The requested action could not be performed, semantically incorrect, or failed business validation.",
      debug_id: debugId,
      links: [{ href: `https://developer.paypal.com/api/rest/reference/orders/v2/errors/#${issue}`, rel: "information_link", method: "GET" }],
    },
    debugId,
  );
}

class FakePayPal {
  readonly requests: Recorded[] = [];
  private readonly orders = new Map<string, FakeOrder>();
  private readonly authorizations = new Map<string, FakeAuthorization>();
  private readonly byRequestId = new Map<string, string>();
  private readonly interceptors: Interceptor[] = [];
  private readonly validTokens = new Set<string>();
  private sequence = 0;
  /** Lifetime announced for new tokens, in seconds. */
  tokenLifetimeS = 32_400;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const text = typeof init?.body === "string" ? init.body : null;
    let parsed: unknown = null;
    if (text !== null) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    const request: Recorded = {
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      headers: new Headers(init?.headers),
      text,
      json: parsed,
    };
    expect(url.origin).toBe(API);
    this.requests.push(request);

    if (request.path === "/v1/oauth2/token") return this.token(request);
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!this.validTokens.has(bearer)) {
      return json(401, { error: "invalid_token", error_description: "Access Token not found in cache" });
    }
    const scripted = this.interceptors.findIndex((interceptor) => interceptor.matches(request));
    if (scripted === -1) return this.route(request);
    // Removed before it answers: an interceptor fires once, even if it throws or calls back into the fake.
    const [interceptor] = this.interceptors.splice(scripted, 1);
    return interceptor.respond(request);
  };

  /** Answer the next request that matches with `respond` instead of the normal behaviour (once). */
  intercept(method: string, pathPrefix: string, respond: (request: Recorded) => Response | Promise<Response>): void {
    this.interceptors.push({ matches: (request) => request.method === method && request.path.startsWith(pathPrefix), respond });
  }

  revokeTokens(): void {
    this.validTokens.clear();
  }

  /** What the payer does in the PayPal window. */
  approve(orderId: string): void {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`unknown order ${orderId}`);
    order.status = "APPROVED";
  }

  calls(method: string, pathPrefix: string): Recorded[] {
    return this.requests.filter((request) => request.method === method && request.path.startsWith(pathPrefix));
  }

  get tokenCalls(): Recorded[] {
    return this.calls("POST", "/v1/oauth2/token");
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}${String(this.sequence).padStart(4, "0")}`;
  }

  private token(request: Recorded): Response {
    const expected = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
    if (request.headers.get("authorization") !== expected) {
      return json(401, { error: "invalid_client", error_description: "Client Authentication failed" });
    }
    const accessToken = this.nextId("A21AAFEpH4PsADK7qSS7pSRsgz-token-");
    this.validTokens.add(accessToken);
    return json(200, {
      scope: "https://uri.paypal.com/services/payments/payment/authcapture openid",
      access_token: accessToken,
      token_type: "Bearer",
      app_id: "APP-80W284485P519543T",
      expires_in: this.tokenLifetimeS,
      nonce: "2026-10-06T12:00:00Z0-nonce",
    });
  }

  private route(request: Recorded): Response {
    const { method, path } = request;
    const order = /^\/v2\/checkout\/orders\/([^/]+)(\/authorize)?$/.exec(path);
    const authorization = /^\/v2\/payments\/authorizations\/([^/]+)(\/capture|\/void|\/reauthorize)?$/.exec(path);
    const capture = /^\/v2\/payments\/captures\/([^/]+)$/.exec(path);

    if (method === "POST" && path === "/v2/checkout/orders") return this.createOrder(request);
    if (method === "GET" && order && !order[2]) return this.getOrder(order[1]);
    if (method === "POST" && order?.[2] === "/authorize") return this.authorizeOrder(order[1], request);
    if (method === "GET" && authorization && !authorization[2]) return this.getAuthorization(authorization[1]);
    if (method === "POST" && authorization?.[2] === "/capture") return this.captureAuthorization(authorization[1], request);
    if (method === "POST" && authorization?.[2] === "/void") return this.voidAuthorization(authorization[1]);
    if (method === "POST" && authorization?.[2] === "/reauthorize") return this.reauthorize(authorization[1], request);
    if (method === "GET" && capture) return this.getCapture(capture[1]);
    if (method === "POST" && path === "/v3/vault/setup-tokens") return this.createSetupToken();
    if (method === "POST" && path === "/v3/vault/payment-tokens") return this.createPaymentToken(request);
    return this.notFound();
  }

  private notFound(): Response {
    return paypalError(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist. Please check the resource ID and try again.");
  }

  private createOrder(request: Recorded): Response {
    const requestId = request.headers.get("paypal-request-id") ?? "";
    const replayed = this.byRequestId.get(requestId);
    if (replayed !== undefined) return json(200, this.orderBody(replayed, request));

    const body = request.json as {
      purchase_units: Record<string, unknown>[];
      payment_source: { paypal: { vault_id?: string } };
    };
    const id = this.nextId("5O190127TN36");
    const vaulted = body.payment_source.paypal.vault_id !== undefined;
    const order: FakeOrder = { id, status: vaulted ? "COMPLETED" : "PAYER_ACTION_REQUIRED", unit: body.purchase_units[0], vaulted, authorizationId: null };
    this.orders.set(id, order);
    this.byRequestId.set(requestId, id);
    if (vaulted) this.authorize(order);
    return json(201, this.orderBody(id, request));
  }

  private authorize(order: FakeOrder): FakeAuthorization {
    const unit = order.unit as { amount: { currency_code: string; value: string }; custom_id: string; invoice_id: string };
    const authorization: FakeAuthorization = {
      id: this.nextId("0AW2184448108"),
      orderId: order.id,
      status: "CREATED",
      amount: unit.amount,
      custom_id: unit.custom_id,
      invoice_id: unit.invoice_id,
      captureId: null,
    };
    this.authorizations.set(authorization.id, authorization);
    order.status = "COMPLETED";
    order.authorizationId = authorization.id;
    return authorization;
  }

  private authorizationBody(authorization: FakeAuthorization): Record<string, unknown> {
    return {
      id: authorization.id,
      status: authorization.status,
      amount: authorization.amount,
      invoice_id: authorization.invoice_id,
      custom_id: authorization.custom_id,
      seller_protection: { status: "ELIGIBLE", dispute_categories: ["ITEM_NOT_RECEIVED", "UNAUTHORIZED_TRANSACTION"] },
      expiration_time: EXPIRATION,
      create_time: "2026-10-06T12:00:00Z",
      update_time: "2026-10-06T12:00:00Z",
      links: [
        { href: `${API}/v2/payments/authorizations/${authorization.id}`, rel: "self", method: "GET" },
        { href: `${API}/v2/payments/authorizations/${authorization.id}/capture`, rel: "capture", method: "POST" },
        { href: `${API}/v2/payments/authorizations/${authorization.id}/void`, rel: "void", method: "POST" },
      ],
    };
  }

  /** Minimal by default; the full representation only when the request asked for it, like PayPal. */
  private orderBody(orderId: string, request: Recorded | null): Record<string, unknown> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`unknown order ${orderId}`);
    const self = { href: `${API}/v2/checkout/orders/${order.id}`, rel: "self", method: "GET" };
    const links =
      order.status === "PAYER_ACTION_REQUIRED"
        ? [self, { href: `https://www.sandbox.paypal.com/checkoutnow?token=${order.id}`, rel: "payer-action", method: "GET" }]
        : [self];
    if (request !== null && request.headers.get("prefer") !== "return=representation") {
      return { id: order.id, status: order.status, links };
    }
    const authorization = order.authorizationId === null ? undefined : this.authorizations.get(order.authorizationId);
    const payerKnown = order.status === "APPROVED" || order.status === "COMPLETED";
    return {
      id: order.id,
      intent: "AUTHORIZE",
      status: order.status,
      payment_source: { paypal: payerKnown ? { email_address: PAYER_EMAIL, account_id: "QYR5Z8XDVJNXQ", account_status: "VERIFIED" } : {} },
      purchase_units: [
        {
          ...order.unit,
          ...(authorization ? { payments: { authorizations: [this.authorizationBody(authorization)] } } : {}),
        },
      ],
      ...(payerKnown ? { payer: { email_address: PAYER_EMAIL, payer_id: "QYR5Z8XDVJNXQ" } } : {}),
      create_time: "2026-10-06T12:00:00Z",
      links,
    };
  }

  private getOrder(orderId: string): Response {
    return this.orders.has(orderId) ? json(200, this.orderBody(orderId, null)) : this.notFound();
  }

  private authorizeOrder(orderId: string, request: Recorded): Response {
    const order = this.orders.get(orderId);
    if (!order) return this.notFound();
    if (order.status === "COMPLETED") return json(200, this.orderBody(orderId, request));
    if (order.status !== "APPROVED") {
      return paypalError(
        422,
        "UNPROCESSABLE_ENTITY",
        "ORDER_NOT_APPROVED",
        "Payer has not yet approved the Order for payment. Please redirect the payer to the 'rel':'approve' url returned as part of the HATEOAS links within the Create Order call or provide a valid payment_source in the request.",
      );
    }
    this.authorize(order);
    return json(201, this.orderBody(orderId, request));
  }

  private getAuthorization(authorizationId: string): Response {
    const authorization = this.authorizations.get(authorizationId);
    return authorization ? json(200, this.authorizationBody(authorization)) : this.notFound();
  }

  private captureBody(authorization: FakeAuthorization, amount: unknown, full: boolean): Record<string, unknown> {
    const id = authorization.captureId ?? "";
    const links = [{ href: `${API}/v2/payments/captures/${id}`, rel: "self", method: "GET" }];
    if (!full) return { id, status: "COMPLETED", links };
    return {
      id,
      status: "COMPLETED",
      amount,
      final_capture: true,
      invoice_id: authorization.invoice_id,
      custom_id: authorization.custom_id,
      seller_protection: { status: "ELIGIBLE" },
      links,
    };
  }

  private captures = new Map<string, Record<string, unknown>>();

  private captureAuthorization(authorizationId: string, request: Recorded): Response {
    const authorization = this.authorizations.get(authorizationId);
    if (!authorization) return this.notFound();
    const full = request.headers.get("prefer") === "return=representation";
    if (authorization.status === "VOIDED") {
      return paypalError(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_VOIDED", "A voided authorization cannot be captured or reauthorized.");
    }
    if (authorization.captureId !== null) {
      return paypalError(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_ALREADY_CAPTURED", "Authorization has already been captured.");
    }
    const body = request.json as { amount: { currency_code: string; value: string } };
    authorization.captureId = this.nextId("2GG279541U47");
    authorization.status = "CAPTURED";
    this.captures.set(authorization.captureId, this.captureBody(authorization, body.amount, true));
    return json(201, this.captureBody(authorization, body.amount, full));
  }

  private getCapture(captureId: string): Response {
    const capture = this.captures.get(captureId);
    return capture ? json(200, capture) : this.notFound();
  }

  private voidAuthorization(authorizationId: string): Response {
    const authorization = this.authorizations.get(authorizationId);
    if (!authorization) return this.notFound();
    if (authorization.captureId !== null) {
      return paypalError(422, "UNPROCESSABLE_ENTITY", "PREVIOUSLY_CAPTURED", "Authorization has been previously captured and hence cannot be voided.");
    }
    authorization.status = "VOIDED";
    return new Response(null, { status: 204, headers: { "paypal-debug-id": "0a1b2c3d4e5f6" } });
  }

  private reauthorize(authorizationId: string, request: Recorded): Response {
    const authorization = this.authorizations.get(authorizationId);
    if (!authorization) return this.notFound();
    const body = request.json as { amount: { currency_code: string; value: string } };
    const renewed: FakeAuthorization = { ...authorization, id: this.nextId("8AA831015G517"), amount: body.amount };
    this.authorizations.set(renewed.id, renewed);
    return json(201, this.authorizationBody(renewed));
  }

  private createSetupToken(): Response {
    const id = this.nextId("5C991763VB2781612");
    return json(201, {
      id,
      customer: { id: "customer_4029352050" },
      status: "PAYER_ACTION_REQUIRED",
      payment_source: { paypal: { description: "PACT delegated agent wallet", usage_type: "MERCHANT" } },
      links: [
        { href: `${API}/v3/vault/setup-tokens/${id}`, rel: "self", method: "GET" },
        { href: `https://www.sandbox.paypal.com/agreements/approve?approval_session_id=${id}`, rel: "approve", method: "GET" },
      ],
    });
  }

  private createPaymentToken(request: Recorded): Response {
    const body = request.json as { payment_source: { token: { id: string; type: string } } };
    if (body.payment_source.token.type !== "SETUP_TOKEN") return this.notFound();
    return json(201, {
      id: VAULT_ID,
      customer: { id: "customer_4029352050" },
      payment_source: { paypal: { description: "PACT delegated agent wallet", usage_type: "MERCHANT", email_address: PAYER_EMAIL, payer_id: "QYR5Z8XDVJNXQ" } },
      links: [{ href: `${API}/v3/vault/payment-tokens/${VAULT_ID}`, rel: "self", method: "GET" }],
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Harness                                                                    */
/* -------------------------------------------------------------------------- */

let paypal: FakePayPal;
let nowMs: number;
let sleeps: number[];
let provider: PayPalSandboxProvider;

function newProvider(overrides: { timeoutMs?: number; apiBase?: string } = {}): PayPalSandboxProvider {
  return new PayPalSandboxProvider({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    apiBase: API,
    fetchImpl: paypal.fetch,
    now: () => nowMs,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  });
}

function orderInput(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    dealId: "deal_client01",
    contractId: "ctr_client000001",
    contractHash: CONTRACT_HASH,
    amountMinor: 4550,
    currency: "USD",
    description: "PACT ctr_client000001 · 3 illustrations · Northwind Studio",
    returnUrl: "https://pact.example/api/deals/deal_client01/paypal/return",
    cancelUrl: "https://pact.example/api/deals/deal_client01/paypal/cancel",
    idempotencyKey: "11111111-2222-8333-9444-555555555555",
    ...overrides,
  };
}

async function failure(action: Promise<unknown>): Promise<PaymentError> {
  const error: unknown = await action.then(
    () => new Error("expected the call to fail"),
    (reason: unknown) => reason,
  );
  if (!(error instanceof PaymentError)) throw error;
  return error;
}

async function authorizedOrder(): Promise<{ orderId: string; authorizationId: string }> {
  const order = await provider.createOrder(orderInput());
  paypal.approve(order.orderId);
  const authorized = await provider.authorizeOrder(order.orderId, "authorize-key-0001");
  return { orderId: order.orderId, authorizationId: authorized.authorization?.authorizationId ?? "" };
}

const serverError = () => json(503, { name: "SERVICE_UNAVAILABLE", message: "Service Unavailable.", debug_id: "5e7f9a1b3c5d7" }, "5e7f9a1b3c5d7");

beforeEach(() => {
  paypal = new FakePayPal();
  nowMs = Date.parse("2026-10-06T12:00:00.000Z");
  sleeps = [];
  provider = newProvider();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*  Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("PayPalSandboxProvider — construction", () => {
  it("identifies itself as the PayPal Sandbox provider with vault support", () => {
    expect(provider.kind).toBe("paypal_sandbox");
    expect(provider.supportsVault).toBe(true);
  });

  it.each([
    "https://api-m.paypal.com",
    "https://api.paypal.com",
    "https://api-m.sandbox.paypal.com.evil.example",
    "https://evil.example",
    "http://api-m.sandbox.paypal.com",
    "https://user:pass@api-m.sandbox.paypal.com",
    "https://localhost",
    "ftp://127.0.0.1",
    "not a url",
  ])("refuses to be constructed for %s", (apiBase) => {
    expect(() => newProvider({ apiBase })).toThrow(/PayPal Sandbox/);
  });

  it.each(["https://api-m.sandbox.paypal.com", "https://api.sandbox.paypal.com", "http://127.0.0.1:8787", "http://localhost:8787"])(
    "accepts %s",
    (apiBase) => {
      expect(() => newProvider({ apiBase })).not.toThrow();
    },
  );

  it("requires credentials", () => {
    expect(() => new PayPalSandboxProvider({ clientId: "", clientSecret: "x", apiBase: API })).toThrow(/client id and secret/);
  });
});

describe("PayPalSandboxProvider — OAuth token", () => {
  it("requests a client-credentials token with Basic auth and a form body, and only there", async () => {
    await provider.createOrder(orderInput());
    expect(paypal.tokenCalls).toHaveLength(1);
    const [tokenCall] = paypal.tokenCalls;
    expect(tokenCall.method).toBe("POST");
    expect(tokenCall.headers.get("authorization")).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    expect(tokenCall.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(tokenCall.text).toBe("grant_type=client_credentials");

    const apiCalls = paypal.requests.filter((request) => request.path !== "/v1/oauth2/token");
    expect(apiCalls.length).toBeGreaterThan(0);
    for (const call of apiCalls) expect(call.headers.get("authorization")).toMatch(/^Bearer A21AA/);
  });

  it("caches the token across calls and refreshes it 60 seconds before it expires", async () => {
    paypal.tokenLifetimeS = 600;
    const order = await provider.createOrder(orderInput());
    await provider.getOrder(order.orderId);
    await provider.getOrder(order.orderId);
    expect(paypal.tokenCalls).toHaveLength(1);

    nowMs += (600 - 61) * 1000;
    await provider.getOrder(order.orderId);
    expect(paypal.tokenCalls).toHaveLength(1);

    nowMs += 1000;
    await provider.getOrder(order.orderId);
    expect(paypal.tokenCalls).toHaveLength(2);
  });

  it("shares one token request between concurrent calls", async () => {
    const order = await newProvider().createOrder(orderInput());
    const fresh = newProvider();
    const before = paypal.tokenCalls.length;
    await Promise.all([fresh.getOrder(order.orderId), fresh.getOrder(order.orderId), fresh.getOrder(order.orderId)]);
    expect(paypal.tokenCalls.length - before).toBe(1);
  });

  it("drops a rejected token, fetches a new one and resends the call once", async () => {
    const order = await provider.createOrder(orderInput());
    paypal.revokeTokens();
    await expect(provider.getOrder(order.orderId)).resolves.toMatchObject({ orderId: order.orderId });
    expect(paypal.tokenCalls).toHaveLength(2);
    const gets = paypal.calls("GET", `/v2/checkout/orders/${order.orderId}`);
    expect(gets).toHaveLength(2);
    expect(gets[0].headers.get("authorization")).not.toBe(gets[1].headers.get("authorization"));
    expect(sleeps).toEqual([]);
  });

  it("gives up after one token refresh when PayPal keeps answering 401", async () => {
    const order = await provider.createOrder(orderInput());
    const unauthorized = () => json(401, { name: "AUTHENTICATION_FAILURE", message: "Authentication failed due to invalid authentication credentials or a missing Authorization header." });
    paypal.intercept("GET", "/v2/checkout/orders/", unauthorized);
    paypal.intercept("GET", "/v2/checkout/orders/", unauthorized);
    const error = await failure(provider.getOrder(order.orderId));
    expect(error).toMatchObject({ issue: "AUTHENTICATION_FAILURE", httpStatus: 401, retryable: false });
    expect(paypal.calls("GET", "/v2/checkout/orders/")).toHaveLength(2);
  });

  it("reports wrong credentials as a non-retryable error in OAuth's own vocabulary", async () => {
    const wrong = new PayPalSandboxProvider({ clientId: CLIENT_ID, clientSecret: "wrong", apiBase: API, fetchImpl: paypal.fetch, sleep: async () => {} });
    const error = await failure(wrong.getOrder("5O190127TN360001"));
    expect(error).toMatchObject({ issue: "invalid_client", message: "Client Authentication failed", httpStatus: 401, retryable: false });
    expect(paypal.tokenCalls).toHaveLength(1);
  });
});

describe("PayPalSandboxProvider — orders", () => {
  it("creates an AUTHORIZE order with exactly one purchase unit bound to the contract", async () => {
    const order = await provider.createOrder(orderInput());

    const [request] = paypal.calls("POST", "/v2/checkout/orders");
    expect(request.path).toBe("/v2/checkout/orders");
    expect(request.headers.get("paypal-request-id")).toBe("11111111-2222-8333-9444-555555555555");
    expect(request.headers.get("prefer")).toBe("return=representation");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("accept")).toBe("application/json");
    expect(request.json).toEqual({
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: "deal_client01",
          description: "PACT ctr_client000001 · 3 illustrations · Northwind Studio",
          custom_id: `pact:v1:${CONTRACT_HASH}`,
          invoice_id: "ctr_client000001",
          amount: { currency_code: "USD", value: "45.50" },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: "https://pact.example/api/deals/deal_client01/paypal/return",
            cancel_url: "https://pact.example/api/deals/deal_client01/paypal/cancel",
            user_action: "PAY_NOW",
            brand_name: "PACT",
            shipping_preference: "NO_SHIPPING",
            landing_page: "LOGIN",
          },
        },
      },
    });

    expect(order).toEqual({
      orderId: order.orderId,
      status: "PAYER_ACTION_REQUIRED",
      amountMinor: 4550,
      currency: "USD",
      customId: `pact:v1:${CONTRACT_HASH}`,
      invoiceId: "ctr_client000001",
      approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${order.orderId}`,
      authorization: null,
      payerEmailMasked: null,
      vaultId: null,
    });
  });

  it.each([
    [100, "1.00"],
    [5, "0.05"],
    [123_456, "1234.56"],
    [9000, "90.00"],
  ])("sends %i minor units as the decimal string %s", async (amountMinor, value) => {
    const order = await provider.createOrder(orderInput({ amountMinor }));
    const [request] = paypal.calls("POST", "/v2/checkout/orders");
    expect(request.json).toMatchObject({ purchase_units: [{ amount: { currency_code: "USD", value } }] });
    expect(order.amountMinor).toBe(amountMinor);
  });

  it("returns the same order when the create is replayed with the same key", async () => {
    const first = await provider.createOrder(orderInput());
    const replay = await provider.createOrder(orderInput());
    expect(replay.orderId).toBe(first.orderId);
    const other = await provider.createOrder(orderInput({ idempotencyKey: "99999999-2222-8333-9444-555555555555" }));
    expect(other.orderId).not.toBe(first.orderId);
  });

  it("uses the 'approve' link when PayPal does not return 'payer-action'", async () => {
    paypal.intercept("POST", "/v2/checkout/orders", () =>
      json(201, {
        id: "5O190127TN364715T",
        status: "CREATED",
        purchase_units: [{ amount: { currency_code: "USD", value: "45.50" }, custom_id: `pact:v1:${CONTRACT_HASH}`, invoice_id: "ctr_client000001" }],
        links: [
          { href: `${API}/v2/checkout/orders/5O190127TN364715T`, rel: "self", method: "GET" },
          { href: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T", rel: "approve", method: "GET" },
        ],
      }),
    );
    await expect(provider.createOrder(orderInput())).resolves.toMatchObject({
      status: "CREATED",
      approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T",
    });
  });

  it("reads the order back when PayPal answers the create in its minimal form", async () => {
    const real = await provider.createOrder(orderInput({ idempotencyKey: "seed-key" }));
    paypal.intercept("POST", "/v2/checkout/orders", () => json(200, { id: real.orderId, status: "PAYER_ACTION_REQUIRED", links: [] }));
    const order = await provider.createOrder(orderInput());
    expect(order).toMatchObject({ orderId: real.orderId, amountMinor: 4550, customId: `pact:v1:${CONTRACT_HASH}` });
    expect(paypal.calls("GET", `/v2/checkout/orders/${real.orderId}`)).toHaveLength(1);
  });

  it("cuts the description to PayPal's 127-character limit and rejects a malformed terms hash", async () => {
    await provider.createOrder(orderInput({ description: "x".repeat(300) }));
    const [request] = paypal.calls("POST", "/v2/checkout/orders");
    expect((request.json as { purchase_units: { description: string }[] }).purchase_units[0].description).toHaveLength(127);

    await expect(provider.createOrder(orderInput({ contractHash: "not-a-hash" }))).rejects.toThrow(RangeError);
  });

  it("creates and authorizes in a single step against a vaulted wallet", async () => {
    const order = await provider.createOrder(orderInput({ vaultId: VAULT_ID }));

    const [request] = paypal.calls("POST", "/v2/checkout/orders");
    expect(request.headers.get("paypal-request-id")).toBe("11111111-2222-8333-9444-555555555555");
    expect(request.json).toMatchObject({ intent: "AUTHORIZE", payment_source: { paypal: { vault_id: VAULT_ID } } });
    expect((request.json as { payment_source: { paypal: object } }).payment_source.paypal).toEqual({ vault_id: VAULT_ID });
    expect((request.json as { purchase_units: unknown[] }).purchase_units).toHaveLength(1);

    expect(order).toMatchObject({
      status: "COMPLETED",
      approveUrl: null,
      payerEmailMasked: "sb****@personal.example.com",
      authorization: {
        authorizationId: expect.stringMatching(/^0AW2184448108/) as string,
        status: "CREATED",
        amountMinor: 4550,
        currency: "USD",
        expiresAt: "2026-11-04T12:00:00.000Z",
        customId: `pact:v1:${CONTRACT_HASH}`,
        invoiceId: "ctr_client000001",
      },
    });
    // No separate authorize call was needed.
    expect(paypal.calls("POST", `/v2/checkout/orders/${order.orderId}/authorize`)).toHaveLength(0);
  });

  it("reads an order with GET and masks the payer's e-mail address", async () => {
    const created = await provider.createOrder(orderInput());
    paypal.approve(created.orderId);
    const order = await provider.getOrder(created.orderId);
    const [request] = paypal.calls("GET", "/v2/checkout/orders/");
    expect(request.path).toBe(`/v2/checkout/orders/${created.orderId}`);
    expect(request.text).toBeNull();
    expect(request.headers.get("paypal-request-id")).toBeNull();
    expect(request.headers.get("content-type")).toBeNull();
    expect(order).toMatchObject({ status: "APPROVED", payerEmailMasked: "sb****@personal.example.com", approveUrl: null });
    expect(JSON.stringify(order)).not.toContain(PAYER_EMAIL);
  });

  it("URL-encodes ids so they can never change the request path", async () => {
    await failure(provider.getOrder("../../v1/oauth2/token?x=1"));
    const request = paypal.requests.at(-1);
    expect(request?.path).toBe("/v2/checkout/orders/..%2F..%2Fv1%2Foauth2%2Ftoken%3Fx%3D1");
    await expect(provider.getOrder("")).rejects.toThrow(RangeError);
  });

  it("surfaces ORDER_NOT_APPROVED with PayPal's debug id and never retries it", async () => {
    const order = await provider.createOrder(orderInput());
    const error = await failure(provider.authorizeOrder(order.orderId, "authorize-key-0001"));
    expect(error).toMatchObject({
      name: "PaymentError",
      issue: "ORDER_NOT_APPROVED",
      httpStatus: 422,
      debugId: "b14b9a1c2a3d4",
      retryable: false,
    });
    expect(error.message).toContain("Payer has not yet approved the Order");
    expect(paypal.calls("POST", `/v2/checkout/orders/${order.orderId}/authorize`)).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("authorizes an approved order and maps the authorization", async () => {
    const order = await provider.createOrder(orderInput());
    paypal.approve(order.orderId);
    const authorized = await provider.authorizeOrder(order.orderId, "authorize-key-0001");

    const [request] = paypal.calls("POST", `/v2/checkout/orders/${order.orderId}/authorize`);
    expect(request.text).toBe("{}");
    expect(request.headers.get("paypal-request-id")).toBe("authorize-key-0001");
    expect(request.headers.get("prefer")).toBe("return=representation");
    expect(request.headers.get("content-type")).toBe("application/json");

    expect(authorized.status).toBe("COMPLETED");
    expect(authorized.authorization).toEqual({
      authorizationId: expect.stringMatching(/^0AW2184448108/) as string,
      status: "CREATED",
      amountMinor: 4550,
      currency: "USD",
      expiresAt: "2026-11-04T12:00:00.000Z",
      customId: `pact:v1:${CONTRACT_HASH}`,
      invoiceId: "ctr_client000001",
    });
    expect(authorized.payerEmailMasked).toBe("sb****@personal.example.com");
  });

  it("reads the order back when an authorize replay comes without the authorization", async () => {
    const order = await provider.createOrder(orderInput());
    paypal.approve(order.orderId);
    await provider.authorizeOrder(order.orderId, "authorize-key-0001");
    paypal.intercept("POST", `/v2/checkout/orders/${order.orderId}/authorize`, () =>
      json(200, {
        id: order.orderId,
        status: "COMPLETED",
        purchase_units: [{ amount: { currency_code: "USD", value: "45.50" }, custom_id: `pact:v1:${CONTRACT_HASH}` }],
      }),
    );
    const replay = await provider.authorizeOrder(order.orderId, "authorize-key-0001");
    expect(replay.authorization).toMatchObject({ status: "CREATED", amountMinor: 4550 });
  });

  it("rejects an order in a currency other than USD or with a malformed amount", async () => {
    const order = await provider.createOrder(orderInput());
    paypal.intercept("GET", "/v2/checkout/orders/", () =>
      json(200, { id: order.orderId, status: "APPROVED", purchase_units: [{ amount: { currency_code: "EUR", value: "45.50" } }] }),
    );
    await expect(failure(provider.getOrder(order.orderId))).resolves.toMatchObject({ issue: "UNEXPECTED_RESPONSE", retryable: false });

    paypal.intercept("GET", "/v2/checkout/orders/", () =>
      json(200, { id: order.orderId, status: "APPROVED", purchase_units: [{ amount: { currency_code: "USD", value: "45.505" } }] }),
    );
    await expect(failure(provider.getOrder(order.orderId))).resolves.toMatchObject({ issue: "UNEXPECTED_RESPONSE" });
  });
});

describe("PayPalSandboxProvider — authorizations", () => {
  it("reads an authorization", async () => {
    const { authorizationId } = await authorizedOrder();
    await expect(provider.getAuthorization(authorizationId)).resolves.toEqual({
      authorizationId,
      status: "CREATED",
      amountMinor: 4550,
      currency: "USD",
      expiresAt: "2026-11-04T12:00:00.000Z",
      customId: `pact:v1:${CONTRACT_HASH}`,
      invoiceId: "ctr_client000001",
    });
    expect(paypal.calls("GET", `/v2/payments/authorizations/${authorizationId}`)).toHaveLength(1);
  });

  it("captures with an explicit amount, final_capture true, the invoice id and a note", async () => {
    const { authorizationId } = await authorizedOrder();
    const capture = await provider.captureAuthorization({
      authorizationId,
      amountMinor: 2275,
      currency: "USD",
      finalCapture: true,
      invoiceId: "ctr_client000001",
      noteToPayer: "PACT: delivery verified against contract ctr_client000001.",
      idempotencyKey: "capture-key-0001",
    });

    const [request] = paypal.calls("POST", `/v2/payments/authorizations/${authorizationId}/capture`);
    expect(request.headers.get("paypal-request-id")).toBe("capture-key-0001");
    expect(request.headers.get("prefer")).toBe("return=representation");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.json).toEqual({
      amount: { currency_code: "USD", value: "22.75" },
      final_capture: true,
      invoice_id: "ctr_client000001",
      note_to_payer: "PACT: delivery verified against contract ctr_client000001.",
    });
    expect(capture).toEqual({
      captureId: expect.stringMatching(/^2GG279541U47/) as string,
      status: "COMPLETED",
      amountMinor: 2275,
      currency: "USD",
      finalCapture: true,
    });
    await expect(provider.getAuthorization(authorizationId)).resolves.toMatchObject({ status: "CAPTURED" });
  });

  it("reads the capture back instead of assuming the amount when PayPal answers minimally", async () => {
    const { authorizationId } = await authorizedOrder();
    paypal.intercept("POST", `/v2/payments/authorizations/${authorizationId}/capture`, async (request) => {
      // Process the capture for real, but answer as PayPal does without Prefer: return=representation.
      const headers = new Headers(request.headers);
      headers.delete("prefer");
      return paypal.fetch(`${API}${request.path}`, { method: "POST", headers, body: request.text ?? undefined });
    });
    const capture = await provider.captureAuthorization({
      authorizationId,
      amountMinor: 4550,
      currency: "USD",
      finalCapture: true,
      invoiceId: "ctr_client000001",
      noteToPayer: "note",
      idempotencyKey: "capture-key-0001",
    });
    expect(capture).toMatchObject({ status: "COMPLETED", amountMinor: 4550 });
    expect(paypal.calls("GET", `/v2/payments/captures/${capture.captureId}`)).toHaveLength(1);
  });

  it("maps a second capture to AUTHORIZATION_ALREADY_CAPTURED", async () => {
    const { authorizationId } = await authorizedOrder();
    const input = { authorizationId, amountMinor: 4550, currency: "USD", finalCapture: true, invoiceId: "ctr_client000001", noteToPayer: "note" } as const;
    await provider.captureAuthorization({ ...input, idempotencyKey: "capture-key-0001" });
    const error = await failure(provider.captureAuthorization({ ...input, idempotencyKey: "capture-key-0002" }));
    expect(error).toMatchObject({ issue: "AUTHORIZATION_ALREADY_CAPTURED", httpStatus: 422, retryable: false });
  });

  it("voids with an empty POST and treats 204 No Content as success", async () => {
    const { authorizationId } = await authorizedOrder();
    await expect(provider.voidAuthorization(authorizationId, "void-key-0001")).resolves.toBeUndefined();

    const [request] = paypal.calls("POST", `/v2/payments/authorizations/${authorizationId}/void`);
    expect(request.text).toBeNull();
    expect(request.headers.get("paypal-request-id")).toBe("void-key-0001");
    expect(request.headers.get("prefer")).toBeNull();
    expect(request.headers.get("content-type")).toBe("application/json");
    await expect(provider.getAuthorization(authorizationId)).resolves.toMatchObject({ status: "VOIDED" });
  });

  it("maps a void after capture to PREVIOUSLY_CAPTURED", async () => {
    const { authorizationId } = await authorizedOrder();
    await provider.captureAuthorization({
      authorizationId,
      amountMinor: 4550,
      currency: "USD",
      finalCapture: true,
      invoiceId: "ctr_client000001",
      noteToPayer: "note",
      idempotencyKey: "capture-key-0001",
    });
    await expect(failure(provider.voidAuthorization(authorizationId, "void-key-0001"))).resolves.toMatchObject({ issue: "PREVIOUSLY_CAPTURED" });
  });

  it("reauthorizes with only the amount and returns the NEW authorization", async () => {
    const { authorizationId } = await authorizedOrder();
    const renewed = await provider.reauthorize(authorizationId, 4550, "reauthorize-key-0001");
    const [request] = paypal.calls("POST", `/v2/payments/authorizations/${authorizationId}/reauthorize`);
    expect(request.json).toEqual({ amount: { currency_code: "USD", value: "45.50" } });
    expect(request.headers.get("paypal-request-id")).toBe("reauthorize-key-0001");
    expect(renewed.authorizationId).not.toBe(authorizationId);
    expect(renewed).toMatchObject({ status: "CREATED", amountMinor: 4550 });
  });

  it("maps an unknown id to INVALID_RESOURCE_ID without retrying", async () => {
    const error = await failure(provider.getAuthorization("0AW00000000000000"));
    expect(error).toMatchObject({ issue: "INVALID_RESOURCE_ID", httpStatus: 404, retryable: false });
    expect(paypal.calls("GET", "/v2/payments/authorizations/")).toHaveLength(1);
  });
});

describe("PayPalSandboxProvider — vault", () => {
  it("creates a setup token for a merchant-initiated PayPal wallet", async () => {
    const setup = await provider.createVaultSetup({
      returnUrl: "https://pact.example/api/wallet/return",
      cancelUrl: "https://pact.example/api/wallet/cancel",
      idempotencyKey: "vault-setup-key-0001",
    });
    const [request] = paypal.calls("POST", "/v3/vault/setup-tokens");
    expect(request.headers.get("paypal-request-id")).toBe("vault-setup-key-0001");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.json).toEqual({
      payment_source: {
        paypal: {
          description: "PACT delegated agent wallet",
          usage_type: "MERCHANT",
          experience_context: {
            return_url: "https://pact.example/api/wallet/return",
            cancel_url: "https://pact.example/api/wallet/cancel",
            shipping_preference: "NO_SHIPPING",
          },
        },
      },
    });
    expect(setup).toEqual({
      setupTokenId: expect.stringMatching(/^5C991763VB2781612/) as string,
      approveUrl: `https://www.sandbox.paypal.com/agreements/approve?approval_session_id=${setup.setupTokenId}`,
    });
  });

  it("exchanges an approved setup token for a vault id and masks the payer", async () => {
    const wallet = await provider.exchangeVaultSetup("5C991763VB27816120001", "vault-exchange-key-0001");
    const [request] = paypal.calls("POST", "/v3/vault/payment-tokens");
    expect(request.headers.get("paypal-request-id")).toBe("vault-exchange-key-0001");
    expect(request.json).toEqual({ payment_source: { token: { id: "5C991763VB27816120001", type: "SETUP_TOKEN" } } });
    expect(wallet).toEqual({ vaultId: VAULT_ID, payerEmailMasked: "sb****@personal.example.com" });
  });

  it("fails clearly when the setup token comes back without an approval link", async () => {
    paypal.intercept("POST", "/v3/vault/setup-tokens", () => json(201, { id: "5C991763VB2781612X", status: "PAYER_ACTION_REQUIRED", links: [] }));
    const error = await failure(provider.createVaultSetup({ returnUrl: "https://pact.example/r", cancelUrl: "https://pact.example/c", idempotencyKey: "k" }));
    expect(error).toMatchObject({ issue: "UNEXPECTED_RESPONSE", retryable: false });
  });
});

describe("PayPalSandboxProvider — error normalisation", () => {
  it("prefers details[0].issue and its description, with the debug id from the body", async () => {
    paypal.intercept("GET", "/v2/checkout/orders/", () =>
      paypalError(422, "UNPROCCESSABLE_ENTITY", "INSTRUMENT_DECLINED", "The instrument presented was either declined by the processor or bank.", "9c1f8a7b6d5e4"),
    );
    const error = await failure(provider.getOrder("5O190127TN360001"));
    expect(error).toMatchObject({
      issue: "INSTRUMENT_DECLINED",
      message: "The instrument presented was either declined by the processor or bank.",
      httpStatus: 422,
      debugId: "9c1f8a7b6d5e4",
      retryable: false,
    });
  });

  it("falls back to the error name and message when there are no details", async () => {
    paypal.intercept("GET", "/v2/checkout/orders/", () =>
      json(403, { name: "NOT_AUTHORIZED", message: "Authorization failed due to insufficient permissions.", debug_id: "1a2b3c4d5e6f7" }, "1a2b3c4d5e6f7"),
    );
    const error = await failure(provider.getOrder("5O190127TN360001"));
    expect(error).toMatchObject({ issue: "NOT_AUTHORIZED", message: "Authorization failed due to insufficient permissions.", httpStatus: 403, debugId: "1a2b3c4d5e6f7" });
  });

  it("falls back to HTTP_<status> and the paypal-debug-id header for a non-JSON answer", async () => {
    paypal.intercept(
      "GET",
      "/v2/checkout/orders/",
      () => new Response("<html><body>Bad Request</body></html>", { status: 400, headers: { "paypal-debug-id": "77aa88bb99cc0" } }),
    );
    const error = await failure(provider.getOrder("5O190127TN360001"));
    expect(error).toMatchObject({ issue: "HTTP_400", message: "PayPal answered HTTP 400", httpStatus: 400, debugId: "77aa88bb99cc0", retryable: false });
  });

  it("rejects a 2xx answer that does not look like the resource", async () => {
    paypal.intercept("GET", "/v2/checkout/orders/", () => json(200, { unexpected: true }));
    await expect(failure(provider.getOrder("5O190127TN360001"))).resolves.toMatchObject({ issue: "UNEXPECTED_RESPONSE", httpStatus: 200, retryable: false });
    paypal.intercept("GET", "/v2/checkout/orders/", () => json(200, { id: "5O190127TN360001", status: "SOMETHING_NEW", purchase_units: [] }));
    await expect(failure(provider.getOrder("5O190127TN360001"))).resolves.toMatchObject({ issue: "UNEXPECTED_RESPONSE" });
  });
});

describe("PayPalSandboxProvider — retries and timeouts", () => {
  it("retries a GET on 5xx with exponential backoff and succeeds", async () => {
    const order = await provider.createOrder(orderInput());
    paypal.intercept("GET", "/v2/checkout/orders/", serverError);
    paypal.intercept("GET", "/v2/checkout/orders/", serverError);
    await expect(provider.getOrder(order.orderId)).resolves.toMatchObject({ orderId: order.orderId });
    expect(paypal.calls("GET", "/v2/checkout/orders/")).toHaveLength(3);
    expect(sleeps).toEqual([250, 500]);
  });

  it("gives up after two retries and reports the failure as retryable", async () => {
    const order = await provider.createOrder(orderInput());
    for (let i = 0; i < 3; i += 1) paypal.intercept("GET", "/v2/checkout/orders/", serverError);
    const error = await failure(provider.getOrder(order.orderId));
    expect(error).toMatchObject({ issue: "SERVICE_UNAVAILABLE", httpStatus: 503, debugId: "5e7f9a1b3c5d7", retryable: true });
    expect(paypal.calls("GET", "/v2/checkout/orders/")).toHaveLength(3);
    expect(sleeps).toEqual([250, 500]);
  });

  it("never retries a 422", async () => {
    paypal.intercept("POST", "/v2/checkout/orders", () =>
      paypalError(422, "UNPROCESSABLE_ENTITY", "PAYEE_ACCOUNT_RESTRICTED", "The merchant account is restricted."),
    );
    const error = await failure(provider.createOrder(orderInput()));
    expect(error).toMatchObject({ issue: "PAYEE_ACCOUNT_RESTRICTED", retryable: false });
    expect(paypal.calls("POST", "/v2/checkout/orders")).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("never retries a 400 or a plain 409", async () => {
    paypal.intercept("POST", "/v2/checkout/orders", () => paypalError(400, "INVALID_REQUEST", "MISSING_REQUIRED_PARAMETER", "A required field is missing."));
    await expect(failure(provider.createOrder(orderInput()))).resolves.toMatchObject({ httpStatus: 400, retryable: false });
    paypal.intercept("POST", "/v2/checkout/orders", () => paypalError(409, "RESOURCE_CONFLICT", "DUPLICATE_INVOICE_ID", "Duplicate invoice id."));
    await expect(failure(provider.createOrder(orderInput()))).resolves.toMatchObject({ httpStatus: 409, retryable: false });
    expect(paypal.calls("POST", "/v2/checkout/orders")).toHaveLength(2);
    expect(sleeps).toEqual([]);
  });

  it.each([
    ["503", serverError],
    ["429", () => paypalError(429, "RATE_LIMIT_REACHED", "RATE_LIMIT_REACHED", "Too many requests. Blocked due to rate limiting.")],
    ["409 PREVIOUS_REQUEST_IN_PROGRESS", () => paypalError(409, "RESOURCE_CONFLICT", "PREVIOUS_REQUEST_IN_PROGRESS", "A previous request on this resource is currently in progress.")],
  ])("retries a POST on %s, resending the same PayPal-Request-Id", async (_label, respond) => {
    paypal.intercept("POST", "/v2/checkout/orders", respond);
    const order = await provider.createOrder(orderInput());
    expect(order.status).toBe("PAYER_ACTION_REQUIRED");
    const posts = paypal.calls("POST", "/v2/checkout/orders");
    expect(posts).toHaveLength(2);
    expect(posts.map((request) => request.headers.get("paypal-request-id"))).toEqual([
      "11111111-2222-8333-9444-555555555555",
      "11111111-2222-8333-9444-555555555555",
    ]);
    expect(posts[0].text).toBe(posts[1].text);
    expect(sleeps).toEqual([250]);
  });

  it("retries a capture after a network failure with the same key, capturing once", async () => {
    const { authorizationId } = await authorizedOrder();
    paypal.intercept("POST", `/v2/payments/authorizations/${authorizationId}/capture`, () => {
      throw new TypeError("fetch failed");
    });
    const capture = await provider.captureAuthorization({
      authorizationId,
      amountMinor: 4550,
      currency: "USD",
      finalCapture: true,
      invoiceId: "ctr_client000001",
      noteToPayer: "note",
      idempotencyKey: "capture-key-0001",
    });
    expect(capture.status).toBe("COMPLETED");
    const posts = paypal.calls("POST", `/v2/payments/authorizations/${authorizationId}/capture`);
    expect(posts.map((request) => request.headers.get("paypal-request-id"))).toEqual(["capture-key-0001", "capture-key-0001"]);
  });

  it("reports an unreachable PayPal as a retryable NETWORK_ERROR after exhausting retries", async () => {
    const unreachable = new PayPalSandboxProvider({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      apiBase: API,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const error = await failure(unreachable.getOrder("5O190127TN360001"));
    expect(error).toMatchObject({ issue: "NETWORK_ERROR", httpStatus: null, debugId: null, retryable: true });
    expect(sleeps).toEqual([250, 500]);
  });

  it("aborts a request that exceeds the timeout and reports a retryable TIMEOUT", async () => {
    let attempts = 0;
    const hanging: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/oauth2/token")) return paypal.fetch(input, init);
      attempts += 1;
      // Never answers; only the abort signal ends the request.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      });
    };
    const slow = new PayPalSandboxProvider({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      apiBase: API,
      fetchImpl: hanging,
      timeoutMs: 15,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const error = await failure(slow.getOrder("5O190127TN360001"));
    expect(error).toMatchObject({ issue: "TIMEOUT", httpStatus: null, retryable: true });
    expect(error.message).toContain("15 ms");
    // A GET is repeatable, so the timeout was retried twice before giving up.
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([250, 500]);
  });
});

describe("PayPalSandboxProvider — logging", () => {
  it("logs method, path template, status, latency, debug id and deal id — never credentials or vault ids", async () => {
    vi.stubEnv("PACT_LOG_SILENT", "0");
    const lines: string[] = [];
    const collect = (line: unknown) => {
      lines.push(String(line));
    };
    vi.spyOn(console, "log").mockImplementation(collect);
    vi.spyOn(console, "warn").mockImplementation(collect);

    const order = await provider.createOrder(orderInput({ vaultId: VAULT_ID }));
    await provider.getOrder(order.orderId);
    await failure(provider.getAuthorization("0AW00000000000000"));

    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.msg === "paypal.request");
    expect(entries.map((entry) => [entry.level, entry.method, entry.path, entry.status])).toEqual([
      ["info", "POST", "/v1/oauth2/token", 200],
      ["info", "POST", "/v2/checkout/orders", 201],
      ["info", "GET", "/v2/checkout/orders/{id}", 200],
      ["warn", "GET", "/v2/payments/authorizations/{id}", 404],
    ]);
    expect(entries[1]).toMatchObject({ dealId: "deal_client01", paypalDebugId: "f6c1a2b3d4e5f", attempt: 1, idempotencyKey: "11111111-2222-8333-9444-555555555555" });
    expect(typeof entries[1].latencyMs).toBe("number");
    expect(entries[3]).toMatchObject({ paypalDebugId: "b14b9a1c2a3d4" });

    const everything = lines.join("\n");
    expect(everything).not.toContain(CLIENT_SECRET);
    expect(everything).not.toContain(VAULT_ID);
    expect(everything).not.toContain("A21AA");
    expect(everything).not.toContain(PAYER_EMAIL);
    expect(everything).not.toMatch(/Bearer|Basic/);
  });
});

describe("provider selection", () => {
  it("has no PayPal provider without credentials and falls back to the simulator", () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "");
    vi.stubEnv("PACT_PAYMENT_MODE", "");
    expect(createPayPalProviderFromEnv()).toBeNull();
    const selected = getPaymentProvider();
    expect(selected).toBeInstanceOf(SimulatedProvider);
    expect(selected.kind).toBe("simulated");
    // Memoised: the simulator's state must be shared by every caller in the process.
    expect(getPaymentProvider()).toBe(selected);
  });

  it("uses PayPal Sandbox when credentials are configured, and the simulator when it is forced", () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("PAYPAL_CLIENT_SECRET", CLIENT_SECRET);
    vi.stubEnv("PAYPAL_API_BASE", "");
    vi.stubEnv("PACT_PAYMENT_MODE", "");
    expect(createPayPalProviderFromEnv()).toBeInstanceOf(PayPalSandboxProvider);
    const selected = getPaymentProvider();
    expect(selected).toBeInstanceOf(PayPalSandboxProvider);
    // Memoised: the access token cache lives in the instance.
    expect(getPaymentProvider()).toBe(selected);

    vi.stubEnv("PACT_PAYMENT_MODE", "simulated");
    expect(getPaymentProvider().kind).toBe("simulated");
  });

  it("refuses a live API base even when it comes from the environment", () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("PAYPAL_CLIENT_SECRET", CLIENT_SECRET);
    vi.stubEnv("PAYPAL_API_BASE", "https://api-m.paypal.com");
    expect(() => createPayPalProviderFromEnv()).toThrow(/Sandbox/);
  });

  it("builds a new simulator when a different store is supplied", () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "");
    const store = { load: async () => null, save: async () => {} };
    const withStore = getPaymentProvider({ simulatedStore: store });
    expect(getPaymentProvider({ simulatedStore: store })).toBe(withStore);
    expect(getPaymentProvider()).not.toBe(withStore);
  });
});
