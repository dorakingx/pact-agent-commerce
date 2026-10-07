import { describe, expect, it } from "vitest";
import type { OpsCheckRow, OpsRow, OpsSnapshot } from "../api/dto";
import { SELLERS } from "../domain/sellers";
import { DEAL_STATUSES, HUMAN_STATUSES, TERMINAL_STATUSES, type DealStatus } from "../domain/status";
import {
  DEFAULT_LEDGER_FILTER,
  DEMO_FAULT_BY_SELLER,
  EMPTY_CROSS_FILTER,
  GROUP_BYS,
  LEDGER_LAYOUT_VERSION,
  MAX_VOLUME_DAYS,
  OUTCOME_ORDER,
  SEGMENTS,
  arrangeGrouped,
  buildGroups,
  buildKpis,
  checksByRuleKind,
  compareGroupKeys,
  crossFilterChips,
  csvText,
  dayLabel,
  deadlineState,
  deliverableLine,
  demoFaultOf,
  formatMoneyCompact,
  formatRate,
  groupKeyOf,
  groupLabel,
  inSegment,
  indexChecks,
  isLedgerFilterActive,
  minorToDecimal,
  outcomeBreakdown,
  parseLayout,
  parseOpsView,
  passesLedgerFilter,
  policyFlagLabel,
  railLabel,
  ruleKindLabel,
  segmentCounts,
  sellerVolume,
  serializeLayout,
  sortChecksForReview,
  sumLedger,
  tallyChecks,
  tallyLabel,
  toggleCrossFilter,
  volumeByDay,
  type LedgerFilter,
  type StoredLayout,
} from "./ops-derive";

/** Outcome each status maps to on the server (services/operations.ts); only what these tests need. */
function outcomeFor(status: DealStatus): OpsRow["outcome"] {
  if (status === "completed") return "captured";
  if (status === "rejected" || status === "cancelled" || status === "expired") return "voided";
  if (status === "declined") return "declined";
  if (status === "blocked") return "blocked";
  if (status === "negotiation_failed") return "no_agreement";
  if (status === "failed") return "failed";
  return "in_progress";
}

let sequence = 0;
function row(overrides: Partial<OpsRow> = {}): OpsRow {
  sequence += 1;
  const status = overrides.status ?? "completed";
  return {
    id: `deal_${sequence}`,
    code: `PACT-${sequence}`,
    title: `Deal ${sequence}`,
    status,
    statusLabel: status,
    stage: "settled",
    outcome: outcomeFor(status),
    buyer: "Buyer Agent",
    seller: "Northwind Studio",
    sellerId: "northwind",
    sellerTrust: "established",
    category: "illustration",
    scenarioId: null,
    origin: "mine",
    priceMinor: 4700,
    listPriceMinor: 5300,
    savedMinor: 600,
    authorizedMinor: 4700,
    capturedMinor: 4700,
    heldMinor: 0,
    currency: "USD",
    paymentStatus: "captured",
    paymentProvider: "simulated",
    paymentMode: "interactive",
    paypalOrderId: "ORDER",
    paypalAuthorizationId: "AUTH",
    paypalCaptureId: "CAPTURE",
    webhookConfirmed: false,
    verificationDecision: "capture_eligible",
    confidence: 0.95,
    failedRules: 0,
    revisionsUsed: 0,
    revisionLimit: 1,
    negotiationMoves: 5,
    guardrailInterventions: 0,
    policyOutcome: "allow",
    policyFlags: [],
    humanDecisions: 0,
    risk: "low",
    riskReasons: [],
    aiDegraded: false,
    deadline: "2026-10-07T09:00:00.000Z",
    hoursToDeadline: 30,
    createdAt: "2026-10-05T21:00:00.000Z",
    updatedAt: "2026-10-05T21:10:00.000Z",
    day: "2026-10-05",
    ...overrides,
  };
}

function check(dealId: string, kind: string, result: OpsCheckRow["result"], round = 1): OpsCheckRow {
  return {
    id: `${dealId}:${kind}:${round}`,
    dealId,
    dealCode: dealId,
    round,
    ruleId: "R1",
    kind,
    condition: kind,
    evaluator: "deterministic",
    result,
    confidence: 1,
    required: true,
    seller: "Northwind Studio",
    at: "2026-10-05T21:05:00.000Z",
  };
}

