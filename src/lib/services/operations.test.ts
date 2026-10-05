import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpsCheckRow, OpsRow } from "@/lib/api/dto";
import type { DealGraph, DealRow } from "@/lib/db";
import { auditFixture, contractFixture, moveFixture, paymentFixture, reportFixture } from "@/lib/db/test-fixtures";
import { AUDIT_EVENT_TYPES, type Mandate, type PolicyEvaluation } from "@/lib/domain/schemas";
import { BUYER_IDENTITY } from "@/lib/domain/sellers";
import { DEAL_STATUSES, DEAL_STATUS_LABEL, type DealStatus } from "@/lib/domain/status";
import { UNKNOWN_SELLER, summarize, toOpsCheckRows, toOpsPaymentEvents, toOpsRow } from "./operations";

const NOW = new Date("2026-10-06T05:00:00.000Z");
const VIEWER = "sess_viewer00000000000000000a";

const MANDATE: Mandate = {
  summary: "Three landing-page illustrations in 16:9 and 1:1",
  category: "illustration",
  deliverable: { kind: "illustration", count: 3, aspectRatios: ["16:9", "1:1"], subject: "Landing page", style: null },
  minCount: 3,
  budgetMinor: 5_000,
  deadline: "2026-10-09T09:00:00.000Z",
  revisionsWanted: 1,
  minRevisions: 1,
  notes: [],
};

function dealRow(overrides: Partial<DealRow> = {}): DealRow {
  return {
    id: "deal_ops0000001",
    code: "PACT-OPS1",
    owner: VIEWER,
    scenarioId: null,
    status: "negotiating",
    intent: "Get three landing-page illustrations for under $50 by tomorrow at 6 PM.",
    mandate: null,
    category: "illustration",
    sellerId: "northwind",
    negotiationStatus: "open",
    agreedTerms: null,
    negotiationFailure: null,
    policyEvaluation: null,
    humanDecision: null,
    priceMinor: null,
    deadline: null,
    revisionLimit: null,
    revisionsUsed: 0,
    aiDegraded: false,
    lastError: null,
    version: 0,
    lockId: null,
    lockedUntil: null,
    createdAt: "2026-10-05T23:30:00.000Z",
    updatedAt: "2026-10-06T04:00:00.000Z",
    ...overrides,
  };
}

function graphOf(deal: Partial<DealRow> = {}, rest: Partial<Omit<DealGraph, "deal">> = {}): DealGraph {
  return { deal: dealRow(deal), moves: [], signed: null, payment: null, submissions: [], reports: [], audit: [], ...rest };
}

const row = (graph: DealGraph, viewer: string | null = VIEWER): OpsRow => toOpsRow(graph, viewer, NOW);

describe("toOpsRow: stage and outcome", () => {
  const EXPECTED: Record<DealStatus, [OpsRow["stage"], OpsRow["outcome"]]> = {
    negotiating: ["negotiation", "in_progress"],
    agreed: ["negotiation", "in_progress"],
    contracted: ["contract", "in_progress"],
    awaiting_approval: ["contract", "in_progress"],
    payment_pending: ["payment", "in_progress"],
    awaiting_payment: ["payment", "in_progress"],
    authorized: ["fulfillment", "in_progress"],
    revision_required: ["fulfillment", "in_progress"],
    submitted: ["verification", "in_progress"],
    in_review: ["verification", "in_progress"],
    verified: ["verification", "in_progress"],
    rejecting: ["verification", "in_progress"],
    completed: ["settled", "captured"],
    rejected: ["closed", "voided"],
    cancelled: ["closed", "voided"],
    expired: ["closed", "voided"],
    declined: ["closed", "declined"],
    blocked: ["closed", "blocked"],
    negotiation_failed: ["closed", "no_agreement"],
    failed: ["closed", "failed"],
  };

  it.each(DEAL_STATUSES.map((status) => [status, ...EXPECTED[status]] as const))(
    "%s is stage %s with outcome %s",
    (status, stage, outcome) => {
      const mapped = row(graphOf({ status }));
      expect(mapped).toMatchObject({ status, stage, outcome, statusLabel: DEAL_STATUS_LABEL[status] });
    },
  );
});

