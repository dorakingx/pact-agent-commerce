/**
 * The operations, reconciliation and health route handlers called directly with Request
 * objects, plus system status against a healthy database. Replaced: the cookie store Next.js
 * would provide, the service context and the process-wide database handle (all pointing at one
 * test database with the simulator). Everything else is the real code.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgents } from "@/lib/ai";
import type { ApiErrorBody, DealView, OpsSnapshot, ReconciliationView } from "@/lib/api/dto";
import { APP_VERSION, getSessionSecret } from "@/lib/config";
import { closeDb, createDbSimulatedStore, createTestDb, listAuditEvents, type Db } from "@/lib/db";
import { SimulatedProvider } from "@/lib/payments";
import type { ServiceContext } from "@/lib/services/context";
import { DEMO_WALLET_OWNER, advanceDeal, approveSimulatedOrder, createDeal, getDealView } from "@/lib/services/deals";
import { SESSION_COOKIE, SYSTEM_OWNER, newSessionId, signSession } from "@/lib/services/session";
import { getSystemStatus, type SystemStatusReport } from "@/lib/services/system";
import { completeWalletConnect, disconnectWallet, startWalletConnect } from "@/lib/services/wallet";

const state = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  ctx: null as unknown,
  db: null as unknown,
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

vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: async () => state.db,
}));

import { POST as reconcileRoute } from "@/app/api/deals/[id]/reconcile/route";
import { GET as healthRoute } from "@/app/api/health/route";
import { GET as operationsRoute } from "@/app/api/operations/route";

const ORIGIN = "https://pact.test";
const START_MS = Date.parse("2026-10-06T05:00:00.000Z");

let db: Db;
let ctx: ServiceContext;
let nowMs = START_MS;
const now = (): Date => new Date((nowMs += 1_000));

beforeAll(async () => {
  db = await createTestDb();
  ctx = { db, agents: createAgents({ mode: "scripted" }), provider: new SimulatedProvider(createDbSimulatedStore(db), { now }), now };
  state.ctx = ctx;
  state.db = db;
});

afterAll(async () => {
  await closeDb(db);
});

beforeEach(() => {
  state.cookies.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function signIn(sessionId: string = newSessionId()): string {
  state.cookies.set(SESSION_COOKIE, signSession(sessionId, getSessionSecret()));
  return sessionId;
}

/** Run the happy-path scenario for `sessionId` to its end (captured). */
async function completedDeal(sessionId: string): Promise<DealView> {
  let deal = await createDeal(ctx, { sessionId, clientKey: null }, { intent: "", scenarioId: "happy-path", tzOffsetMinutes: -540 });
  for (let step = 0; step < 60 && deal.next.kind !== "done"; step += 1) {
    if (deal.next.kind === "auto") {
      deal = (await advanceDeal(ctx, sessionId, deal.id, ORIGIN)).deal;
    } else {
      await approveSimulatedOrder(ctx, sessionId, deal.payment?.orderId ?? "");
      deal = await getDealView(ctx, sessionId, deal.id);
    }
  }
  expect(deal.status).toBe("completed");
  return deal;
}

const reconcile = (dealId: string, headers: Record<string, string> = {}, body: string | null = "{}"): Promise<Response> =>
  reconcileRoute(
    new Request(`${ORIGIN}/api/deals/${dealId}/reconcile`, {
      method: "POST",
      headers: { origin: ORIGIN, ...(body === null ? {} : { "content-type": "application/json" }), ...headers },
      body,
    }),
    { params: Promise.resolve({ id: dealId }) },
  );

async function errorOf(response: Response): Promise<ApiErrorBody["error"]> {
  return ((await response.json()) as ApiErrorBody).error;
}

describe("GET /api/operations", () => {
  let alice: string;
  let aliceDeal: DealView;
  let showcaseDeal: DealView;

  beforeAll(async () => {
    alice = newSessionId();
    aliceDeal = await completedDeal(alice);
    showcaseDeal = await completedDeal(SYSTEM_OWNER);
  });

  const snapshot = async (): Promise<{ response: Response; body: OpsSnapshot }> => {
    const response = await operationsRoute(new Request(`${ORIGIN}/api/operations`), {});
    return { response, body: (await response.json()) as OpsSnapshot };
  };

  it("shows a visitor without a session the showcase only, uncached", async () => {
    const { response, body } = await snapshot();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.deals.map((deal) => [deal.id, deal.origin])).toEqual([[showcaseDeal.id, "showcase"]]);
    expect(body.totals).toMatchObject({ deals: 1, capturedMinor: 4_700, heldMinor: 0, firstPassRate: 1 });
    // Reading the ledger never starts a session.
    expect(state.cookies.size).toBe(0);
  });

  it("adds the caller's own deals for a session, and never another session's", async () => {
    signIn(alice);
    const mine = (await snapshot()).body;
    expect(mine.deals.map((deal) => [deal.id, deal.origin])).toEqual([
      [showcaseDeal.id, "showcase"],
      [aliceDeal.id, "mine"],
    ]);
    expect(mine.totals).toMatchObject({ deals: 2, capturedMinor: 9_400, authorizedMinor: 9_400 });
    expect(mine.paymentEvents.filter((event) => event.type === "captured")).toHaveLength(2);
    expect(mine.checks.length).toBeGreaterThanOrEqual(12);

    state.cookies.clear();
    signIn();
    expect((await snapshot()).body.deals.map((deal) => deal.id)).toEqual([showcaseDeal.id]);
  });

  it("ignores a session cookie whose signature does not verify", async () => {
    state.cookies.set(SESSION_COOKIE, `${alice}.forged-signature`);
    expect((await snapshot()).body.deals.map((deal) => deal.id)).toEqual([showcaseDeal.id]);
  });
});