const held = (overrides: Partial<OpsRow> = {}) =>
  row({ status: "authorized", paymentStatus: "authorized", capturedMinor: 0, heldMinor: 4700, verificationDecision: null, confidence: null, ...overrides });

describe("parseOpsView", () => {
  it("accepts the two views and falls back to the dashboard for anything else", () => {
    expect(parseOpsView("ledger")).toBe("ledger");
    expect(parseOpsView("dashboard")).toBe("dashboard");
    expect(parseOpsView(null)).toBe("dashboard");
    expect(parseOpsView(undefined)).toBe("dashboard");
    expect(parseOpsView("LEDGER")).toBe("dashboard");
    expect(parseOpsView(["ledger", "dashboard"])).toBe("dashboard");
    expect(parseOpsView("__proto__")).toBe("dashboard");
  });
});

describe("labels", () => {
  it("names every known rule kind and policy check, and still reads as words for an unknown one", () => {
    expect(ruleKindLabel("aspect_ratio_coverage")).toBe("Aspect ratios");
    expect(ruleKindLabel("no_embedded_instructions")).toBe("Hidden instructions");
    expect(ruleKindLabel("some_new_rule")).toBe("Some new rule");
    expect(policyFlagLabel("autonomous_limit")).toBe("Autonomous limit");
    expect(policyFlagLabel("seller_trust")).toBe("New seller");
    expect(policyFlagLabel("velocity-check")).toBe("Velocity check");
  });

  it("does not resolve labels through the object prototype", () => {
    expect(ruleKindLabel("constructor")).toBe("Constructor");
    expect(groupLabel("status", "toString")).toBe("ToString");
    expect(demoFaultOf("constructor")).toBeNull();
  });

  it("describes the payment rail honestly, and only once there is one", () => {
    expect(railLabel({ paymentProvider: "simulated", paymentMode: "interactive" })).toBe("Simulated · Interactive approval");
    expect(railLabel({ paymentProvider: "paypal_sandbox", paymentMode: "delegated" })).toBe("PayPal Sandbox · Delegated wallet");
    expect(railLabel({ paymentProvider: null, paymentMode: null })).toBeNull();
  });
});

describe("demo-fault sellers", () => {
  it("lists exactly the sellers the directory marks as controlled faults", () => {
    const expected = Object.fromEntries(SELLERS.filter((seller) => seller.behavior !== "reliable").map((seller) => [seller.id, seller.behavior]));
    expect(DEMO_FAULT_BY_SELLER).toEqual(expected);
  });

  it("returns null for reliable and unknown sellers", () => {
    expect(demoFaultOf("northwind")).toBeNull();
    expect(demoFaultOf("nobody")).toBeNull();
    expect(demoFaultOf("quickdraw")).toBe("omits_variant");
  });
});

describe("segments", () => {
  it("puts every status in 'all' and in exactly one of in-progress / captured / closed", () => {
    for (const status of DEAL_STATUSES) {
      const deal = row({ status });
      expect(inSegment(deal, "all")).toBe(true);
      const buckets = (["in_progress", "captured", "closed"] as const).filter((segment) => inSegment(deal, segment));
      expect(buckets, status).toHaveLength(1);
    }
  });

  it("treats the three human gates, and nothing else, as needing a human", () => {
    for (const status of DEAL_STATUSES) {
      expect(inSegment(row({ status }), "needs_human"), status).toBe((HUMAN_STATUSES as readonly string[]).includes(status));
    }
  });

  it("files every terminal status other than a capture under 'closed'", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(inSegment(row({ status }), "closed"), status).toBe(status !== "completed");
    }
  });

  it("flags medium and high risk as at risk", () => {
    expect(inSegment(row({ risk: "low" }), "at_risk")).toBe(false);
    expect(inSegment(row({ risk: "medium" }), "at_risk")).toBe(true);
    expect(inSegment(row({ risk: "high" }), "at_risk")).toBe(true);
  });

  it("counts overlapping segments independently", () => {
    const rows = [row(), row({ status: "in_review", risk: "high" }), row({ status: "authorized", risk: "medium" }), row({ status: "rejected" })];
    expect(segmentCounts(rows)).toEqual({ all: 4, in_progress: 2, needs_human: 1, captured: 1, closed: 1, at_risk: 2 });
    expect(segmentCounts([])).toEqual({ all: 0, in_progress: 0, needs_human: 0, captured: 0, closed: 0, at_risk: 0 });
    expect(Object.keys(segmentCounts([]))).toEqual([...SEGMENTS]);
  });
});