describe("toOpsRow: identity columns", () => {
  it("takes the title from the contract, then the mandate, then the first 80 characters of the request", () => {
    const signed = contractFixture("deal_ops0000001");
    expect(row(graphOf({ mandate: MANDATE }, { signed })).title).toBe(signed.contract.title);
    expect(row(graphOf({ mandate: MANDATE })).title).toBe(MANDATE.summary);

    const short = row(graphOf({ intent: "Two banners,\n16:9 only." })).title;
    expect(short).toBe("Two banners, 16:9 only.");
    const long = row(graphOf({ intent: "An illustration of a lighthouse. ".repeat(10) })).title;
    expect(long).toHaveLength(80);
    expect(long.startsWith("An illustration of a lighthouse. An illustration")).toBe(true);
    expect(long.endsWith("…")).toBe(true);
  });

  it("names the buyer agent and reads the seller from the directory", () => {
    expect(row(graphOf({ sellerId: "pixelharbor" }))).toMatchObject({
      buyer: BUYER_IDENTITY.name,
      seller: "Pixel Harbor",
      sellerId: "pixelharbor",
      sellerTrust: "new",
    });
    expect(row(graphOf({ sellerId: "northwind" }))).toMatchObject({ seller: "Northwind Studio", sellerTrust: "established" });
  });

  it("shows an unknown or missing seller as a dash, and does not rate it as a new seller", () => {
    const unknown = row(graphOf({ sellerId: "gone-studio", status: "negotiating" }));
    expect(unknown).toMatchObject({ seller: UNKNOWN_SELLER, sellerId: "gone-studio", sellerTrust: "new" });
    expect(unknown.riskReasons).not.toContain("New seller with no settled history");

    expect(row(graphOf({ sellerId: null }))).toMatchObject({ seller: "—", sellerId: "—" });
    // A seller the directory does know as new is rated as such.
    expect(row(graphOf({ sellerId: "pixelharbor" })).riskReasons).toContain("New seller with no settled history");
  });

  it("marks the viewer's deals as mine and everything else as showcase", () => {
    expect(row(graphOf({ owner: VIEWER })).origin).toBe("mine");
    expect(row(graphOf({ owner: "system" })).origin).toBe("showcase");
    expect(row(graphOf({ owner: VIEWER }), null).origin).toBe("showcase");
    expect(row(graphOf({ owner: "system" }), null).origin).toBe("showcase");
  });

  it("buckets the deal by the UTC day it was created", () => {
    expect(row(graphOf({ createdAt: "2026-10-05T23:59:59.000Z" })).day).toBe("2026-10-05");
    expect(row(graphOf({ createdAt: "2026-10-06T00:00:00.000Z" })).day).toBe("2026-10-06");
  });
});

