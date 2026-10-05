/**
 * The wallet route handlers called directly with Request objects: what an HTTP client can and
 * cannot do. Only two things are replaced — the cookie store Next.js would provide, and the
 * service context (test database, simulator, fixed clock). Everything else is the real code.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgents } from "@/lib/ai";
import type { ApiErrorBody, WalletStatus } from "@/lib/api/dto";
import { getSessionSecret } from "@/lib/config";
import { closeDb, createDbSimulatedStore, createTestDb, getWallet, type Db } from "@/lib/db";
import { PaymentError, SimulatedProvider } from "@/lib/payments";
import type { ServiceContext } from "@/lib/services/context";
import { DEMO_WALLET_OWNER } from "@/lib/services/deals";
import { SESSION_COOKIE, newSessionId, signSession, verifySession } from "@/lib/services/session";
import { OPERATOR_ATTEMPT_LIMIT, WALLET_CONNECT_LIMIT, disconnectWallet } from "@/lib/services/wallet";

const state = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  ctx: null as unknown,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.cookies.has(name) ? { name, value: state.cookies.get(name) } : undefined),
    set: (name: string, value: string) => {
      state.cookies.set(name, value);
    },
  }),
}));

vi.mock("@/lib/services/context", () => ({
  getServiceContext: async () => state.ctx,
}));

import { GET as vaultReturn } from "@/app/api/paypal/vault-return/route";
import { POST as connectRoute } from "@/app/api/wallet/connect/route";
import { DELETE as disconnectRoute, GET as statusRoute } from "@/app/api/wallet/route";

const ORIGIN = "https://pact.test";
const ADMIN_TOKEN = "operator-token-3f9a6c1e8b2d4f70";
const NOW_MS = Date.parse("2026-10-06T05:00:00.000Z");

let db: Db;
let simulator: SimulatedProvider;
let ctx: ServiceContext;
let nowMs = NOW_MS;

beforeAll(async () => {
  db = await createTestDb();
  simulator = new SimulatedProvider(createDbSimulatedStore(db), { now: () => new Date(nowMs) });
  ctx = { db, agents: createAgents({ mode: "scripted" }), provider: simulator, now: () => new Date(nowMs) };
});

afterAll(async () => {
  await closeDb(db);
});

beforeEach(() => {
  state.cookies.clear();
  state.ctx = ctx;
  // Each test starts in its own rate-limit window.
  nowMs += 3_600_000;
  vi.stubEnv("ADMIN_TOKEN", ADMIN_TOKEN);
  vi.stubEnv("APP_URL", "");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await disconnectWallet(ctx, DEMO_WALLET_OWNER);
});

/** Give the "browser" a valid session cookie and return its session id. */
function signIn(): string {
  const id = newSessionId();
  state.cookies.set(SESSION_COOKIE, signSession(id, getSessionSecret()));
  return id;
}

function currentSession(): string | null {
  return verifySession(state.cookies.get(SESSION_COOKIE), getSessionSecret());
}

interface Call {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function request(path: string, call: Call = {}): Request {
  const method = call.method ?? "GET";
  const headers = new Headers(call.headers);
  if (method !== "GET" && !headers.has("origin")) headers.set("origin", ORIGIN);
  if (call.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: call.body === undefined ? undefined : typeof call.body === "string" ? call.body : JSON.stringify(call.body),
  });
}

const connect = (body: unknown, headers?: Record<string, string>): Promise<Response> =>
  connectRoute(request("/api/wallet/connect", { method: "POST", body, headers }), {});
const status = (): Promise<Response> => statusRoute(request("/api/wallet"), {});
const disconnect = (query: string, headers?: Record<string, string>): Promise<Response> =>
  disconnectRoute(request(`/api/wallet${query}`, { method: "DELETE", headers }), {});
const comeBack = (query: string): Promise<Response> => vaultReturn(request(`/api/paypal/vault-return${query}`), {});

async function errorOf(response: Response): Promise<ApiErrorBody["error"]> {
  return ((await response.json()) as ApiErrorBody).error;
}

describe("GET /api/wallet", () => {
  it("answers a visitor without a session, uncached, with a request id", async () => {
    const response = await status();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(await response.json()).toEqual({
      provider: "simulated",
      supportsVault: true,
      session: { connected: false, pending: false, payerEmailMasked: null },
      demo: { connected: false },
      effectiveMode: "interactive",
    } satisfies WalletStatus);
    // Reading the status does not create a session.
    expect(state.cookies.size).toBe(0);
  });
});