describe("ledger filter", () => {
  const filter = (overrides: Partial<LedgerFilter>): LedgerFilter => ({ ...DEFAULT_LEDGER_FILTER, ...overrides });

  it("is inactive by default and active as soon as anything narrows the ledger", () => {
    expect(isLedgerFilterActive(DEFAULT_LEDGER_FILTER)).toBe(false);
    expect(isLedgerFilterActive(filter({ segment: "captured" }))).toBe(true);
    expect(isLedgerFilterActive(filter({ onlyMine: true }))).toBe(true);
    expect(isLedgerFilterActive(filter({ cross: { ...EMPTY_CROSS_FILTER, day: "2026-10-05" } }))).toBe(true);
  });

  it("lets everything through by default", () => {
    expect(passesLedgerFilter(row({ origin: "showcase", status: "failed" }), DEFAULT_LEDGER_FILTER, new Map())).toBe(true);
  });

  it("combines the segment, 'only mine' and every cross-filter with AND", () => {
    const deal = row({ seller: "Lingua Labs", day: "2026-10-04" });
    const checks = indexChecks([check(deal.id, "word_count", "fail"), check(deal.id, "word_count", "pass", 2)]);
    const all = filter({
      segment: "captured",
      onlyMine: true,
      cross: { seller: "Lingua Labs", outcome: "captured", day: "2026-10-04", check: { kind: "word_count", result: "fail" } },
    });
    expect(passesLedgerFilter(deal, all, checks)).toBe(true);
    expect(passesLedgerFilter({ ...deal, origin: "showcase" }, all, checks)).toBe(false);
    expect(passesLedgerFilter({ ...deal, seller: "Northwind Studio" }, all, checks)).toBe(false);
    expect(passesLedgerFilter({ ...deal, day: "2026-10-05" }, all, checks)).toBe(false);
    expect(passesLedgerFilter({ ...deal, status: "rejected", outcome: "voided" }, all, checks)).toBe(false);
    expect(passesLedgerFilter(deal, filter({ cross: { ...EMPTY_CROSS_FILTER, check: { kind: "word_count", result: "uncertain" } } }), checks)).toBe(false);
  });

  it("matches a check filter against every verification round, and never against a deal without checks", () => {
    const revised = row();
    const untouched = row();
    const checks = indexChecks([check(revised.id, "aspect_ratio_coverage", "fail", 1), check(revised.id, "aspect_ratio_coverage", "pass", 2)]);
    const failed = filter({ cross: { ...EMPTY_CROSS_FILTER, check: { kind: "aspect_ratio_coverage", result: "fail" } } });
    expect(passesLedgerFilter(revised, failed, checks)).toBe(true);
    expect(passesLedgerFilter(untouched, failed, checks)).toBe(false);
  });

  it("names the active cross-filters as chips in a fixed order", () => {
    expect(crossFilterChips(EMPTY_CROSS_FILTER)).toEqual([]);
    expect(
      crossFilterChips({ day: "2026-10-05", check: { kind: "deadline", result: "uncertain" }, outcome: "voided", seller: "Pixel Harbor" }),
    ).toEqual([
      { key: "seller", label: "Seller: Pixel Harbor" },
      { key: "outcome", label: "Outcome: Voided" },
      { key: "check", label: "Check: Deadline uncertain" },
      { key: "day", label: "Day: Oct 5" },
    ]);
  });

  it("toggles a cross-filter off when the same value is chosen again, and replaces a different one", () => {
    const bySeller = toggleCrossFilter(EMPTY_CROSS_FILTER, "seller", "Lingua Labs");
    expect(bySeller.seller).toBe("Lingua Labs");
    expect(toggleCrossFilter(bySeller, "seller", "Lingua Labs").seller).toBeNull();
    expect(toggleCrossFilter(bySeller, "seller", "Pixel Harbor").seller).toBe("Pixel Harbor");

    const byCheck = toggleCrossFilter(bySeller, "check", { kind: "deadline", result: "fail" });
    expect(byCheck).toEqual({ ...bySeller, check: { kind: "deadline", result: "fail" } });
    // A new object with the same kind and result is still "the same value".
    expect(toggleCrossFilter(byCheck, "check", { kind: "deadline", result: "fail" }).check).toBeNull();
    expect(toggleCrossFilter(byCheck, "check", { kind: "deadline", result: "pass" }).check).toEqual({ kind: "deadline", result: "pass" });
    expect(EMPTY_CROSS_FILTER).toEqual({ seller: null, outcome: null, day: null, check: null });
  });
});

