/**
 * What one network address can make PACT do when it never sends its cookie back.
 *
 * A session is free: every request without a cookie gets a new one, and with it a fresh
 * per-session budget. These tests call the real route handlers the way such a client would —
 * same address, no cookie — and count what reaches PayPal, the model and the database.
 * Only the cookie store and the service context are replaced.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgents } from "@/lib/ai";
import type { AuditorInput, AuditorStatement } from "@/lib/ai/auditor";
import type { DealView } from "@/lib/api/dto";
import { closeDb, createDbSimulatedStore, createTestDb, hitRateLimit, type Db } from "@/lib/db";
import { rateLimits } from "@/lib/db/schema";
import { DEFAULT_POLICY } from "@/lib/domain/schemas";
import { SimulatedProvider, type PaymentProvider } from "@/lib/payments";
import { RECONCILE_RATE_LIMIT, reconcileWithPayPal, type AuditorServiceDeps } from "@/lib/services/auditor";
import type { ServiceContext } from "@/lib/services/context";
import { advanceDeal, approveSimulatedOrder, createDeal, decideDeal, getDealView, handlePayPalWebhook } from "@/lib/services/deals";
import { GLOBAL_SUBJECT, RATE_LIMITS, pruneRateLimits, rateLimitKey } from "@/lib/services/rate-limit";
import { SESSION_COOKIE, newSessionId } from "@/lib/services/session";
import { completeWalletConnect, startWalletConnect } from "@/lib/services/wallet";

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

import { GET as sweepRoute } from "@/app/api/cron/sweep/route";
import { POST as reconcileRoute } from "@/app/api/deals/[id]/reconcile/route";
import { PUT as policyRoute } from "@/app/api/policy/route";
import { POST as connectRoute } from "@/app/api/wallet/connect/route";

const ORIGIN = "https://pact.test";
const APP_URL = "https://pact.test";
const NOW_MS = Date.parse("2026-10-06T05:00:00.000Z");
const HOUR_MS = 3_600_000;

let db: Db;
let simulator: SimulatedProvider;
let ctx: ServiceContext;
let nowMs = NOW_MS;
let addressCounter = 0;

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
  nowMs += 2 * HOUR_MS;
  vi.stubEnv("APP_URL", "");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A network address no other test has used. */
function freshAddress(): string {
  addressCounter += 1;
  return `203.0.113.${addressCounter}`;
}

/** A request from `address` that carries no cookie: the store is emptied first, as if none had ever been sent back. */
function cookieless(path: string, method: string, body: unknown, address: string): Request {
  state.cookies.clear();
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": address },
    body: JSON.stringify(body),
  });
}

function providerOver(overrides: Partial<PaymentProvider>): PaymentProvider {
  const base: PaymentProvider = {
    kind: simulator.kind,
    supportsVault: simulator.supportsVault,
    createOrder: (input) => simulator.createOrder(input),
    getOrder: (orderId) => simulator.getOrder(orderId),
    authorizeOrder: (orderId, key) => simulator.authorizeOrder(orderId, key),
    getAuthorization: (authorizationId) => simulator.getAuthorization(authorizationId),
    captureAuthorization: (input) => simulator.captureAuthorization(input),
    voidAuthorization: (authorizationId, key) => simulator.voidAuthorization(authorizationId, key),
    reauthorize: (authorizationId, amountMinor, key) => simulator.reauthorize(authorizationId, amountMinor, key),
    createVaultSetup: (input) => simulator.createVaultSetup(input),
    exchangeVaultSetup: (setupTokenId, key) => simulator.exchangeVaultSetup(setupTokenId, key),
    verifyWebhook: (headers, rawBody) => simulator.verifyWebhook(headers, rawBody),
  };
  return { ...base, ...overrides };
}