describe("POST /api/wallet/connect and the return from the provider", () => {
  it("connects the session's wallet: connect, follow the approval link, come back connected", async () => {
    const response = await connect({ scope: "session" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { approveUrl } = (await response.json()) as { approveUrl: string };
    const session = currentSession();
    expect(session).toMatch(/^sess_[a-z0-9]{24}$/);

    // The simulator's approval link is this deployment's own return route.
    const link = new URL(approveUrl);
    expect(link.origin).toBe(ORIGIN);
    expect(link.pathname).toBe("/api/paypal/vault-return");

    const back = await comeBack(link.search);
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe("/policies?wallet=connected");
    expect(back.headers.get("cache-control")).toBe("no-store");

    const after = (await (await status()).json()) as WalletStatus;
    expect(after).toMatchObject({
      session: { connected: true, pending: false, payerEmailMasked: "si****@personal.example.com" },
      effectiveMode: "delegated",
    });
    const wallet = await getWallet(db, session ?? "");
    expect(JSON.stringify(after)).not.toContain(wallet?.vaultId ?? "missing");
  });

  it("ignores every token in the return URL: only the stored pending connection counts", async () => {
    signIn();
    // No connection was started: a crafted return achieves nothing.
    const forged = await comeBack("?scope=session&approval_token_id=SIM-S-0000000000000000&token=whatever");
    expect(forged.status).toBe(303);
    expect(forged.headers.get("location")).toBe("/policies?wallet=error");
    expect(((await (await status()).json()) as WalletStatus).session).toEqual({ connected: false, pending: false, payerEmailMasked: null });
  });

  it.each(["", "?scope=admin", "?scope=", "?scope=session&scope=demo"])("sends a return with query %j back with an error unless it completes something", async (query) => {
    const response = await comeBack(query);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/policies?wallet=error");
  });

  it("returns an error redirect, not a stack trace, when completing fails unexpectedly", async () => {
    signIn();
    await connect({ scope: "session" });
    const exchange = vi.spyOn(simulator, "exchangeVaultSetup").mockRejectedValueOnce(new TypeError("boom"));
    const response = await comeBack("?scope=session");
    expect(exchange).toHaveBeenCalledTimes(1);
    exchange.mockRestore();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/policies?wallet=error");
    expect(await response.text()).toBe("");
  });

  it("refuses cross-site requests, non-JSON bodies and unknown fields", async () => {
    const crossSite = await connect({ scope: "session" }, { origin: "https://evil.example" });
    expect(crossSite.status).toBe(403);
    expect(await errorOf(crossSite)).toMatchObject({ code: "forbidden", requestId: expect.any(String) });

    const fetchMetadata = await connect({ scope: "session" }, { "sec-fetch-site": "cross-site" });
    expect(fetchMetadata.status).toBe(403);

    const form = await connect("scope=session", { "content-type": "application/x-www-form-urlencoded" });
    expect(form.status).toBe(400);
    expect((await errorOf(form)).code).toBe("invalid_request");

    for (const body of [{ scope: "everyone" }, {}, { scope: "session", owner: "demo" }, { scope: "session", vaultId: "SIM-V-1" }]) {
      const response = await connect(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(response)).code).toBe("invalid_request");
    }
    const oversized = await connect({ scope: "session", padding: "x".repeat(2_000) });
    expect(oversized.status).toBe(400);
    // Nothing above created a wallet for anyone.
    expect(await getWallet(db, currentSession() ?? "none")).toBeNull();
  });

  it("reports a provider that refuses as 502 payment_error with the issue and debug id", async () => {
    const setup = vi
      .spyOn(simulator, "createVaultSetup")
      .mockRejectedValueOnce(new PaymentError({ issue: "NOT_AUTHORIZED", message: "insufficient permissions", httpStatus: 403, debugId: "9b1c2d3e4f5a6" }));
    const response = await connect({ scope: "session" });
    setup.mockRestore();
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toEqual({
      code: "payment_error",
      message: "PayPal could not start the wallet connection. If this is a new sandbox app, enable Vault under App Feature Options.",
      requestId: expect.any(String),
      details: { issue: "NOT_AUTHORIZED", debugId: "9b1c2d3e4f5a6", retryable: false },
    });
  });

  it("allows ten connection attempts per session in ten minutes", async () => {
    signIn();
    for (let attempt = 0; attempt < WALLET_CONNECT_LIMIT.limit; attempt += 1) {
      expect((await connect({ scope: "session" })).status).toBe(200);
    }
    const limited = await connect({ scope: "session" });
    expect(limited.status).toBe(429);
    expect(await errorOf(limited)).toMatchObject({ code: "rate_limited", details: { resetAt: expect.any(String) } });

    // Another browser is not affected, and the window ends.
    state.cookies.clear();
    expect((await connect({ scope: "session" })).status).toBe(200);
  });
});

describe("the shared demo wallet over HTTP", () => {
  const operator = { "x-admin-token": ADMIN_TOKEN };

  it("cannot be connected without the operator token", async () => {
    expect((await connect({ scope: "demo" })).status).toBe(403);
    expect((await connect({ scope: "demo" }, { "x-admin-token": "guess" })).status).toBe(403);
    const refused = await connect({ scope: "demo" }, { "x-admin-token": `${ADMIN_TOKEN}0` });
    expect(await errorOf(refused)).toMatchObject({ code: "forbidden" });

    // With no operator token configured, the header cannot match anything — not even an empty one.
    vi.stubEnv("ADMIN_TOKEN", "");
    expect((await connect({ scope: "demo" }, { "x-admin-token": "" })).status).toBe(403);
    expect((await connect({ scope: "demo" }, operator)).status).toBe(403);
    expect(await getWallet(db, DEMO_WALLET_OWNER)).toBeNull();
  });

  it("throttles guesses at the operator token per network address, whatever session they come from", async () => {
    const from = (address: string, token: string): Promise<Response> => {
      // A guesser discards cookies; the address stays.
      state.cookies.clear();
      return connect({ scope: "demo" }, { "x-admin-token": token, "x-forwarded-for": address });
    };
    for (let attempt = 0; attempt < OPERATOR_ATTEMPT_LIMIT.limit; attempt += 1) {
      expect((await from("203.0.113.7", `guess-${attempt}`)).status).toBe(403);
    }
    // Out of attempts: even the right token is not tried any more from this address.
    expect((await from("203.0.113.7", ADMIN_TOKEN)).status).toBe(429);
    expect(await getWallet(db, DEMO_WALLET_OWNER)).toBeNull();
    expect((await from("198.51.100.20", ADMIN_TOKEN)).status).toBe(200);
  });

  it("is connected by the operator, and only the operator's browser can complete it", async () => {
    const operatorSession = signIn();
    const started = await connect({ scope: "demo" }, operator);
    expect(started.status).toBe(200);
    const { approveUrl } = (await started.json()) as { approveUrl: string };
    expect(new URL(approveUrl).searchParams.get("scope")).toBe("demo");
    const operatorCookie = state.cookies.get(SESSION_COOKIE) ?? "";

    // Someone else opens the same return URL, with their own session and with none.
    state.cookies.clear();
    signIn();
    expect((await comeBack("?scope=demo")).headers.get("location")).toBe("/policies?wallet=error");
    state.cookies.clear();
    expect((await comeBack("?scope=demo")).headers.get("location")).toBe("/policies?wallet=error");
    expect(await getWallet(db, DEMO_WALLET_OWNER)).toMatchObject({ status: `pending:${operatorSession}`, vaultId: null });

    state.cookies.set(SESSION_COOKIE, operatorCookie);
    expect((await comeBack("?scope=demo")).headers.get("location")).toBe("/policies?wallet=connected");

    // Every visitor now gets delegated authorization, and learns nothing else about the wallet.
    state.cookies.clear();
    const visitor = (await (await status()).json()) as WalletStatus;
    expect(visitor).toMatchObject({ demo: { connected: true }, session: { connected: false }, effectiveMode: "delegated" });
    expect(JSON.stringify(visitor)).not.toContain(operatorSession);
  });

  it("can only be disconnected by the operator", async () => {
    signIn();
    await connect({ scope: "demo" }, operator);
    await comeBack("?scope=demo");
    expect(await getWallet(db, DEMO_WALLET_OWNER)).toMatchObject({ status: "active" });

    state.cookies.clear();
    signIn();
    expect((await disconnect("?scope=demo")).status).toBe(403);
    expect((await disconnect("?scope=demo", { "x-admin-token": "guess" })).status).toBe(403);
    // Disconnecting "my" wallet does not touch the shared one.
    expect((await disconnect("?scope=session")).status).toBe(200);
    expect(await getWallet(db, DEMO_WALLET_OWNER)).toMatchObject({ status: "active" });

    const removed = await disconnect("?scope=demo", operator);
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as WalletStatus).demo).toEqual({ connected: false });
    expect(await getWallet(db, DEMO_WALLET_OWNER)).toBeNull();
  });
});

describe("DELETE /api/wallet", () => {
  it("disconnects the session's own wallet and answers with the new status", async () => {
    const session = signIn();
    await connect({ scope: "session" });
    await comeBack("?scope=session");
    expect(await getWallet(db, session)).toMatchObject({ status: "active" });

    const response = await disconnect("?scope=session");
    expect(response.status).toBe(200);
    expect(((await response.json()) as WalletStatus).session).toEqual({ connected: false, pending: false, payerEmailMasked: null });
    expect(await getWallet(db, session)).toBeNull();
  });

  it("is a no-op without a session, requires a scope, and refuses cross-site calls", async () => {
    expect((await disconnect("?scope=session")).status).toBe(200);

    const missing = await disconnect("");
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).code).toBe("invalid_request");
    expect((await disconnect("?scope=all")).status).toBe(400);

    signIn();
    expect((await disconnect("?scope=session", { origin: "https://evil.example" })).status).toBe(403);
  });
});
