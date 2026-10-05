/**
 * Reconciliation as a service: deals are produced by the real step engine against the
 * simulator, then PACT's ledger is compared with the provider's own record.
 *
 * Covered here: who gets an answer and whose request is written to the audit trail, how a
 * provider failure and a real difference are reported, the auditor agent's path (with the agent
 * replaced by a fake — no model, no network), and the rate limit. The fact-by-fact rules are
 * unit-tested in src/lib/services/auditor.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgents } from "@/lib/ai";
import { AuditorUnavailableError, type AuditorInput, type AuditorStatement } from "@/lib/ai/auditor";
import type { DealView, ReconciliationView } from "@/lib/api/dto";
import {
  acquireDealLease,
  closeDb,
  createDbSimulatedStore,
  createTestDb,
  getPayment,
  listAuditEvents,
  releaseDealLease,
  upsertPayment,
  type Db,
} from "@/lib/db";
import { verifyAuditChain } from "@/lib/domain/audit";
import type { ScenarioId } from "@/lib/domain/scenarios";
import type { AuditEvent, HumanDecisionKind } from "@/lib/domain/schemas";
import { PaymentError, SimulatedProvider, type PaymentProvider, type ProviderKind } from "@/lib/payments";
import { RECONCILE_RATE_LIMIT, reconcileWithPayPal, type AuditorServiceDeps } from "@/lib/services/auditor";
import type { ServiceContext } from "@/lib/services/context";
import { advanceDeal, approveSimulatedOrder, createDeal, decideDeal, getDealView } from "@/lib/services/deals";
import { ApiError } from "@/lib/services/errors";
import { SYSTEM_OWNER } from "@/lib/services/session";
import { completeWalletConnect, startWalletConnect } from "@/lib/services/wallet";

const START_MS = Date.parse("2026-10-06T05:00:00.000Z");
const APP_URL = "https://pact.test";
const TOKYO_OFFSET_MINUTES = -540;
const OWNER = "sess_owner00000000000000000000";
const STRANGER = "sess_stranger00000000000000000";

let db: Db;
let simulator: SimulatedProvider;
let ctx: ServiceContext;
let nowMs = START_MS;
/** Every reading is one second later, so stored timestamps are ordered without real time passing. */
const now = (): Date => new Date((nowMs += 1_000));

beforeAll(async () => {
  db = await createTestDb();
  simulator = new SimulatedProvider(createDbSimulatedStore(db), { now });
  ctx = { db, agents: createAgents({ mode: "scripted" }), provider: simulator, now };
});

afterAll(async () => {
  await closeDb(db);
});

/**
 * The simulator behind a provider of the given kind, optionally with some calls replaced. Under
 * PayPal's name it lets the PayPal-only agent path run offline; with a failing read it stands in
 * for an outage.
 */
function providerOver(
  inner: SimulatedProvider,
  kind: ProviderKind,
  overrides: Partial<Omit<PaymentProvider, "kind">> = {},
): PaymentProvider {
  return {
    kind,
    supportsVault: true,
    createOrder: (input) => inner.createOrder(input),
    getOrder: (orderId) => inner.getOrder(orderId),
    authorizeOrder: (orderId, key) => inner.authorizeOrder(orderId, key),
    getAuthorization: (authorizationId) => inner.getAuthorization(authorizationId),
    captureAuthorization: (input) => inner.captureAuthorization(input),
    voidAuthorization: (authorizationId, key) => inner.voidAuthorization(authorizationId, key),
    reauthorize: (authorizationId, amountMinor, key) => inner.reauthorize(authorizationId, amountMinor, key),
    createVaultSetup: (input) => inner.createVaultSetup(input),
    exchangeVaultSetup: (setupTokenId, key) => inner.exchangeVaultSetup(setupTokenId, key),
    verifyWebhook: (headers, rawBody) => inner.verifyWebhook(headers, rawBody),
    ...overrides,
  };
}

/**
 * Create a scenario deal for `sessionId` and run the engine until `stop` says so, a review gate
 * is reached, or the deal is over. Spend approvals and simulated PayPal approvals are given.
 */