async function completedDeal(on: ServiceContext, sessionId: string): Promise<DealView> {
  let deal = await createDeal(on, { sessionId, clientKey: null }, { intent: "", scenarioId: "happy-path", tzOffsetMinutes: -540 });
  for (let step = 0; step < 60 && deal.next.kind !== "done"; step += 1) {
    if (deal.next.kind === "auto") deal = (await advanceDeal(on, sessionId, deal.id, APP_URL)).deal;
    else if (deal.next.gate === "approval") deal = await decideDeal(on, sessionId, deal.id, { kind: "approve_spend" });
    else if (deal.next.gate === "payment") {
      await approveSimulatedOrder(on, sessionId, deal.payment?.orderId ?? "");
      deal = await getDealView(on, sessionId, deal.id);
    } else break;
  }
  expect(deal.status).toBe("completed");
  return deal;
}

describe("a client that never returns its cookie", () => {
  it("cannot make PACT ask PayPal for more vault setup tokens than one address is allowed", async () => {
    const address = freshAddress();
    let setupCalls = 0;
    state.ctx = {
      ...ctx,
      provider: providerOver({
        createVaultSetup: async (input) => {
          setupCalls += 1;
          return simulator.createVaultSetup(input);
        },
      }),
    };
    const { limit } = RATE_LIMITS.walletConnectPerClient;

    const statuses: number[] = [];
    for (let attempt = 0; attempt < limit + 5; attempt += 1) {
      statuses.push((await connectRoute(cookieless("/api/wallet/connect", "POST", { scope: "session" }, address), {})).status);
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(limit);
    expect(statuses.slice(limit)).toEqual([429, 429, 429, 429, 429]);
    expect(setupCalls).toBe(limit);
    // A refused request did not even start a session.
    expect(state.cookies.has(SESSION_COOKIE)).toBe(false);
    // Another address is not affected.
    expect((await connectRoute(cookieless("/api/wallet/connect", "POST", { scope: "session" }, freshAddress()), {})).status).toBe(200);
  });

  it("cannot keep writing policy rows from one address", async () => {
    const address = freshAddress();
    const { limit } = RATE_LIMITS.policyUpdatePerClient;
    let accepted = 0;
    for (let attempt = 0; attempt < limit + 3; attempt += 1) {
      const response = await policyRoute(cookieless("/api/policy", "PUT", DEFAULT_POLICY, address), {});
      if (response.status === 200) accepted += 1;
      else expect(response.status).toBe(429);
    }
    expect(accepted).toBe(limit);
  });

  it("cannot buy more reconciliations by minting sessions", async () => {
    const owner = newSessionId();
    const deal = await completedDeal(ctx, owner);
    const address = freshAddress();
    const getOrder = vi.spyOn(simulator, "getOrder");
    const params = { params: Promise.resolve({ id: deal.id }) };
    const { clientKey } = await import("@/lib/services/http");
    const hashed = clientKey(cookieless("/", "POST", {}, address));

    let answered = 0;
    // Four sessions from one address, each with its own full per-session budget.
    for (let minted = 0; minted < 4; minted += 1) {
      const session = newSessionId();
      for (let attempt = 0; attempt < RECONCILE_RATE_LIMIT.limit; attempt += 1) {
        try {
          await reconcileWithPayPal(ctx, session, deal.id, { clientKey: hashed });
          answered += 1;
        } catch (error) {
          expect(error).toMatchObject({ status: 429 });
        }
      }
    }
    expect(answered).toBe(RATE_LIMITS.reconcilePerClient.limit);
    expect(getOrder).toHaveBeenCalledTimes(RATE_LIMITS.reconcilePerClient.limit);
    // The route passes the address on: a cookieless caller is bounded there too.
    const viaRoute = await reconcileRoute(cookieless(`/api/deals/${deal.id}/reconcile`, "POST", {}, freshAddress()), params);
    expect(viaRoute.status).toBe(200);
  });
});

describe("the auditor agent's statement", () => {
  it("is bounded for the whole deployment: once the hourly budget is spent, reconciliation answers with the facts alone", async () => {
    const session = newSessionId();
    const sandbox: ServiceContext = { ...ctx, provider: providerOver({ kind: "paypal_sandbox" }) };
    await startWalletConnect(sandbox, { owner: session, appUrl: APP_URL });
    await completeWalletConnect(sandbox, { owner: session });
    const deal = await completedDeal(sandbox, session);
    const statement: AuditorStatement = { narrative: "PayPal's record matches the PACT ledger.", model: "google/gemini-2.5-flash", toolCalls: [] };
    const narrate = vi.fn<(input: AuditorInput) => Promise<AuditorStatement>>(async () => statement);
    const deps: AuditorServiceDeps = { aiMode: () => "ai", credentials: () => ({ clientId: "id", clientSecret: "secret" }), narrate };

    const first = await reconcileWithPayPal(sandbox, null, deal.id, { deps, clientKey: "address-1" });
    expect(first).toMatchObject({ status: "match", source: "ai", narrative: statement.narrative });

    // The rest of the hour's budget is used up by everyone else.
    const rule = RATE_LIMITS.narratedReconcileGlobal;
    for (let used = 1; used < rule.limit; used += 1) {
      await hitRateLimit(db, rateLimitKey(rule.scope, GLOBAL_SUBJECT), rule.limit, rule.windowSeconds, new Date(nowMs));
    }
    const spent = await reconcileWithPayPal(sandbox, null, deal.id, { deps, clientKey: "address-2" });
    expect(spent).toMatchObject({ status: "match", source: "deterministic", narrative: null });
    expect(spent.note).toContain("this hour");
    expect(narrate).toHaveBeenCalledTimes(1);

    // A reconciliation that would not reach a model anyway spends nothing; the next hour starts afresh.
    nowMs += HOUR_MS + 1_000;
    await reconcileWithPayPal(sandbox, null, deal.id, { deps, narrate: false, clientKey: "address-3" });
    expect((await reconcileWithPayPal(sandbox, null, deal.id, { deps, clientKey: "address-4" })).source).toBe("ai");
  });
});

describe("forged webhook deliveries", () => {
  it("are given one shared budget for the outbound calls that verifying them could cause", async () => {
    let asked = 0;
    let allowed = 0;
    const counting: ServiceContext = {
      ...ctx,
      provider: providerOver({
        verifyWebhook: async (_headers, _rawBody, options) => {
          asked += 1;
          if (await (options?.mayCallOut ?? (async () => true))()) allowed += 1;
          return { verified: false, method: "postback", reason: "postback_failure" };
        },
      }),
    };
    const { limit } = RATE_LIMITS.webhookVerificationGlobal;
    for (let delivery = 0; delivery < limit + 10; delivery += 1) {
      expect((await handlePayPalWebhook(counting, new Headers(), "{}")).accepted).toBe(false);
    }
    expect(asked).toBe(limit + 10);
    expect(allowed).toBe(limit);
  });
});

describe("rate-limit counters", () => {
  it("are removed once they are long past their window", async () => {
    const stale = rateLimitKey("deal-create", "someone-long-gone");
    const live = rateLimitKey("deal-create", "someone-active");
    await hitRateLimit(db, stale, 8, 600, new Date(nowMs - 25 * HOUR_MS));
    await hitRateLimit(db, live, 8, 600, new Date(nowMs - 60_000));

    expect(await pruneRateLimits(ctx)).toBeGreaterThanOrEqual(1);
    const keys = (await db.select({ key: rateLimits.key }).from(rateLimits)).map((row) => row.key);
    expect(keys).not.toContain(stale);
    expect(keys).toContain(live);
  });
});

describe("GET /api/cron/sweep", () => {
  const call = (headers: Record<string, string> = {}): Promise<Response> => sweepRoute(new Request(`${ORIGIN}/api/cron/sweep`, { headers }), {});

  it("is closed until a secret is configured, and then opens only for that secret", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call({ authorization: "Bearer anything" })).status).toBe(404);

    vi.stubEnv("CRON_SECRET", "cron-secret-5d0f2a9c");
    expect((await call()).status).toBe(403);
    expect((await call({ authorization: "Bearer wrong" })).status).toBe(403);
    expect((await call({ authorization: "cron-secret-5d0f2a9c" })).status).toBe(403);

    const ok = await call({ authorization: "Bearer cron-secret-5d0f2a9c" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ examined: expect.any(Number), advanced: expect.any(Array) });
  });
});