describe("toOpsRow: money", () => {
  const sellerOpens = moveFixture(1, {
    actor: "seller",
    action: "offer",
    terms: { priceMinor: 12_000, deadline: "2026-10-08T09:00:00.000Z", revisionLimit: 1, count: 3 },
  });
  const buyerCounters = moveFixture(2, {
    actor: "buyer",
    action: "counter",
    terms: { priceMinor: 9_000, deadline: "2026-10-08T09:00:00.000Z", revisionLimit: 1, count: 3 },
  });

  it("reports no price, no saving and no payment before a contract exists", () => {
    const mapped = row(graphOf({ status: "agreed" }, { moves: [sellerOpens, buyerCounters] }));
    expect(mapped).toMatchObject({
      priceMinor: 0,
      listPriceMinor: 12_000,
      savedMinor: 0,
      authorizedMinor: 0,
      capturedMinor: 0,
      heldMinor: 0,
      currency: "USD",
      paymentStatus: "none",
      paymentProvider: null,
      paymentMode: null,
      paypalOrderId: null,
      paypalAuthorizationId: null,
      paypalCaptureId: null,
      webhookConfirmed: false,
    });
  });

  it("takes the price from the contract and the list price from the seller's opening offer", () => {
    const signed = contractFixture("deal_ops0000001"); // 10,500
    const mapped = row(graphOf({ status: "contracted" }, { signed, moves: [sellerOpens, buyerCounters] }));
    expect(mapped).toMatchObject({ priceMinor: 10_500, listPriceMinor: 12_000, savedMinor: 1_500 });
  });

  it("never reports a negative saving, and a list price of 0 when the seller never quoted", () => {
    const signed = contractFixture("deal_ops0000001");
    const cheapOpening = moveFixture(1, {
      actor: "seller",
      action: "offer",
      terms: { priceMinor: 10_000, deadline: "2026-10-08T09:00:00.000Z", revisionLimit: 1, count: 3 },
    });
    expect(row(graphOf({}, { signed, moves: [cheapOpening] })).savedMinor).toBe(0);

    const refusal = moveFixture(1, { actor: "seller", action: "reject", terms: null });
    expect(row(graphOf({ status: "negotiation_failed" }, { moves: [refusal] })).listPriceMinor).toBe(0);
    expect(row(graphOf()).listPriceMinor).toBe(0);
  });

  it("counts money as held only while the payment is authorized", () => {
    const signed = contractFixture("deal_ops0000001");
    const held = row(graphOf({ status: "authorized" }, { signed, payment: paymentFixture({ status: "authorized" }) }));
    expect(held).toMatchObject({ authorizedMinor: 10_500, capturedMinor: 0, heldMinor: 10_500, paymentStatus: "authorized" });

    const captured = paymentFixture({ status: "captured", capturedMinor: 10_500, captureId: "CAP-1" });
    expect(row(graphOf({ status: "completed" }, { signed, payment: captured }))).toMatchObject({
      authorizedMinor: 10_500,
      capturedMinor: 10_500,
      heldMinor: 0,
      paypalCaptureId: "CAP-1",
    });

    const partial = paymentFixture({ status: "captured", capturedMinor: 5_250 });
    expect(row(graphOf({ status: "completed" }, { signed, payment: partial })).heldMinor).toBe(0);

    const voided = paymentFixture({ status: "voided" });
    expect(row(graphOf({ status: "rejected" }, { signed, payment: voided }))).toMatchObject({
      authorizedMinor: 10_500,
      heldMinor: 0,
    });
  });

  it("exposes the payment's provider, mode, ids and whether any webhook confirmed it", () => {
    const payment = paymentFixture({
      provider: "paypal_sandbox",
      mode: "delegated",
      orderId: "ORDER-1",
      authorizationId: "AUTH-1",
      webhookConfirmed: { authorized: false, captured: false, voided: true },
    });
    expect(row(graphOf({ status: "rejected" }, { payment }))).toMatchObject({
      paymentProvider: "paypal_sandbox",
      paymentMode: "delegated",
      paypalOrderId: "ORDER-1",
      paypalAuthorizationId: "AUTH-1",
      webhookConfirmed: true,
    });
    expect(row(graphOf({}, { payment: paymentFixture() })).webhookConfirmed).toBe(false);
  });
});