describe("grouping", () => {
  it("orders statuses by lifecycle, risk by urgency, outcomes by their reading order and sellers A–Z", () => {
    expect(["completed", "negotiating", "in_review"].sort((a, b) => compareGroupKeys("status", a, b))).toEqual(["negotiating", "in_review", "completed"]);
    expect(["low", "high", "medium"].sort((a, b) => compareGroupKeys("risk", a, b))).toEqual(["high", "medium", "low"]);
    expect(["failed", "captured", "in_progress"].sort((a, b) => compareGroupKeys("outcome", a, b))).toEqual(["in_progress", "captured", "failed"]);
    expect(["Pixel Harbor", "Lingua Labs", "Northwind Studio"].sort((a, b) => compareGroupKeys("seller", a, b))).toEqual([
      "Lingua Labs",
      "Northwind Studio",
      "Pixel Harbor",
    ]);
  });

  it("sorts keys it does not know after the known ones, deterministically", () => {
    expect(["zeta", "completed", "alpha"].sort((a, b) => compareGroupKeys("status", a, b))).toEqual(["completed", "alpha", "zeta"]);
    expect(compareGroupKeys("risk", "high", "high")).toBe(0);
  });

  it("reads the group key and label for every grouping", () => {
    const deal = row({ status: "in_review", seller: "Pixel Harbor", risk: "high" });
    expect(groupKeyOf(deal, "status")).toBe("in_review");
    expect(groupKeyOf(deal, "seller")).toBe("Pixel Harbor");
    expect(groupKeyOf(deal, "outcome")).toBe("in_progress");
    expect(groupKeyOf(deal, "risk")).toBe("high");
    expect(groupLabel("status", "in_review")).toBe("Human review required");
    expect(groupLabel("seller", "Pixel Harbor")).toBe("Pixel Harbor");
    expect(groupLabel("outcome", "no_agreement")).toBe("No agreement");
    expect(groupLabel("risk", "high")).toBe("High risk");
    expect(GROUP_BYS[0]).toBe("none");
  });

  it("summarises each group with its count and money sums, in display order", () => {
    const rows = [
      row({ seller: "Pixel Harbor", priceMinor: 2000, authorizedMinor: 2000, capturedMinor: 0 }),
      row({ seller: "Lingua Labs", priceMinor: 18200, authorizedMinor: 18200, capturedMinor: 18200 }),
      row({ seller: "Lingua Labs", priceMinor: 17500, authorizedMinor: 0, capturedMinor: 0 }),
    ];
    expect(buildGroups(rows, "seller")).toEqual([
      { key: "Lingua Labs", label: "Lingua Labs", count: 2, priceMinor: 35700, authorizedMinor: 18200, capturedMinor: 18200 },
      { key: "Pixel Harbor", label: "Pixel Harbor", count: 1, priceMinor: 2000, authorizedMinor: 2000, capturedMinor: 0 },
    ]);
    expect(buildGroups([], "status")).toEqual([]);
  });

  describe("arrangeGrouped", () => {
    interface Item {
      id: string;
      header: boolean;
      group: string;
    }
    const header = (group: string): Item => ({ id: `h:${group}`, header: true, group });
    const member = (id: string, group: string): Item => ({ id, header: false, group });
    const describeItem = (item: Item) => ({ header: item.header, group: item.group });
    const alphabetical = (a: string, b: string) => a.localeCompare(b);
    const ids = (items: Item[]) => items.map((item) => item.id);

    it("puts each header before its members and keeps the members' incoming order", () => {
      const items = [member("b2", "b"), member("a1", "a"), header("a"), member("b1", "b"), header("b"), member("a2", "a")];
      expect(ids(arrangeGrouped(items, describeItem, alphabetical, new Set()))).toEqual(["h:a", "a1", "a2", "h:b", "b2", "b1"]);
    });

    it("drops the header of a group the filters emptied", () => {
      const items = [header("a"), header("b"), member("b1", "b")];
      expect(ids(arrangeGrouped(items, describeItem, alphabetical, new Set()))).toEqual(["h:b", "b1"]);
    });

    it("hides the members of a collapsed group but keeps its header", () => {
      const items = [header("a"), member("a1", "a"), header("b"), member("b1", "b")];
      expect(ids(arrangeGrouped(items, describeItem, alphabetical, new Set(["a"])))).toEqual(["h:a", "h:b", "b1"]);
    });

    it("never hides a member whose header is missing, even if its group is marked collapsed", () => {
      const items = [member("a1", "a"), header("b"), member("b1", "b")];
      expect(ids(arrangeGrouped(items, describeItem, alphabetical, new Set(["a", "b"])))).toEqual(["a1", "h:b"]);
    });

    it("returns a new array and leaves the input untouched", () => {
      const items = [member("a1", "a"), header("a")];
      const arranged = arrangeGrouped(items, describeItem, alphabetical, new Set());
      expect(arranged).not.toBe(items);
      expect(ids(items)).toEqual(["a1", "h:a"]);
      expect(arrangeGrouped([], describeItem, alphabetical, new Set())).toEqual([]);
    });
  });
});