async function drive(
  context: ServiceContext,
  sessionId: string,
  scenarioId: ScenarioId,
  stop: (deal: DealView) => boolean = () => false,
): Promise<DealView> {
  let deal = await createDeal(context, { sessionId, clientKey: null }, { intent: "", scenarioId, tzOffsetMinutes: TOKYO_OFFSET_MINUTES });
  for (let step = 0; step < 80; step += 1) {
    if (stop(deal) || deal.next.kind === "done") return deal;
    if (deal.next.kind === "auto") {
      deal = (await advanceDeal(context, sessionId, deal.id, APP_URL)).deal;
    } else if (deal.next.gate === "approval") {
      deal = await decideDeal(context, sessionId, deal.id, { kind: "approve_spend" });
    } else if (deal.next.gate === "payment") {
      await approveSimulatedOrder(context, sessionId, deal.payment?.orderId ?? "");
      deal = await getDealView(context, sessionId, deal.id);
    } else {
      return deal;
    }
  }
  throw new Error(`deal ${deal.code} did not settle (${deal.status})`);
}

/** Decide at the review gate and let the engine finish. */
async function review(sessionId: string, deal: DealView, kind: HumanDecisionKind, percent?: number): Promise<DealView> {
  let current = await decideDeal(ctx, sessionId, deal.id, { kind, ...(percent === undefined ? {} : { percent }) });
  for (let step = 0; step < 10 && current.next.kind === "auto"; step += 1) {
    current = (await advanceDeal(ctx, sessionId, deal.id, APP_URL)).deal;
  }
  return current;
}

const reconciledEvents = async (dealId: string): Promise<AuditEvent[]> =>
  (await listAuditEvents(db, dealId)).filter((event) => event.type === "payment.reconciled");

const differing = (view: ReconciliationView): string[] => view.facts.filter((fact) => !fact.match).map((fact) => fact.field);

async function apiError(run: Promise<unknown>): Promise<ApiError> {
  const error = await run.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof ApiError)) throw new Error("expected an ApiError");
  return error;
}

describe("reconcileWithPayPal: a captured deal", () => {
  let deal: DealView;

  beforeAll(async () => {
    deal = await drive(ctx, OWNER, "happy-path");
    expect(deal.status).toBe("completed");
  });

  it("matches the provider's record field by field, deterministically, and says the payment is simulated", async () => {
    const view = await reconcileWithPayPal(ctx, STRANGER, deal.id);
    expect(view).toMatchObject({
      dealId: deal.id,
      status: "match",
      narrative: null,
      toolCalls: [],
      source: "deterministic",
      model: null,
      note: "Payments are simulated, so there is no PayPal record for the auditor agent to read. The comparison shown is deterministic.",
    });
    expect(view.facts.map((fact) => [fact.field, fact.match])).toEqual([
      ["Order status", true],
      ["Order amount", true],
      ["Contract binding (custom_id)", true],
      ["Invoice id", true],
      ["Authorization status", true],
      ["Authorized amount", true],
      ["Authorization expiry", true],
    ]);
    expect(view.facts[1]).toMatchObject({ pact: "$47.00", paypal: "$47.00" });
    expect(view.facts[2].paypal).toBe(`pact:v1:${deal.contract?.termsHash}`);
    expect(view.facts[4]).toMatchObject({ pact: "captured (expects CAPTURED)", paypal: "CAPTURED" });
    expect(Date.parse(view.checkedAt)).toBeGreaterThan(START_MS);
  });

  it("writes nothing to the audit trail for a visitor or another session", async () => {
    const before = await listAuditEvents(db, deal.id);
    await reconcileWithPayPal(ctx, STRANGER, deal.id);
    await reconcileWithPayPal(ctx, null, deal.id, { clientKey: "client-a" });
    expect(await listAuditEvents(db, deal.id)).toEqual(before);
  });

  it("records the owner's reconciliation as one hash-chained audit event without personal data", async () => {
    const view = await reconcileWithPayPal(ctx, OWNER, deal.id);
    expect(view.note).not.toContain("audit trail");

    const audit = await listAuditEvents(db, deal.id);
    expect(verifyAuditChain(audit)).toEqual({ valid: true, brokenAtSeq: null });
    const [event, ...more] = await reconciledEvents(deal.id);
    expect(more).toEqual([]);
    expect(event).toMatchObject({
      actor: "system",
      type: "payment.reconciled",
      title: "Reconciled with Simulated PayPal: ledger matches",
      detail: null,
      data: {
        provider: "simulated",
        orderId: deal.payment?.orderId,
        authorizationId: deal.payment?.authorizationId,
        captureId: deal.payment?.captureId,
        status: "match",
        checked: 7,
        differences: [],
        source: "deterministic",
        model: null,
        toolCalls: [],
      },
    });
    expect(event.data?.facts).toEqual(view.facts);
    expect(JSON.stringify(event)).not.toContain("@");
    // The deal itself is untouched: still completed, still captured.
    expect(await getDealView(ctx, OWNER, deal.id)).toMatchObject({ status: "completed", payment: { status: "captured" } });
  });

  it("reports a ledger that disagrees with the provider, naming the fields, and records it", async () => {
    const tampered = await drive(ctx, OWNER, "revision");
    const payment = await getPayment(db, tampered.id);
    if (!payment) throw new Error("the deal has no payment");
    // Someone edits PACT's ledger: the provider still knows the real order.
    await upsertPayment(db, tampered.id, { ...payment, amountMinor: 100, authorizedMinor: 9_900 });

    const view = await reconcileWithPayPal(ctx, OWNER, tampered.id);
    expect(view.status).toBe("mismatch");
    // With $99.00 "authorized" and $27.00 captured the ledger now claims a partial capture, which the provider denies too.
    expect(differing(view)).toEqual(["Order amount", "Authorization status", "Authorized amount"]);
    expect(view.facts.find((fact) => fact.field === "Order amount")).toMatchObject({ pact: "$1.00", paypal: "$27.00" });
    expect(view.facts.find((fact) => fact.field === "Authorized amount")).toMatchObject({ pact: "$99.00", paypal: "$27.00" });

    const [event] = await reconciledEvents(tampered.id);
    expect(event).toMatchObject({
      title: "Reconciled with Simulated PayPal: 3 differences",
      detail: "Differs: Order amount, Authorization status and Authorized amount.",
      data: { status: "mismatch", checked: 7, differences: ["Order amount", "Authorization status", "Authorized amount"] },
    });

    // A single difference is worded in the singular.
    await upsertPayment(db, tampered.id, { ...payment, amountMinor: 100 });
    await reconcileWithPayPal(ctx, OWNER, tampered.id);
    const events = await reconciledEvents(tampered.id);
    expect(events[events.length - 1]).toMatchObject({
      title: "Reconciled with Simulated PayPal: 1 difference",
      detail: "Differs: Order amount.",
    });
  });
});