describe("toOpsRow: verification, negotiation, policy and people", () => {
  it("describes the latest verification report", () => {
    const first = reportFixture("deal_ops0000001", 1, { decision: "revision_required", confidence: 1, failedRuleIds: ["R2", "R3"] });
    const second = reportFixture("deal_ops0000001", 2, { decision: "capture_eligible", confidence: 0.9, failedRuleIds: [] });
    expect(row(graphOf({}, { reports: [first] }))).toMatchObject({
      verificationDecision: "revision_required",
      confidence: 1,
      failedRules: 2,
    });
    expect(row(graphOf({}, { reports: [first, second] }))).toMatchObject({
      verificationDecision: "capture_eligible",
      confidence: 0.9,
      failedRules: 0,
    });
    expect(row(graphOf())).toMatchObject({ verificationDecision: null, confidence: null, failedRules: 0 });
  });

  it("counts negotiation moves, and the moves the rules engine had to correct", () => {
    const corrected = moveFixture(2, {
      guardrails: [
        { code: "price_above_budget", detail: "Clamped to the budget." },
        { code: "deadline_too_late", detail: "Clamped to the deadline." },
      ],
    });
    const mapped = row(graphOf({}, { moves: [moveFixture(1), corrected, moveFixture(3)] }));
    expect(mapped).toMatchObject({ negotiationMoves: 3, guardrailInterventions: 1 });
  });

  it("reports the stored policy outcome and the checks that did not pass", () => {
    const policyEvaluation: PolicyEvaluation = {
      outcome: "needs_approval",
      checks: [
        { id: "category_allowed", label: "Category", outcome: "pass", detail: "ok" },
        { id: "autonomous_limit", label: "Autonomous limit", outcome: "needs_approval", detail: "above" },
        { id: "seller_trust", label: "Seller", outcome: "needs_approval", detail: "new" },
      ],
      spentTodayMinor: 0,
      evaluatedAt: "2026-10-06T01:00:00.000Z",
    };
    expect(row(graphOf({ policyEvaluation }))).toMatchObject({
      policyOutcome: "needs_approval",
      policyFlags: ["autonomous_limit", "seller_trust"],
    });
    expect(row(graphOf())).toMatchObject({ policyOutcome: null, policyFlags: [] });
  });

  it("counts human decisions as human.* audit events, not everything a human caused", () => {
    const audit = [
      auditFixture("deal_ops0000001", 1, { actor: "human", type: "intent.received" }),
      auditFixture("deal_ops0000001", 2, { actor: "human", type: "human.approved_spend" }),
      auditFixture("deal_ops0000001", 3, { actor: "paypal", type: "payment.authorized" }),
      auditFixture("deal_ops0000001", 4, { actor: "human", type: "human.released_payment" }),
    ];
    expect(row(graphOf({}, { audit })).humanDecisions).toBe(2);
  });

  it("carries revisions, the degraded flag and the risk rating with its reasons", () => {
    const signed = contractFixture("deal_ops0000001", { revisionLimit: 2 });
    const mapped = row(
      graphOf(
        { status: "in_review", revisionsUsed: 1, aiDegraded: true },
        { signed, payment: paymentFixture(), reports: [reportFixture("deal_ops0000001", 1, { decision: "human_review" })] },
      ),
    );
    expect(mapped).toMatchObject({ revisionsUsed: 1, revisionLimit: 2, aiDegraded: true, risk: "high" });
    expect(mapped.riskReasons).toContain("Waiting for human review");
    expect(row(graphOf({ status: "completed" }))).toMatchObject({ risk: "low", riskReasons: [] });
  });
});

describe("toOpsRow: deadline", () => {
  it("uses the contract deadline, before that the agreed one, before that the requested one", () => {
    const signed = contractFixture("deal_ops0000001", { deadline: "2026-10-08T09:00:00.000Z" });
    const agreedTerms = { priceMinor: 9_000, deadline: "2026-10-07T09:00:00.000Z", revisionLimit: 1, count: 3 };
    expect(row(graphOf({ mandate: MANDATE, agreedTerms }, { signed })).deadline).toBe("2026-10-08T09:00:00.000Z");
    expect(row(graphOf({ mandate: MANDATE, agreedTerms })).deadline).toBe("2026-10-07T09:00:00.000Z");
    expect(row(graphOf({ mandate: MANDATE })).deadline).toBe(MANDATE.deadline);
    expect(row(graphOf())).toMatchObject({ deadline: null, hoursToDeadline: null });
  });

  it("reports hours to the deadline to one decimal, negative once it has passed", () => {
    const at = (deadline: string): number | null => row(graphOf({ deadline })).hoursToDeadline;
    expect(at("2026-10-07T09:00:00.000Z")).toBe(28);
    expect(at("2026-10-06T05:20:00.000Z")).toBe(0.3);
    expect(at("2026-10-06T03:30:00.000Z")).toBe(-1.5);
    expect(Object.is(at("2026-10-06T04:59:00.000Z"), -0)).toBe(false);
    expect(at("2026-10-06T05:00:00.000Z")).toBe(0);
  });
});