describe("totals", () => {
  it("sums every money column over exactly the given rows", () => {
    const rows = [row(), held({ priceMinor: 2600, listPriceMinor: 3000, savedMinor: 400, authorizedMinor: 2600, heldMinor: 2600 })];
    expect(sumLedger(rows)).toEqual({
      count: 2,
      priceMinor: 7300,
      listPriceMinor: 8300,
      savedMinor: 1000,
      authorizedMinor: 7300,
      capturedMinor: 4700,
      heldMinor: 2600,
    });
  });

  it("is all zeros for an empty view and keeps amounts as integers", () => {
    expect(sumLedger([])).toEqual({ count: 0, priceMinor: 0, listPriceMinor: 0, savedMinor: 0, authorizedMinor: 0, capturedMinor: 0, heldMinor: 0 });
    const totals = sumLedger([row({ priceMinor: 1 }), row({ priceMinor: 2 }), row({ priceMinor: 3 })]);
    expect(Number.isInteger(totals.priceMinor)).toBe(true);
    expect(totals.priceMinor).toBe(6);
  });
});

describe("buildKpis", () => {
  const totals: OpsSnapshot["totals"] = {
    deals: 8,
    authorizedMinor: 32300,
    capturedMinor: 25700,
    heldMinor: 4600,
    releasedMinor: 2000,
    pendingHumanReview: 2,
    verificationFailureRate: 0.6,
    firstPassRate: 0.4,
  };

  it("returns the six figures in the order of the strip, each with a caption", () => {
    const kpis = buildKpis({ totals, deals: [row(), row({ verificationDecision: null })] });
    expect(kpis.map((kpi) => kpi.id)).toEqual(["deals", "held", "captured", "released", "review", "firstPass"]);
    expect(kpis.map((kpi) => kpi.value)).toEqual([8, 4600, 25700, 2000, 2, 0.4]);
    expect(kpis.map((kpi) => kpi.kind)).toEqual(["count", "money", "money", "money", "count", "percent"]);
    for (const kpi of kpis) expect(kpi.caption.length, kpi.id).toBeGreaterThan(10);
    expect(kpis[1]?.caption).toContain("$323.00");
    expect(kpis[5]?.caption).toContain("1 verified");
  });

  it("reports the first-pass rate as unknown, not 0%, before any delivery was verified", () => {
    const kpis = buildKpis({ totals: { ...totals, firstPassRate: 0 }, deals: [row({ verificationDecision: null })] });
    const firstPass = kpis.find((kpi) => kpi.id === "firstPass");
    expect(firstPass?.value).toBeNull();
    expect(firstPass?.caption).toBe("No delivery has been verified yet");
    expect(formatRate(firstPass?.value ?? null)).toBe("—");
  });

  it("never uses the word the product avoids", () => {
    const text = buildKpis({ totals, deals: [] })
      .map((kpi) => `${kpi.label} ${kpi.caption}`)
      .join(" ");
    expect(text.toLowerCase()).not.toContain("escrow");
  });
});

