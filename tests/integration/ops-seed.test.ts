/**
 * The showcase seeding script, run against the real step engine with scripted agents and the
 * simulator: every planned request must end where its scenario is meant to end, and what it
 * leaves behind must be an honest operations ledger.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgents } from "@/lib/ai";
import { parseIntentScripted } from "@/lib/ai/intent";
import { closeDb, createDbSimulatedStore, createTestDb, loadDealGraphs, type Db } from "@/lib/db";
import { verifyAuditChain } from "@/lib/domain/audit";
import { SCENARIOS, type ScenarioId } from "@/lib/domain/scenarios";
import { getSeller } from "@/lib/domain/sellers";
import { SimulatedProvider, type PaymentProvider } from "@/lib/payments";
import { reconcileWithPayPal } from "@/lib/services/auditor";
import type { ServiceContext } from "@/lib/services/context";
import { DEMO_WALLET_OWNER, advanceDeal, approveSimulatedOrder, createDeal, decideDeal, getDealView } from "@/lib/services/deals";
import { getOpsSnapshot } from "@/lib/services/operations";
import { SYSTEM_OWNER } from "@/lib/services/session";
import { completeWalletConnect, startWalletConnect } from "@/lib/services/wallet";
import {
  DEFAULT_COUNT,
  EXPECTED_STATUS,
  MAX_COUNT,
  OPERATOR_REASON,
  UsageError,
  formatResults,
  missingPrerequisite,
  parseArgs,
  planShowcase,
  runShowcaseDeal,
  type SeedEngine,
  type ShowcaseResult,
} from "../../scripts/seed-showcase";

const START_MS = Date.parse("2026-10-06T05:00:00.000Z");
/** Date#getTimezoneOffset() for UTC+9: "tomorrow at 6 PM" is then 28 hours away. */
const TOKYO_OFFSET_MINUTES = -540;
const RUN_OPTIONS = { appUrl: "https://pact.test", tzOffsetMinutes: TOKYO_OFFSET_MINUTES };

const ENGINE: SeedEngine = {
  owner: SYSTEM_OWNER,
  createDeal,
  advanceDeal,
  decideDeal,
  getDealView,
  approveSimulatedOrder,
  reconcile: reconcileWithPayPal,
};

/** A test context on its own database, with a clock that moves one second per reading. */
async function testContext(): Promise<ServiceContext> {
  const db = await createTestDb();
  let nowMs = START_MS;
  const now = (): Date => new Date((nowMs += 1_000));
  return {
    db,
    agents: createAgents({ mode: "scripted" }),
    provider: new SimulatedProvider(createDbSimulatedStore(db), { now }),
    now,
  };
}

describe("planShowcase", () => {
  it("cycles through the four scenarios, starting with each scenario's own request", () => {
    const plans = planShowcase(DEFAULT_COUNT);
    expect(plans).toHaveLength(8);
    expect(plans.map((plan) => plan.scenarioId)).toEqual([
      "happy-path", "revision", "approval", "injection",
      "happy-path", "revision", "approval", "injection",
    ]);
    expect(plans.slice(0, 4).map((plan) => plan.intent)).toEqual(SCENARIOS.map((scenario) => scenario.intent));
    for (const plan of plans) expect(plan.expected).toBe(EXPECTED_STATUS[plan.scenarioId]);
  });

  it("does not repeat a request until every variation has been used", () => {
    const twelve = planShowcase(12).map((plan) => plan.intent);
    expect(new Set(twelve).size).toBe(12);
    const thirteen = planShowcase(13);
    expect(thirteen[12].intent).toBe(thirteen[0].intent);
  });

  it("can plan a single scenario", () => {
    const plans = planShowcase(4, "injection");
    expect(plans.every((plan) => plan.scenarioId === "injection" && plan.expected === "rejected")).toBe(true);
    expect(new Set(plans.map((plan) => plan.intent)).size).toBe(3);
  });

  it("rejects a count outside 1 to 60", () => {
    for (const count of [0, -1, 1.5, MAX_COUNT + 1, Number.NaN]) expect(() => planShowcase(count)).toThrow(UsageError);
    expect(planShowcase(MAX_COUNT)).toHaveLength(MAX_COUNT);
  });

  it("only asks each pinned seller for work it offers, with a real budget", () => {
    const now = new Date(START_MS);
    for (const plan of planShowcase(12)) {
      const scenario = SCENARIOS.find((candidate) => candidate.id === plan.scenarioId);
      const seller = getSeller(scenario?.sellerId ?? "");
      const mandate = parseIntentScripted(plan.intent, now, TOKYO_OFFSET_MINUTES);
      expect(seller?.categories, plan.intent).toContain(mandate.category);
      expect(mandate.budgetMinor, plan.intent).toBeGreaterThanOrEqual(3_000);
      // Nothing was left over for the notes: the whole request was understood.
      expect(mandate.notes, plan.intent).toEqual([]);
    }
  });
});