describe("toOpsPaymentEvents", () => {
  const ids = { provider: "paypal_sandbox", orderId: "ORDER-1", authorizationId: "AUTH-1", captureId: null };

  it("returns one row per payment.* event, in order, with the amount the event states", () => {
    const audit = [
      auditFixture("deal_ops0000001", 1, { type: "contract.created", data: { amountMinor: 999 } }),
      auditFixture("deal_ops0000001", 2, { type: "payment.order_created", data: { ...ids, authorizationId: null, amountMinor: 4_700 } }),
      auditFixture("deal_ops0000001", 3, { type: "payment.approved", data: { ...ids, authorizationId: null } }),
      auditFixture("deal_ops0000001", 4, { type: "payment.authorized", data: { ...ids, amountMinor: 4_700 } }),
      auditFixture("deal_ops0000001", 5, { type: "delivery.submitted" }),
      auditFixture("deal_ops0000001", 6, { type: "payment.captured", data: { ...ids, captureId: "CAP-1", amountMinor: 4_700 } }),
    ];
    const events = toOpsPaymentEvents(graphOf({ code: "PACT-EVT1", sellerId: "northwind" }, { audit }));

    expect(events.map((event) => [event.type, event.amountMinor, event.reference])).toEqual([
      ["order_created", 4_700, "ORDER-1"],
      ["approved", 0, "ORDER-1"],
      ["authorized", 4_700, "AUTH-1"],
      ["captured", 4_700, "CAP-1"],
    ]);
    expect(events[0]).toEqual({
      id: audit[1].id,
      dealId: "deal_ops0000001",
      dealCode: "PACT-EVT1",
      at: audit[1].at,
      day: "2026-10-06",
      type: "order_created",
      amountMinor: 4_700,
      seller: "Northwind Studio",
      provider: "paypal_sandbox",
      reference: "ORDER-1",
    });
  });

  it("has a row type for every payment.* audit event the domain defines", () => {
    const paymentTypes = AUDIT_EVENT_TYPES.filter((type) => type.startsWith("payment."));
    const audit = paymentTypes.map((type, index) => auditFixture("deal_ops0000001", index + 1, { type, data: null }));
    const events = toOpsPaymentEvents(graphOf({}, { audit }));
    expect(events.map((event) => `payment.${event.type}`)).toEqual(paymentTypes);
    // No data at all: no amount, no reference, no provider to report.
    expect(events.every((event) => event.amountMinor === 0 && event.reference === null && event.provider === null)).toBe(true);
  });

  it("ignores an amount that is not a whole number of minor units, and falls back to the payment's provider", () => {
    const audit = [
      auditFixture("deal_ops0000001", 1, { type: "payment.voided", data: { amountMinor: 47.5, authorizationId: "AUTH-9" } }),
      auditFixture("deal_ops0000001", 2, { type: "payment.webhook", data: { amountMinor: "4700", provider: "elsewhere" } }),
      auditFixture("deal_ops0000001", 3, { type: "payment.reconciled", data: { orderId: "ORDER-9", captureId: "" } }),
    ];
    const events = toOpsPaymentEvents(graphOf({}, { audit, payment: paymentFixture({ provider: "simulated" }) }));
    expect(events.map((event) => [event.type, event.amountMinor, event.provider, event.reference])).toEqual([
      ["voided", 0, "simulated", "AUTH-9"],
      ["webhook", 0, "simulated", null],
      ["reconciled", 0, "simulated", "ORDER-9"],
    ]);
  });
});