describe("chart series", () => {
  it("sums authorized and captured per seller, largest first, without sellers that have no payment", () => {
    const rows = [
      row({ seller: "Lingua Labs", authorizedMinor: 18200, capturedMinor: 18200 }),
      row({ seller: "Northwind Studio", authorizedMinor: 4800, capturedMinor: 4800 }),
      row({ seller: "Lingua Labs", authorizedMinor: 0, capturedMinor: 0 }),
      row({ seller: "Pixel Harbor", authorizedMinor: 0, capturedMinor: 0 }),
    ];
    expect(sellerVolume(rows)).toEqual([
      { seller: "Lingua Labs", authorizedMinor: 18200, capturedMinor: 18200, deals: 2 },
      { seller: "Northwind Studio", authorizedMinor: 4800, capturedMinor: 4800, deals: 1 },
    ]);
    expect(sellerVolume([])).toEqual([]);
  });

  it("breaks ties between sellers alphabetically, so the chart does not reshuffle between refreshes", () => {
    const rows = [row({ seller: "Zed", authorizedMinor: 100 }), row({ seller: "Abe", authorizedMinor: 100 })];
    expect(sellerVolume(rows).map((datum) => datum.seller)).toEqual(["Abe", "Zed"]);
  });

  it("counts deals per outcome in display order and omits outcomes with no deals", () => {
    const rows = [row({ status: "rejected" }), row(), row({ status: "authorized" }), row()];
    expect(outcomeBreakdown(rows)).toEqual([
      { outcome: "in_progress", label: "In progress", count: 1 },
      { outcome: "captured", label: "Captured", count: 2 },
      { outcome: "voided", label: "Voided", count: 1 },
    ]);
    expect(outcomeBreakdown([])).toEqual([]);
    expect(OUTCOME_ORDER).toHaveLength(7);
  });

  it("tallies check results per rule kind for the given deals only, worst first", () => {
    const checks = [
      check("a", "deliverable_count", "pass"),
      check("a", "aspect_ratio_coverage", "fail"),
      check("a", "aspect_ratio_coverage", "pass", 2),
      check("b", "deliverable_count", "pass"),
      check("b", "brief_adherence", "uncertain"),
      check("hidden", "deliverable_count", "fail"),
    ];
    expect(checksByRuleKind(checks, new Set(["a", "b"]))).toEqual([
      { kind: "aspect_ratio_coverage", label: "Aspect ratios", pass: 1, fail: 1, uncertain: 0 },
      { kind: "brief_adherence", label: "Brief adherence", pass: 0, fail: 0, uncertain: 1 },
      { kind: "deliverable_count", label: "Deliverable count", pass: 2, fail: 0, uncertain: 0 },
    ]);
    expect(checksByRuleKind(checks, new Set())).toEqual([]);
  });

  it("buckets volume by day, oldest first, and keeps only the most recent days", () => {
    const rows = [
      row({ day: "2026-10-05", authorizedMinor: 100, capturedMinor: 100 }),
      row({ day: "2026-10-03", authorizedMinor: 300, capturedMinor: 0 }),
      row({ day: "2026-10-05", authorizedMinor: 50, capturedMinor: 0 }),
    ];
    expect(volumeByDay(rows)).toEqual([
      { day: "2026-10-03", label: "Oct 3", authorizedMinor: 300, capturedMinor: 0, deals: 1 },
      { day: "2026-10-05", label: "Oct 5", authorizedMinor: 150, capturedMinor: 100, deals: 2 },
    ]);
    const month = Array.from({ length: 20 }, (_, index) => row({ day: `2026-09-${String(index + 1).padStart(2, "0")}` }));
    const days = volumeByDay(month);
    expect(days).toHaveLength(MAX_VOLUME_DAYS);
    expect(days[0]?.day).toBe("2026-09-07");
    expect(days.at(-1)?.day).toBe("2026-09-20");
  });

  it("labels a UTC day bucket without shifting it into another day", () => {
    expect(dayLabel("2026-10-05")).toBe("Oct 5");
    expect(dayLabel("2026-01-31")).toBe("Jan 31");
    expect(dayLabel("2026-13-01")).toBe("2026-13-01");
    expect(dayLabel("not a day")).toBe("not a day");
  });
});