describe("reconcileWithPayPal: other payment states", () => {
  it("has nothing to compare before an order exists", async () => {
    const deal = await drive(ctx, "sess_early000000000000000000000", "happy-path", (current) => current.status === "contracted");
    const view = await reconcileWithPayPal(ctx, "sess_early000000000000000000000", deal.id);
    expect(view).toMatchObject({
      status: "unavailable",
      facts: [],
      narrative: null,
      source: "deterministic",
      note: "This deal has no PayPal order yet, so there is nothing to reconcile.",
    });
    expect(await reconciledEvents(deal.id)).toEqual([]);
  });

  it("compares only the order while the payer has not approved", async () => {
    const session = "sess_waiting0000000000000000000";
    const deal = await drive(ctx, session, "happy-path", (current) => current.status === "awaiting_payment");
    const view = await reconcileWithPayPal(ctx, session, deal.id);
    expect(view.status).toBe("match");
    expect(view.facts.map((fact) => fact.field)).toEqual(["Order status", "Order amount", "Contract binding (custom_id)", "Invoice id"]);
    expect(view.facts[0]).toMatchObject({ paypal: "PAYER_ACTION_REQUIRED", match: true });

    // The payer approves at the provider, but PACT has not been told yet: that is a difference.
    await simulator.approve(deal.payment?.orderId ?? "");
    const approved = await reconcileWithPayPal(ctx, session, deal.id);
    expect(approved.status).toBe("mismatch");
    expect(differing(approved)).toEqual(["Order status"]);
  });

  it("matches a held authorization, a void after rejection and a partial release", async () => {
    const session = "sess_review00000000000000000000";
    const held = await drive(ctx, session, "injection");
    expect(held.status).toBe("in_review");
    const whileHeld = await reconcileWithPayPal(ctx, session, held.id);
    expect(whileHeld.status).toBe("match");
    expect(whileHeld.facts.find((fact) => fact.field === "Authorization status")).toMatchObject({
      pact: "authorized (expects CREATED)",
      paypal: "CREATED",
    });

    const rejected = await review(session, held, "reject_delivery");
    expect(rejected.status).toBe("rejected");
    const afterVoid = await reconcileWithPayPal(ctx, session, held.id);
    expect(afterVoid.status).toBe("match");
    expect(afterVoid.facts.find((fact) => fact.field === "Authorization status")).toMatchObject({
      pact: "voided (expects VOIDED)",
      paypal: "VOIDED",
    });

    const second = await drive(ctx, session, "injection");
    const released = await review(session, second, "release_partial", 50);
    expect(released).toMatchObject({ status: "completed", payment: { authorizedMinor: 1_800, capturedMinor: 900 } });
    const afterPartial = await reconcileWithPayPal(ctx, session, second.id);
    expect(afterPartial.status).toBe("match");
    expect(afterPartial.facts.find((fact) => fact.field === "Authorization status")).toMatchObject({
      pact: "captured (expects PARTIALLY_CAPTURED)",
      paypal: "PARTIALLY_CAPTURED",
    });
    expect(afterPartial.facts.find((fact) => fact.field === "Authorized amount")).toMatchObject({ pact: "$18.00", paypal: "$18.00" });
  });

  it("answers 404 for an unknown or malformed deal id", async () => {
    expect(await apiError(reconcileWithPayPal(ctx, OWNER, "deal_doesnotexist"))).toMatchObject({ status: 404, code: "not_found" });
    expect(await apiError(reconcileWithPayPal(ctx, OWNER, "../../etc/passwd"))).toMatchObject({ status: 404 });
    expect(await apiError(reconcileWithPayPal(ctx, OWNER, ""))).toMatchObject({ status: 404 });
  });
});