describe("toOpsCheckRows", () => {
  it("flattens every check of every report, across rounds", () => {
    const check = reportFixture("deal_ops0000001", 1).checks[0];
    const first = reportFixture("deal_ops0000001", 1, {
      id: "rep_first",
      checks: [check, { ...check, ruleId: "R2", kind: "aspect_ratio_coverage", result: "fail", required: true }],
    });
    const second = reportFixture("deal_ops0000001", 2, {
      id: "rep_second",
      checks: [{ ...check, ruleId: "R5", kind: "brief_adherence", evaluator: "ai", result: "uncertain", confidence: 0.4 }],
    });
    const rows = toOpsCheckRows(graphOf({ code: "PACT-CHK1", sellerId: "quickdraw" }, { reports: [first, second] }));

    expect(rows.map((item) => [item.id, item.round, item.ruleId, item.result])).toEqual([
      ["rep_first:R1", 1, "R1", "pass"],
      ["rep_first:R2", 1, "R2", "fail"],
      ["rep_second:R5", 2, "R5", "uncertain"],
    ]);
    expect(rows[2]).toEqual({
      id: "rep_second:R5",
      dealId: "deal_ops0000001",
      dealCode: "PACT-CHK1",
      round: 2,
      ruleId: "R5",
      kind: "brief_adherence",
      condition: check.condition,
      evaluator: "ai",
      result: "uncertain",
      confidence: 0.4,
      required: true,
      seller: "Quickdraw Collective",
      at: second.createdAt,
    });
    expect(toOpsCheckRows(graphOf())).toEqual([]);
  });
});

describe("summarize", () => {
  /** A deal in the given state, with its ops row and check rows. */
  function ledgerEntry(
    id: string,
    deal: Partial<DealRow>,
    rest: Partial<Omit<DealGraph, "deal">> = {},
  ): { row: OpsRow; checks: OpsCheckRow[] } {
    const graph = graphOf({ id, ...deal }, rest);
    return { row: row(graph), checks: toOpsCheckRows(graph) };
  }

  const passed = (dealId: string, round = 1) => reportFixture(dealId, round, { decision: "capture_eligible" });
  const failed = (dealId: string, round = 1) => reportFixture(dealId, round, { decision: "revision_required", failedRuleIds: ["R1"] });

  const entries = [
    // Captured in full on the first delivery.
    ledgerEntry("deal_a", { status: "completed" }, {
      payment: paymentFixture({ status: "captured", authorizedMinor: 4_700, capturedMinor: 4_700 }),
      reports: [passed("deal_a")],
    }),
    // Captured after a revision: the first delivery failed.
    ledgerEntry("deal_b", { status: "completed" }, {
      payment: paymentFixture({ status: "captured", authorizedMinor: 2_700, capturedMinor: 2_700 }),
      reports: [failed("deal_b"), passed("deal_b", 2)],
    }),
    // A human released half: the other half went back to the payer.
    ledgerEntry("deal_c", { status: "completed" }, {
      payment: paymentFixture({ status: "captured", authorizedMinor: 1_800, capturedMinor: 900 }),
      reports: [reportFixture("deal_c", 1, { decision: "human_review" })],
    }),
    // Rejected: the whole hold was released.
    ledgerEntry("deal_d", { status: "rejected" }, {
      payment: paymentFixture({ status: "voided", authorizedMinor: 1_800, capturedMinor: 0 }),
      reports: [reportFixture("deal_d", 1, { decision: "human_review" })],
    }),
    // Waiting for a human with the money held.
    ledgerEntry("deal_e", { status: "in_review" }, {
      payment: paymentFixture({ status: "authorized", authorizedMinor: 18_000, capturedMinor: 0 }),
      reports: [reportFixture("deal_e", 1, { decision: "human_review" })],
    }),
    // Held, nothing delivered yet.
    ledgerEntry("deal_f", { status: "authorized" }, {
      payment: paymentFixture({ status: "authorized", authorizedMinor: 3_000, capturedMinor: 0 }),
    }),
    // The authorization lapsed.
    ledgerEntry("deal_g", { status: "expired" }, {
      payment: paymentFixture({ status: "expired", authorizedMinor: 2_000, capturedMinor: 0 }),
    }),
    // Waiting for spend approval: no payment at all.
    ledgerEntry("deal_h", { status: "awaiting_approval" }),
    // The payer never approved: an order, but no money was ever held.
    ledgerEntry("deal_i", { status: "cancelled" }, {
      payment: paymentFixture({ status: "voided", authorizedMinor: 0, capturedMinor: 0, authorizationId: null }),
    }),
  ];
  const rows = entries.map((entry) => entry.row);
  const checks = entries.flatMap((entry) => entry.checks);

  it("adds up authorized, captured, held and released money", () => {
    const totals = summarize(rows, checks);
    expect(totals).toMatchObject({
      deals: 9,
      authorizedMinor: 4_700 + 2_700 + 1_800 + 1_800 + 18_000 + 3_000 + 2_000,
      capturedMinor: 4_700 + 2_700 + 900,
      heldMinor: 18_000 + 3_000,
      // Half of deal_c, all of deal_d (voided) and all of deal_g (expired).
      releasedMinor: 900 + 1_800 + 2_000,
    });
    expect(totals.authorizedMinor).toBe(totals.capturedMinor + totals.heldMinor + totals.releasedMinor);
  });

  it("counts deals waiting for a person: spend approval or delivery review", () => {
    expect(summarize(rows, checks).pendingHumanReview).toBe(2);
  });

  it("measures first deliveries: a deal captured after a revision still failed its first verification", () => {
    const totals = summarize(rows, checks);
    // Five deals reached a first report (a, b, c, d, e); only deal_a passed it.
    expect(totals.verificationFailureRate).toBe(0.8);
    expect(totals.firstPassRate).toBe(0.2);
  });

  it("rounds the rates to four decimals and keeps them complementary", () => {
    const three = [entries[0], entries[1], entries[4]];
    const totals = summarize(three.map((entry) => entry.row), three.flatMap((entry) => entry.checks));
    expect(totals.verificationFailureRate).toBe(0.6667);
    expect(totals.firstPassRate).toBe(0.3333);
  });

  it("reports zero rates, not a perfect score, when nothing has been verified", () => {
    const unverified = [entries[5], entries[7]];
    expect(summarize(unverified.map((entry) => entry.row), [])).toMatchObject({
      deals: 2,
      verificationFailureRate: 0,
      firstPassRate: 0,
    });
    expect(summarize([], [])).toEqual({
      deals: 0,
      authorizedMinor: 0,
      capturedMinor: 0,
      heldMinor: 0,
      releasedMinor: 0,
      pendingHumanReview: 0,
      verificationFailureRate: 0,
      firstPassRate: 0,
    });
  });
});