describe("deadlineState", () => {
  it("counts down for an open deal and highlights the last 24 hours", () => {
    expect(deadlineState(held({ hoursToDeadline: 71.9 }))).toEqual({ relative: "in 3 d", urgency: "none" });
    expect(deadlineState(held({ hoursToDeadline: 35 }))).toEqual({ relative: "in 35 h", urgency: "none" });
    expect(deadlineState(held({ hoursToDeadline: 14.2 }))).toEqual({ relative: "in 14 h", urgency: "soon" });
    expect(deadlineState(held({ hoursToDeadline: 0.5 }))).toEqual({ relative: "in 30 min", urgency: "soon" });
    expect(deadlineState(held({ hoursToDeadline: 0.001 }))).toEqual({ relative: "in 1 min", urgency: "soon" });
  });

  it("marks an open deal past its deadline as overdue", () => {
    expect(deadlineState(held({ hoursToDeadline: 0 }))).toEqual({ relative: "overdue", urgency: "overdue" });
    expect(deadlineState(held({ hoursToDeadline: -12 }))).toEqual({ relative: "overdue", urgency: "overdue" });
  });

  it("shows no countdown once a deal has ended, however late it was", () => {
    expect(deadlineState(row({ status: "completed", hoursToDeadline: -5 }))).toEqual({ relative: null, urgency: "none" });
    expect(deadlineState(row({ status: "rejected", hoursToDeadline: 2 }))).toEqual({ relative: null, urgency: "none" });
  });

  it("shows nothing without a deadline", () => {
    expect(deadlineState(held({ deadline: null, hoursToDeadline: null }))).toEqual({ relative: null, urgency: "none" });
  });
});