describe("reconcileWithPayPal: when the provider or the deal is not available", () => {
  let deal: DealView;
  const session = "sess_outage00000000000000000000";

  beforeAll(async () => {
    deal = await drive(ctx, session, "happy-path");
  });

  it("turns a provider failure into an answer with the issue and debug id, never an exception", async () => {
    const failing = providerOver(simulator, "simulated", {
      getOrder: () =>
        Promise.reject(new PaymentError({ issue: "INTERNAL_SERVICE_ERROR", message: "PayPal is down", httpStatus: 503, debugId: "f3a9c1d2e4b5", retryable: true })),
    });
    const view = await reconcileWithPayPal({ ...ctx, provider: failing }, session, deal.id);
    expect(view).toMatchObject({
      status: "unavailable",
      facts: [],
      narrative: null,
      toolCalls: [],
      source: "deterministic",
      note: "Simulated PayPal could not be read (INTERNAL_SERVICE_ERROR, debug id f3a9c1d2e4b5). Nothing was compared.",
    });
    expect(await reconciledEvents(deal.id)).toEqual([]);

    const halfway = providerOver(simulator, "simulated", {
      getAuthorization: () => Promise.reject(new PaymentError({ issue: "INVALID_RESOURCE_ID", message: "gone", httpStatus: 404 })),
    });
    const partial = await reconcileWithPayPal({ ...ctx, provider: halfway }, session, deal.id);
    expect(partial).toMatchObject({ status: "unavailable", facts: [], note: "Simulated PayPal could not be read (INVALID_RESOURCE_ID). Nothing was compared." });
  });

  it("does not hide an unexpected error behind 'unavailable'", async () => {
    const buggy = providerOver(simulator, "simulated", { getOrder: () => Promise.reject(new TypeError("boom")) });
    await expect(reconcileWithPayPal({ ...ctx, provider: buggy }, session, deal.id)).rejects.toThrow(TypeError);
  });

  it("refuses to compare a deal paid through a different provider than the active one", async () => {
    const view = await reconcileWithPayPal({ ...ctx, provider: providerOver(simulator, "paypal_sandbox") }, session, deal.id);
    expect(view).toMatchObject({
      status: "unavailable",
      facts: [],
      note: "This deal was paid through Simulated PayPal, which is not the active payment provider.",
    });
  });

  it("still answers the owner while a step holds the deal, but does not write the audit entry", async () => {
    const lockId = "step-in-flight";
    expect(await acquireDealLease(db, deal.id, lockId, 120, now())).not.toBeNull();
    try {
      const view = await reconcileWithPayPal(ctx, session, deal.id);
      expect(view.status).toBe("match");
      expect(view.note).toContain("Not written to the audit trail: the deal was busy with another step.");
      expect(await reconciledEvents(deal.id)).toEqual([]);
    } finally {
      await releaseDealLease(db, deal.id, lockId);
    }
    await reconcileWithPayPal(ctx, session, deal.id);
    expect(await reconciledEvents(deal.id)).toHaveLength(1);
  });
});