describe("parseArgs", () => {
  it("defaults to eight deals over all scenarios", () => {
    expect(parseArgs([])).toEqual({ count: 8, scenario: null, dryRun: false });
  });

  it("reads --count, --scenario and --dry-run in any order", () => {
    expect(parseArgs(["--dry-run", "--scenario", "revision", "--count", "3"])).toEqual({ count: 3, scenario: "revision", dryRun: true });
  });

  it.each([
    [["--count"]],
    [["--count", "0"]],
    [["--count", "61"]],
    [["--count", "ten"]],
    [["--count", "-3"]],
    [["--scenario"]],
    [["--scenario", "refund"]],
    [["--force"]],
    [["8"]],
  ])("refuses %j", (argv) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
  });
});

describe("seeding through the real engine", () => {
  let ctx: ServiceContext;
  let db: Db;
  const results: ShowcaseResult[] = [];

  beforeAll(async () => {
    ctx = await testContext();
    db = ctx.db;
    for (const plan of planShowcase(12)) results.push(await runShowcaseDeal(ENGINE, ctx, plan, RUN_OPTIONS));
  }, 240_000);

  afterAll(async () => {
    await closeDb(db);
  });

  it("ends every deal where its scenario should end", () => {
    expect(results.map((result) => [result.plan.scenarioId, result.status, result.problem])).toEqual(
      planShowcase(12).map((plan) => [plan.scenarioId, plan.expected, null]),
    );
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it("produces realistic, varied deals with the provider's ids", () => {
    for (const result of results) {
      expect(result.code).toMatch(/^PACT-[A-Z0-9]{4}$/);
      expect(result.priceMinor ?? 0, result.plan.intent).toBeGreaterThanOrEqual(1_500);
      expect(result.orderId).toMatch(/^SIM-O-/);
      expect(result.authorizationId).toMatch(/^SIM-A-/);
      // Captured deals have a capture; rejected ones were voided and must not.
      if (result.status === "completed") expect(result.captureId).toMatch(/^SIM-C-/);
      else expect(result.captureId).toBeNull();
      expect(result.reconciliation).toBe("match");
    }
    expect(new Set(results.map((result) => result.priceMinor)).size).toBeGreaterThanOrEqual(8);
  });

  it("splits by policy exactly as the scenarios intend", async () => {
    const graphs = await loadDealGraphs(db, results.map((result) => result.dealId ?? ""));
    const byScenario = (id: ScenarioId) => results.filter((result) => result.plan.scenarioId === id).map((result) => graphs.get(result.dealId ?? ""));

    for (const graph of [...byScenario("happy-path"), ...byScenario("revision")]) {
      expect(graph?.deal.policyEvaluation?.outcome).toBe("allow");
      expect(graph?.audit.some((event) => event.type.startsWith("human."))).toBe(false);
    }
    for (const graph of byScenario("revision")) {
      expect(graph?.reports.map((report) => report.decision)).toEqual(["revision_required", "capture_eligible"]);
    }
    for (const graph of byScenario("approval")) {
      expect(graph?.deal.policyEvaluation?.outcome).toBe("needs_approval");
      expect(graph?.signed?.contract.price.amountMinor ?? 0).toBeGreaterThan(10_000);
    }
    for (const graph of byScenario("injection")) {
      expect(graph?.reports.map((report) => report.decision)).toEqual(["human_review"]);
      expect(graph?.payment).toMatchObject({ status: "voided", capturedMinor: 0 });
    }
  });

  it("records the operator's decisions as the seed script's, on an intact audit chain", async () => {
    const graphs = await loadDealGraphs(db, results.map((result) => result.dealId ?? ""));
    for (const result of results) {
      const graph = graphs.get(result.dealId ?? "");
      if (!graph) throw new Error(`deal ${result.code} is not in the database`);
      expect(graph.deal.owner).toBe(SYSTEM_OWNER);
      expect(verifyAuditChain(graph.audit)).toEqual({ valid: true, brokenAtSeq: null });

      const decisions = graph.audit.filter((event) => event.type.startsWith("human.")).map((event) => event.type);
      const expected: Record<ScenarioId, string[]> = {
        "happy-path": [],
        revision: [],
        approval: ["human.approved_spend"],
        injection: ["human.approved_spend", "human.rejected_delivery"],
      };
      expect(decisions, result.plan.scenarioId).toEqual(expected[result.plan.scenarioId]);
      if (decisions.length > 0) expect(graph.deal.humanDecision?.reason).toBe(OPERATOR_REASON);
      // Seeding ends with one comparison against the provider's record.
      expect(graph.audit[graph.audit.length - 1]).toMatchObject({
        type: "payment.reconciled",
        title: "Reconciled with Simulated PayPal: ledger matches",
      });
    }
  });

  it("shows up as the public showcase with totals that add up", async () => {
    const snapshot = await getOpsSnapshot(ctx, null);
    expect(snapshot.deals).toHaveLength(12);
    expect(snapshot.deals.every((deal) => deal.origin === "showcase" && deal.paymentProvider === "simulated")).toBe(true);

    const captured = results.filter((result) => result.status === "completed").reduce((sum, result) => sum + (result.priceMinor ?? 0), 0);
    const voided = results.filter((result) => result.status === "rejected").reduce((sum, result) => sum + (result.priceMinor ?? 0), 0);
    expect(snapshot.totals).toMatchObject({
      deals: 12,
      capturedMinor: captured,
      heldMinor: 0,
      releasedMinor: voided,
      authorizedMinor: captured + voided,
      pendingHumanReview: 0,
      // First deliveries: 3 happy-path and 3 approval deals passed; 3 revision and 3 injection deals did not.
      verificationFailureRate: 0.5,
      firstPassRate: 0.5,
    });
    expect(snapshot.paymentEvents.filter((event) => event.type === "reconciled")).toHaveLength(12);
    expect(snapshot.paymentEvents.filter((event) => event.type === "captured").reduce((sum, event) => sum + event.amountMinor, 0)).toBe(captured);
  });

  it("prints one table row per deal, with ids and no surprises", () => {
    const table = formatResults(results).split("\n");
    expect(table).toHaveLength(2 + results.length);
    expect(table[0]).toMatch(/^Code\s+Scenario\s+Final status\s+Price\s+Order\s+Authorization\s+Capture\s+Check\s+Result$/);
    expect(table[1]).toMatch(/^[- ]+$/);
    const first = results[0];
    expect(table[2]).toContain(first.code ?? "");
    expect(table[2]).toContain("$47.00");
    expect(table[2]).toContain(first.captureId ?? "");
    expect(table.slice(2).every((row) => row.endsWith("ok"))).toBe(true);
  });
});

describe("seeding: gates and failures", () => {
  it("uses the shared demo wallet when there is one: no payment gate, delegated authorization", async () => {
    const ctx = await testContext();
    try {
      const operator = "sess_operator0000000000000000";
      await startWalletConnect(ctx, { owner: DEMO_WALLET_OWNER, appUrl: RUN_OPTIONS.appUrl, initiatedBy: operator });
      expect(await completeWalletConnect(ctx, { owner: DEMO_WALLET_OWNER, sessionId: operator })).toEqual({ connected: true, reason: null });

      const gates: string[] = [];
      const result = await runShowcaseDeal(ENGINE, ctx, planShowcase(1)[0], {
        ...RUN_OPTIONS,
        onStep: (deal) => {
          if (deal.next.kind === "human") gates.push(deal.next.gate);
        },
      });
      expect(result).toMatchObject({ ok: true, status: "completed", priceMinor: 4_700, reconciliation: "match" });
      expect(gates).toEqual([]);
      const view = await getDealView(ctx, null, result.dealId ?? "");
      expect(view.payment).toMatchObject({ mode: "delegated", status: "captured", capturedMinor: 4_700 });
    } finally {
      await closeDb(ctx.db);
    }
  });

  it("reports a deal that ends somewhere else, and one that cannot be created, without throwing", async () => {
    const ctx = await testContext();
    try {
      const [plan] = planShowcase(1, "injection");
      const wrongExpectation = await runShowcaseDeal(ENGINE, ctx, { ...plan, expected: "completed" }, RUN_OPTIONS);
      expect(wrongExpectation).toMatchObject({ ok: false, status: "rejected", problem: null });
      expect(formatResults([wrongExpectation]).split("\n")[2]).toMatch(/UNEXPECTED \(wanted completed\)$/);

      const notCreated = await runShowcaseDeal(ENGINE, ctx, { ...plan, intent: "hi" }, RUN_OPTIONS);
      expect(notCreated).toMatchObject({ ok: false, status: null, code: null, dealId: null, reconciliation: null });
      expect(notCreated.problem).toEqual(expect.any(String));
      expect(formatResults([notCreated]).split("\n")[2]).toContain("not created");
    } finally {
      await closeDb(ctx.db);
    }
  });

  it("cannot pass a PayPal approval by itself: the deal stays waiting and is reported", async () => {
    const ctx = await testContext();
    try {
      // No simulated approval is available: what the engine answers when real PayPal is active.
      const withoutApproval: SeedEngine = {
        ...ENGINE,
        approveSimulatedOrder: () => Promise.reject(new Error("Resource not found")),
      };
      const result = await runShowcaseDeal(withoutApproval, ctx, planShowcase(1)[0], RUN_OPTIONS);
      expect(result).toMatchObject({ ok: false, status: "awaiting_payment", captureId: null, problem: "Resource not found" });
      expect(result.orderId).toMatch(/^SIM-O-/);
    } finally {
      await closeDb(ctx.db);
    }
  });
});

describe("missingPrerequisite", () => {
  /** The simulator's behaviour under PayPal's name, so the PayPal-only precondition can be exercised offline. */
  function labelledAsPayPal(inner: SimulatedProvider): PaymentProvider {
    return {
      kind: "paypal_sandbox",
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
    };
  }

  it("needs nothing for the simulator, and the shared demo wallet for PayPal Sandbox", async () => {
    const simulated = await testContext();
    try {
      expect(await missingPrerequisite(simulated)).toBeNull();

      const paypal: ServiceContext = { ...simulated, provider: labelledAsPayPal(new SimulatedProvider(createDbSimulatedStore(simulated.db))) };
      const missing = await missingPrerequisite(paypal);
      expect(missing).toContain("needs the shared demo wallet");
      expect(missing).toContain("x-admin-token");

      const operator = "sess_operator0000000000000000";
      await startWalletConnect(paypal, { owner: DEMO_WALLET_OWNER, appUrl: RUN_OPTIONS.appUrl, initiatedBy: operator });
      await completeWalletConnect(paypal, { owner: DEMO_WALLET_OWNER, sessionId: operator });
      expect(await missingPrerequisite(paypal)).toBeNull();
    } finally {
      await closeDb(simulated.db);
    }
  });
});