describe("formatting", () => {
  it("writes minor units as a plain decimal", () => {
    expect(minorToDecimal(4700)).toBe("47.00");
    expect(minorToDecimal(5)).toBe("0.05");
    expect(minorToDecimal(0)).toBe("0.00");
    expect(minorToDecimal(123456)).toBe("1234.56");
    expect(minorToDecimal(-250)).toBe("-2.50");
  });

  it("formats axis-sized money", () => {
    expect(formatMoneyCompact(0)).toBe("$0");
    expect(formatMoneyCompact(4700)).toBe("$47");
    expect(formatMoneyCompact(99_949)).toBe("$999");
    expect(formatMoneyCompact(120_000)).toBe("$1.2k");
    expect(formatMoneyCompact(1_500_000)).toBe("$15k");
    expect(formatMoneyCompact(-20_000)).toBe("-$200");
  });

  it("formats a rate, clamps it, and shows an unknown rate as a dash", () => {
    expect(formatRate(0.4)).toBe("40%");
    expect(formatRate(1)).toBe("100%");
    expect(formatRate(1.4)).toBe("100%");
    expect(formatRate(-1)).toBe("0%");
    expect(formatRate(null)).toBe("—");
    expect(formatRate(Number.NaN)).toBe("—");
  });

  it("neutralises spreadsheet formulas and line breaks in CSV text", () => {
    expect(csvText("3 illustrations · landing page")).toBe("3 illustrations · landing page");
    expect(csvText('=HYPERLINK("https://evil.example","x")')).toBe(`'=HYPERLINK("https://evil.example","x")`);
    expect(csvText("+1 banner")).toBe("'+1 banner");
    expect(csvText("-2 revisions")).toBe("'-2 revisions");
    expect(csvText("@mention")).toBe("'@mention");
    expect(csvText("  =SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvText("line one\r\nline\ttwo")).toBe("line one line two");
    expect(csvText("")).toBe("");
  });
});

describe("deal inspector derivations", () => {
  it("describes what a contract promises in one line", () => {
    expect(deliverableLine({ kind: "illustration", count: 3, aspectRatios: ["16:9", "1:1"], subject: "landing page", style: null })).toBe(
      "3 illustrations · 16:9 and 1:1",
    );
    expect(
      deliverableLine({ kind: "copy", count: 1, languages: ["en", "ja"], minWords: 80, maxWords: 120, subject: "espresso machines", tone: null }),
    ).toBe("1 copy piece · English and Japanese · 80–120 words each");
  });

  it("tallies check results and never hides a failure behind the passes", () => {
    const checks = [{ result: "pass" }, { result: "fail" }, { result: "pass" }, { result: "uncertain" }] as const;
    expect(tallyChecks(checks)).toEqual({ pass: 2, fail: 1, uncertain: 1 });
    expect(tallyLabel(tallyChecks(checks))).toBe("2 passed · 1 failed · 1 uncertain");
    expect(tallyLabel({ pass: 6, fail: 0, uncertain: 0 })).toBe("6 passed");
    expect(tallyLabel({ pass: 0, fail: 0, uncertain: 0 })).toBe("No conditions checked");
  });

  it("lists failures first, then open questions, then passes, keeping the contract's order within each", () => {
    const checks = [
      { ruleId: "R1", result: "pass" },
      { ruleId: "R2", result: "uncertain" },
      { ruleId: "R3", result: "fail" },
      { ruleId: "R4", result: "pass" },
      { ruleId: "R5", result: "fail" },
    ] as const;
    expect(sortChecksForReview(checks).map((entry) => entry.ruleId)).toEqual(["R3", "R5", "R2", "R1", "R4"]);
    expect(checks.map((entry) => entry.ruleId)).toEqual(["R1", "R2", "R3", "R4", "R5"]);
  });
});

describe("persisted layout", () => {
  const known = ["code", "title", "price"];
  const layout: StoredLayout = {
    columns: [
      { colId: "code", hide: false, width: 110, sort: null, sortIndex: null, pinned: "left" },
      { colId: "price", hide: false, width: 98, sort: "desc", sortIndex: 0, pinned: null },
      { colId: "title", hide: true, width: null, sort: null, sortIndex: null, pinned: null },
    ],
    groupBy: "seller",
  };

  it("round-trips a layout, keeping the column order", () => {
    expect(parseLayout(serializeLayout(layout), known)).toEqual(layout);
  });

  it("ignores storage that is missing, malformed or from another version", () => {
    expect(parseLayout(null, known)).toBeNull();
    expect(parseLayout("", known)).toBeNull();
    expect(parseLayout("{not json", known)).toBeNull();
    expect(parseLayout("[]", known)).toBeNull();
    expect(parseLayout(JSON.stringify({ version: LEDGER_LAYOUT_VERSION }), known)).toBeNull();
    expect(parseLayout(JSON.stringify({ version: LEDGER_LAYOUT_VERSION + 1, columns: layout.columns }), known)).toBeNull();
    expect(parseLayout(JSON.stringify({ version: LEDGER_LAYOUT_VERSION, columns: [] }), known)).toBeNull();
  });

  it("drops unknown and duplicate columns and repairs out-of-range values entry by entry", () => {
    const raw = JSON.stringify({
      version: LEDGER_LAYOUT_VERSION,
      groupBy: "galaxy",
      columns: [
        { colId: "removed-column", hide: false },
        { colId: "price", hide: "yes", width: 99999, sort: "sideways", sortIndex: 2, pinned: "top" },
        { colId: "price", hide: true },
        { colId: "title", width: 3, sort: "asc", sortIndex: -1 },
        "code",
        null,
        { hide: true },
      ],
    });
    expect(parseLayout(raw, known)).toEqual({
      columns: [
        { colId: "price", hide: false, width: 1200, sort: null, sortIndex: null, pinned: null },
        { colId: "title", hide: false, width: 40, sort: "asc", sortIndex: null, pinned: null },
      ],
      groupBy: "none",
    });
  });

  it("discards a layout in which no column survives", () => {
    const raw = JSON.stringify({ version: LEDGER_LAYOUT_VERSION, columns: [{ colId: "gone" }], groupBy: "status" });
    expect(parseLayout(raw, known)).toBeNull();
  });
});