describe("reconcileWithPayPal: the auditor agent", () => {
  const session = "sess_sandbox0000000000000000000";
  const CREDENTIALS = { clientId: "sandbox-client-id", clientSecret: "sandbox-client-secret" };
  let sandbox: ServiceContext;
  let deal: DealView;

  const statement: AuditorStatement = {
    narrative: "PayPal reports order COMPLETED with $47.00 captured, which matches the PACT ledger.",
    model: "google/gemini-2.5-flash",
    toolCalls: [{ tool: "get_order", ok: true }],
  };

  function agent(overrides: Partial<AuditorServiceDeps> = {}) {
    const narrate = vi.fn<(input: AuditorInput) => Promise<AuditorStatement>>(async () => statement);
    const deps: AuditorServiceDeps = { aiMode: () => "ai", credentials: () => CREDENTIALS, narrate, ...overrides };
    return { deps, narrate };
  }

  beforeAll(async () => {
    // A deal paid "through PayPal Sandbox": the simulator under PayPal's name, authorized by a delegated wallet.
    sandbox = { ...ctx, provider: providerOver(simulator, "paypal_sandbox") };
    await startWalletConnect(sandbox, { owner: session, appUrl: APP_URL });
    expect(await completeWalletConnect(sandbox, { owner: session })).toEqual({ connected: true, reason: null });
    deal = await drive(sandbox, session, "happy-path");
    expect(deal).toMatchObject({ status: "completed", payment: { provider: "paypal_sandbox", mode: "delegated" } });
  });

  it("adds the agent's statement to the deterministic facts and records which tools it used", async () => {
    const { deps, narrate } = agent();
    const view = await reconcileWithPayPal(sandbox, session, deal.id, { deps });

    expect(view).toMatchObject({
      status: "match",
      narrative: statement.narrative,
      toolCalls: [{ tool: "get_order", ok: true }],
      source: "ai",
      model: "google/gemini-2.5-flash",
      note: null,
    });
    expect(view.facts).toHaveLength(7);
    expect(narrate).toHaveBeenCalledTimes(1);
    const [input] = narrate.mock.calls[0];
    expect(input).toMatchObject({ orderId: deal.payment?.orderId, credentials: CREDENTIALS, logFields: { dealId: deal.id } });
    expect(input.facts).toEqual(view.facts);

    const [event] = await reconciledEvents(deal.id);
    expect(event).toMatchObject({
      title: "Reconciled with PayPal: ledger matches",
      data: { provider: "paypal_sandbox", source: "ai", model: "google/gemini-2.5-flash", toolCalls: [{ tool: "get_order", ok: true }] },
    });
    // The agent's prose is not part of the audit record; the facts are.
    expect(JSON.stringify(event)).not.toContain(statement.narrative);
    expect(JSON.stringify(event)).not.toContain(CREDENTIALS.clientSecret);
  });

  it("cannot change the verdict: a ledger difference stays a mismatch whatever the agent writes", async () => {
    const other = await drive(sandbox, session, "revision");
    const payment = await getPayment(db, other.id);
    if (!payment) throw new Error("the deal has no payment");
    await upsertPayment(db, other.id, { ...payment, amountMinor: 2_600 });

    const { deps } = agent();
    const view = await reconcileWithPayPal(sandbox, STRANGER, other.id, { deps });
    expect(view).toMatchObject({ status: "mismatch", source: "ai", narrative: statement.narrative });
    expect(differing(view)).toEqual(["Order amount"]);
  });

  it("falls back to the facts alone when the agent fails, keeping the tool calls it made", async () => {
    const failed = agent({
      narrate: () => Promise.reject(new AuditorUnavailableError("model", "timeout", [{ tool: "get_order", ok: true }])),
    });
    const view = await reconcileWithPayPal(sandbox, STRANGER, deal.id, { deps: failed.deps });
    expect(view).toMatchObject({
      status: "match",
      narrative: null,
      source: "deterministic",
      model: null,
      toolCalls: [{ tool: "get_order", ok: true }],
      note: "The auditor agent was unavailable (model). The comparison shown is deterministic.",
    });
    expect(view.facts).toHaveLength(7);

    const crashed = agent({ narrate: () => Promise.reject(new Error("unexpected")) });
    const afterCrash = await reconcileWithPayPal(sandbox, STRANGER, deal.id, { deps: crashed.deps });
    expect(afterCrash).toMatchObject({
      status: "match",
      narrative: null,
      toolCalls: [],
      note: "The auditor agent was unavailable. The comparison shown is deterministic.",
    });
  });

  it("does not run the agent in scripted mode, without credentials, or when no statement is wanted", async () => {
    const scripted = agent({ aiMode: () => "scripted" });
    expect(await reconcileWithPayPal(sandbox, STRANGER, deal.id, { deps: scripted.deps })).toMatchObject({
      narrative: null,
      source: "deterministic",
      note: "The auditor agent is switched off (scripted mode). The comparison shown is deterministic.",
    });
    expect(scripted.narrate).not.toHaveBeenCalled();

    const keyless = agent({ credentials: () => null });
    expect(await reconcileWithPayPal(sandbox, STRANGER, deal.id, { deps: keyless.deps })).toMatchObject({
      narrative: null,
      note: "The auditor agent has no PayPal credentials to read with. The comparison shown is deterministic.",
    });
    expect(keyless.narrate).not.toHaveBeenCalled();

    const silent = agent();
    expect(await reconcileWithPayPal(sandbox, STRANGER, deal.id, { deps: silent.deps, narrate: false })).toMatchObject({
      narrative: null,
      source: "deterministic",
    });
    expect(silent.narrate).not.toHaveBeenCalled();
  });

  it("does not ask the agent about a record the provider could not show", async () => {
    const { deps, narrate } = agent();
    const down = providerOver(simulator, "paypal_sandbox", {
      getOrder: () => Promise.reject(new PaymentError({ issue: "INTERNAL_SERVICE_ERROR", message: "down", httpStatus: 503 })),
    });
    const view = await reconcileWithPayPal({ ...sandbox, provider: down }, STRANGER, deal.id, { deps });
    expect(view).toMatchObject({ status: "unavailable", note: "PayPal could not be read (INTERNAL_SERVICE_ERROR). Nothing was compared." });
    expect(narrate).not.toHaveBeenCalled();
  });
});