describe("the published API description", () => {
  interface ObjectSchema {
    properties: Record<string, ObjectSchema>;
    required: string[];
    items?: ObjectSchema;
  }
  const document = JSON.parse(readFileSync(path.join(process.cwd(), "public", "openapi.json"), "utf8")) as {
    components: { schemas: Record<string, ObjectSchema> };
  };
  const { schemas } = document.components;
  const fieldsOf = (schema: ObjectSchema) => ({ properties: Object.keys(schema.properties).sort(), required: [...schema.required].sort() });
  const allRequired = (value: object) => {
    const fields = Object.keys(value).sort();
    return { properties: fields, required: fields };
  };

  it("lists exactly the columns of the three operations data sources and the totals", () => {
    const graph = graphOf(
      { status: "completed" },
      {
        payment: paymentFixture({ status: "captured", capturedMinor: 10_500 }),
        reports: [reportFixture("deal_ops0000001", 1)],
        audit: [auditFixture("deal_ops0000001", 1, { type: "payment.captured", data: { amountMinor: 10_500 } })],
      },
    );
    expect(fieldsOf(schemas.OpsRow)).toEqual(allRequired(row(graph)));
    expect(fieldsOf(schemas.OpsPaymentEvent)).toEqual(allRequired(toOpsPaymentEvents(graph)[0]));
    expect(fieldsOf(schemas.OpsCheckRow)).toEqual(allRequired(toOpsCheckRows(graph)[0]));
    expect(fieldsOf(schemas.OpsSnapshot)).toEqual({
      properties: ["checks", "deals", "generatedAt", "paymentEvents", "totals"],
      required: ["checks", "deals", "generatedAt", "paymentEvents", "totals"],
    });
    expect(fieldsOf(schemas.OpsSnapshot.properties.totals)).toEqual(allRequired(summarize([], [])));
  });
});