describe("POST /api/deals/{id}/reconcile", () => {
  let owner: string;
  let deal: DealView;

  beforeAll(async () => {
    owner = newSessionId();
    deal = await completedDeal(owner);
  });

  it("answers anyone who holds the deal id, and records only the owner's request", async () => {
    const visitor = await reconcile(deal.id);
    expect(visitor.status).toBe(200);
    expect(visitor.headers.get("cache-control")).toBe("no-store");
    const view = (await visitor.json()) as ReconciliationView;
    expect(view).toMatchObject({ dealId: deal.id, status: "match", source: "deterministic", narrative: null });
    expect(view.facts).toHaveLength(7);
    expect((await listAuditEvents(db, deal.id)).filter((event) => event.type === "payment.reconciled")).toEqual([]);

    signIn(owner);
    expect((await reconcile(deal.id)).status).toBe(200);
    const recorded = (await listAuditEvents(db, deal.id)).filter((event) => event.type === "payment.reconciled");
    expect(recorded.map((event) => event.title)).toEqual(["Reconciled with Simulated PayPal: ledger matches"]);
  });

  it("answers 404 for an unknown deal in the API's error shape", async () => {
    const response = await reconcile("deal_000000000000");
    expect(response.status).toBe(404);
    expect(await errorOf(response)).toEqual({ code: "not_found", message: "Deal not found", requestId: expect.any(String) });
    expect((await reconcile("not-a-deal-id")).status).toBe(404);
  });

  it("refuses cross-site requests and anything that is not JSON", async () => {
    signIn(owner);
    const crossSite = await reconcile(deal.id, { origin: "https://evil.example" });
    expect(crossSite.status).toBe(403);
    expect((await errorOf(crossSite)).code).toBe("forbidden");
    expect((await reconcile(deal.id, { "sec-fetch-site": "cross-site" })).status).toBe(403);

    // What a plain HTML form could send: no JSON content type.
    const noBody = await reconcile(deal.id, {}, null);
    expect(noBody.status).toBe(400);
    expect((await errorOf(noBody)).code).toBe("invalid_request");
    expect((await reconcile(deal.id, { "content-type": "application/x-www-form-urlencoded" }, "a=1")).status).toBe(400);
    expect((await reconcile(deal.id, {}, "not json")).status).toBe(400);
  });

  it("limits a caller without a session by network address", async () => {
    const from = (address: string): Promise<Response> => reconcile(deal.id, { "x-forwarded-for": address });
    for (let attempt = 0; attempt < 12; attempt += 1) expect((await from("203.0.113.9")).status).toBe(200);
    const limited = await from("203.0.113.9");
    expect(limited.status).toBe(429);
    expect(await errorOf(limited)).toMatchObject({ code: "rate_limited", details: { resetAt: expect.any(String) } });
    expect((await from("198.51.100.4")).status).toBe(200);
  });
});

describe("GET /api/health and system status with a healthy database", () => {
  beforeEach(() => {
    for (const name of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "PAYPAL_API_BASE", "PACT_PAYMENT_MODE", "PACT_AI_MODE", "DATABASE_URL", "POSTGRES_URL"]) {
      vi.stubEnv(name, "");
    }
  });

  afterEach(async () => {
    await disconnectWallet(ctx, DEMO_WALLET_OWNER);
  });

  const health = async (): Promise<{ response: Response; body: SystemStatusReport }> => {
    const response = await healthRoute(new Request(`${ORIGIN}/api/health`), {});
    return { response, body: (await response.json()) as SystemStatusReport };
  };

  it("reports a keyless deployment: simulator, no webhooks, nothing degraded", async () => {
    const { response, body } = await health();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      payments: { provider: "simulated", configured: false, webhooks: false, delegatedWallet: false },
      ai: {
        mode: "ai",
        buyerModel: "google/gemini-2.5-flash",
        sellerModel: "openai/gpt-5-mini",
        verifierModel: "google/gemini-2.5-flash",
      },
      database: "pglite",
      version: APP_VERSION,
    });
    expect(body).not.toHaveProperty("degraded");
  });

  it("reports the shared demo wallet once it is connected, and not while it is only pending", async () => {
    const operator = newSessionId();
    await startWalletConnect(ctx, { owner: DEMO_WALLET_OWNER, appUrl: ORIGIN, initiatedBy: operator });
    expect((await health()).body.payments.delegatedWallet).toBe(false);

    await completeWalletConnect(ctx, { owner: DEMO_WALLET_OWNER, sessionId: operator });
    const { body } = await health();
    expect(body.payments).toEqual({ provider: "simulated", configured: false, webhooks: false, delegatedWallet: true });
    // No id of any kind: not the vault's, not the operator's session.
    expect(JSON.stringify(body)).not.toMatch(/SIM-|sess_/);
  });

  it("does not count a demo wallet issued by another provider than the active one", async () => {
    const operator = newSessionId();
    await startWalletConnect(ctx, { owner: DEMO_WALLET_OWNER, appUrl: ORIGIN, initiatedBy: operator });
    await completeWalletConnect(ctx, { owner: DEMO_WALLET_OWNER, sessionId: operator });

    vi.stubEnv("PAYPAL_CLIENT_ID", "AZ-sandbox-client-id");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "EL-sandbox-client-secret");
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "WH-0000000000");
    const status = await getSystemStatus({ openDb: async () => db });
    expect(status.payments).toEqual({ provider: "paypal_sandbox", configured: true, webhooks: true, delegatedWallet: false });
    expect(status).not.toHaveProperty("degraded");
    expect(JSON.stringify(status)).not.toContain("EL-sandbox-client-secret");
  });
});