describe("reconcileWithPayPal: rate limit", () => {
  let deal: DealView;
  const session = "sess_limit000000000000000000000";

  beforeAll(async () => {
    deal = await drive(ctx, session, "happy-path");
  });

  it("allows twelve reconciliations per session in ten minutes, then answers 429 before doing any work", async () => {
    const caller = "sess_curious0000000000000000000";
    for (let attempt = 0; attempt < RECONCILE_RATE_LIMIT.limit; attempt += 1) {
      expect((await reconcileWithPayPal(ctx, caller, deal.id)).status).toBe("match");
    }
    const getOrder = vi.spyOn(simulator, "getOrder");
    const error = await apiError(reconcileWithPayPal(ctx, caller, deal.id));
    expect(error).toMatchObject({ status: 429, code: "rate_limited" });
    expect(error.details).toEqual({ resetAt: expect.any(String) });
    expect(getOrder).not.toHaveBeenCalled();
    getOrder.mockRestore();

    // Another session is counted separately.
    expect((await reconcileWithPayPal(ctx, "sess_another0000000000000000000", deal.id)).status).toBe("match");
  });

  it("counts callers without a session by their client key", async () => {
    for (let attempt = 0; attempt < RECONCILE_RATE_LIMIT.limit; attempt += 1) {
      await reconcileWithPayPal(ctx, null, deal.id, { clientKey: "client-one" });
    }
    expect(await apiError(reconcileWithPayPal(ctx, null, deal.id, { clientKey: "client-one" }))).toMatchObject({ status: 429 });
    expect((await reconcileWithPayPal(ctx, null, deal.id, { clientKey: "client-two" })).status).toBe("match");
  });

  it("does not throttle the seed script, which reconciles as the showcase owner", async () => {
    for (let attempt = 0; attempt < RECONCILE_RATE_LIMIT.limit + 3; attempt += 1) {
      expect((await reconcileWithPayPal(ctx, SYSTEM_OWNER, deal.id, { narrate: false })).status).toBe("match");
    }
    // SYSTEM_OWNER does not own this session's deal, so nothing was recorded on it either.
    expect(await reconciledEvents(deal.id)).toEqual([]);
  });
});
