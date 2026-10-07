/**
 * Pure derivations behind the Operations page: segment predicates, cross-filters, grouping,
 * totals, chart series and the small formatters the ledger shares with its CSV export.
 *
 * Nothing here touches React, the DOM or AG Grid, so every rule an operator relies on ("what
 * counts as needing a human", "what the totals row sums") is unit-tested in plain Node.
 * Money stays in integer minor units throughout; formatting happens at the edge.
 */
import type { OpsCheckRow, OpsRow, OpsSnapshot, RiskLevel } from "../api/dto";
import { formatMoney } from "../domain/money";
import { deliverableCountLabel, joinList, languageName } from "../domain/format";
import type { Category, CheckResult, DeliverableSpec, SellerBehavior, VerificationCheck } from "../domain/schemas";
import { DEAL_STATUSES, DEAL_STATUS_LABEL, isHumanGate, type DealStatus } from "../domain/status";
import type { ApprovalMode, ProviderKind } from "../payments/types";

/* -------------------------------------------------------------------------- */
/*  Page view (?view=)                                                         */
/* -------------------------------------------------------------------------- */

export const OPS_VIEWS = ["dashboard", "ledger"] as const;
export type OpsView = (typeof OPS_VIEWS)[number];
export const DEFAULT_OPS_VIEW: OpsView = "dashboard";

/** Reads `?view=`; anything unknown (or repeated) falls back to the dashboard. */
export function parseOpsView(value: string | readonly string[] | null | undefined): OpsView {
  const single = typeof value === "string" ? value : null;
  return (OPS_VIEWS as readonly string[]).includes(single ?? "") ? (single as OpsView) : DEFAULT_OPS_VIEW;
}

/* -------------------------------------------------------------------------- */
/*  Labels                                                                     */
/* -------------------------------------------------------------------------- */

export type OpsOutcome = OpsRow["outcome"];
export type OpsStage = OpsRow["stage"];

/** Display order: live work first, then money moved, then the ways a deal ends without a capture. */
export const OUTCOME_ORDER: readonly OpsOutcome[] = [
  "in_progress",
  "captured",
  "voided",
  "declined",
  "blocked",
  "no_agreement",
  "failed",
];

export const OUTCOME_LABEL: Record<OpsOutcome, string> = {
  in_progress: "In progress",
  captured: "Captured",
  voided: "Voided",
  declined: "Declined",
  blocked: "Blocked",
  no_agreement: "No agreement",
  failed: "Failed",
};

export const STAGE_ORDER: readonly OpsStage[] = [
  "negotiation",
  "contract",
  "payment",
  "fulfillment",
  "verification",
  "settled",
  "closed",
];

export const STAGE_LABEL: Record<OpsStage, string> = {
  negotiation: "Negotiation",
  contract: "Contract",
  payment: "Payment",
  fulfillment: "Fulfillment",
  verification: "Verification",
  settled: "Settled",
  closed: "Closed",
};

/** Most urgent first: that is the order an operator wants to read a risk-grouped ledger in. */
export const RISK_ORDER: readonly RiskLevel[] = ["high", "medium", "low"];

export const RISK_LABEL: Record<RiskLevel, string> = { high: "High", medium: "Medium", low: "Low" };

export const CATEGORY_LABEL: Record<Category, string> = {
  illustration: "Illustration",
  copywriting: "Copywriting",
  translation: "Translation",
  other: "Other",
  restricted: "Restricted",
};

const RULE_KIND_LABEL: Record<string, string> = {
  deliverable_count: "Deliverable count",
  aspect_ratio_coverage: "Aspect ratios",
  language_coverage: "Languages",
  word_count: "Word count",
  valid_format: "File format",
  deadline: "Deadline",
  brief_adherence: "Brief adherence",
  no_embedded_instructions: "Hidden instructions",
};

const POLICY_FLAG_LABEL: Record<string, string> = {
  category_allowed: "Category",
  per_transaction_max: "Per-transaction max",
  daily_limit: "Daily limit",
  autonomous_limit: "Autonomous limit",
  seller_trust: "New seller",
};

/** "some_new_rule" → "Some new rule": an id the UI has no label for still reads as words. */
function humanize(id: string): string {
  const words = id.replace(/[_-]+/g, " ").trim();
  return words.length === 0 ? id : words.charAt(0).toUpperCase() + words.slice(1);
}

// Own-property lookups: a key such as "constructor" must not resolve through Object.prototype.
export function ruleKindLabel(kind: string): string {
  return Object.hasOwn(RULE_KIND_LABEL, kind) ? RULE_KIND_LABEL[kind] : humanize(kind);
}

export function policyFlagLabel(id: string): string {
  return Object.hasOwn(POLICY_FLAG_LABEL, id) ? POLICY_FLAG_LABEL[id] : humanize(id);
}

export const CHECK_RESULTS: readonly CheckResult[] = ["pass", "fail", "uncertain"];

const PROVIDER_LABEL: Record<ProviderKind, string> = { paypal_sandbox: "PayPal Sandbox", simulated: "Simulated" };
const APPROVAL_MODE_LABEL: Record<ApprovalMode, string> = { delegated: "Delegated wallet", interactive: "Interactive approval" };

export function providerLabel(provider: ProviderKind | null): string | null {
  return provider === null ? null : PROVIDER_LABEL[provider];
}

export function approvalModeLabel(mode: ApprovalMode | null): string | null {
  return mode === null ? null : APPROVAL_MODE_LABEL[mode];
}

/** "Simulated · Interactive approval"; null before a payment exists. */
export function railLabel(row: Pick<OpsRow, "paymentProvider" | "paymentMode">): string | null {
  const parts = [providerLabel(row.paymentProvider), approvalModeLabel(row.paymentMode)].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? null : parts.join(" · ");
}

/* -------------------------------------------------------------------------- */
/*  Controlled demo-fault sellers                                              */
/* -------------------------------------------------------------------------- */

export type DemoFault = Exclude<SellerBehavior, "reliable">;

/**
 * Which sellers misbehave on purpose. A literal rather than a lookup in the seller directory,
 * because that module also holds every seller's private rate card and walk-away floor and
 * must not be pulled into the browser bundle. A unit test pins this map to the directory.
 */
export const DEMO_FAULT_BY_SELLER: Readonly<Record<string, DemoFault>> = {
  quickdraw: "omits_variant",
  pixelharbor: "embeds_instructions",
};

export const DEMO_FAULT_DETAIL: Record<DemoFault, string> = {
  omits_variant: "Demo fault: leaves out one required variant on the first delivery",
  embeds_instructions: "Demo fault: hides instructions for the verifier inside the delivery",
};

export function demoFaultOf(sellerId: string): DemoFault | null {
  return Object.hasOwn(DEMO_FAULT_BY_SELLER, sellerId) ? DEMO_FAULT_BY_SELLER[sellerId] : null;
}

/* -------------------------------------------------------------------------- */
/*  Segments (the ledger's status tabs)                                        */
/* -------------------------------------------------------------------------- */

export const SEGMENTS = ["all", "in_progress", "needs_human", "captured", "closed", "at_risk"] as const;
export type SegmentId = (typeof SEGMENTS)[number];

export const SEGMENT_LABEL: Record<SegmentId, string> = {
  all: "All",
  in_progress: "In progress",
  needs_human: "Needs a human",
  captured: "Captured",
  closed: "Voided or closed",
  at_risk: "At risk",
};

/**
 * Segment membership. The segments overlap on purpose: a deal waiting for a reviewer is in
 * progress, needs a human and is usually at risk, and an operator should find it under each.
 */
export function inSegment(row: Pick<OpsRow, "status" | "outcome" | "risk">, segment: SegmentId): boolean {
  switch (segment) {
    case "all":
      return true;
    case "in_progress":
      return row.outcome === "in_progress";
    case "needs_human":
      return isHumanGate(row.status);
    case "captured":
      return row.outcome === "captured";
    case "closed":
      return row.outcome !== "in_progress" && row.outcome !== "captured";
    case "at_risk":
      return row.risk !== "low";
    default:
      return unreachable(segment);
  }
}

export function segmentCounts(rows: readonly OpsRow[]): Record<SegmentId, number> {
  const counts: Record<SegmentId, number> = { all: 0, in_progress: 0, needs_human: 0, captured: 0, closed: 0, at_risk: 0 };
  for (const row of rows) {
    for (const segment of SEGMENTS) {
      if (inSegment(row, segment)) counts[segment] += 1;
    }
  }
  return counts;
}

/* -------------------------------------------------------------------------- */
/*  Cross-filters (set by clicking a chart) and the combined external filter   */
/* -------------------------------------------------------------------------- */

export interface CheckFilter {
  kind: string;
  result: CheckResult;
}

/** One optional constraint per chart. Null means "that chart is not filtering". */
export interface CrossFilter {
  seller: string | null;
  outcome: OpsOutcome | null;
  day: string | null;
  check: CheckFilter | null;
}

export const EMPTY_CROSS_FILTER: CrossFilter = { seller: null, outcome: null, day: null, check: null };

export interface LedgerFilter {
  segment: SegmentId;
  onlyMine: boolean;
  cross: CrossFilter;
}

export const DEFAULT_LEDGER_FILTER: LedgerFilter = { segment: "all", onlyMine: false, cross: EMPTY_CROSS_FILTER };

/** dealId → every "kind:result" that deal's verification reports contain (all rounds). */
export type CheckIndex = ReadonlyMap<string, ReadonlySet<string>>;

export function checkKey(kind: string, result: CheckResult): string {
  return `${kind}:${result}`;
}

export function indexChecks(checks: readonly OpsCheckRow[]): CheckIndex {
  const index = new Map<string, Set<string>>();
  for (const check of checks) {
    const keys = index.get(check.dealId) ?? new Set<string>();
    keys.add(checkKey(check.kind, check.result));
    index.set(check.dealId, keys);
  }
  return index;
}

export function hasCrossFilter(cross: CrossFilter): boolean {
  return cross.seller !== null || cross.outcome !== null || cross.day !== null || cross.check !== null;
}

/** True when the grid has to consult `passesLedgerFilter` at all. */
export function isLedgerFilterActive(filter: LedgerFilter): boolean {
  return filter.segment !== "all" || filter.onlyMine || hasCrossFilter(filter.cross);
}

export function passesLedgerFilter(row: OpsRow, filter: LedgerFilter, checks: CheckIndex): boolean {
  if (!inSegment(row, filter.segment)) return false;
  if (filter.onlyMine && row.origin !== "mine") return false;
  const { seller, outcome, day, check } = filter.cross;
  if (seller !== null && row.seller !== seller) return false;
  if (outcome !== null && row.outcome !== outcome) return false;
  if (day !== null && row.day !== day) return false;
  if (check !== null && !(checks.get(row.id)?.has(checkKey(check.kind, check.result)) ?? false)) return false;
  return true;
}

export interface CrossFilterChip {
  key: keyof CrossFilter;
  label: string;
}

const CHECK_RESULT_WORD: Record<CheckResult, string> = { pass: "passed", fail: "failed", uncertain: "uncertain" };

/** The removable chips shown above the grid, in a fixed order so they do not jump around. */
export function crossFilterChips(cross: CrossFilter): CrossFilterChip[] {
  const chips: CrossFilterChip[] = [];
  if (cross.seller !== null) chips.push({ key: "seller", label: `Seller: ${cross.seller}` });
  if (cross.outcome !== null) chips.push({ key: "outcome", label: `Outcome: ${OUTCOME_LABEL[cross.outcome]}` });
  if (cross.check !== null) {
    chips.push({ key: "check", label: `Check: ${ruleKindLabel(cross.check.kind)} ${CHECK_RESULT_WORD[cross.check.result]}` });
  }
  if (cross.day !== null) chips.push({ key: "day", label: `Day: ${dayLabel(cross.day)}` });
  return chips;
}

/** Clicking the value that is already selected clears it, so a chart click is its own undo. */
export function toggleCrossFilter<K extends keyof CrossFilter>(cross: CrossFilter, key: K, value: CrossFilter[K]): CrossFilter {
  const current = cross[key];
  const same =
    key === "check"
      ? current !== null &&
        value !== null &&
        (current as CheckFilter).kind === (value as CheckFilter).kind &&
        (current as CheckFilter).result === (value as CheckFilter).result
      : current === value;
  return { ...cross, [key]: same ? null : value };
}

/* -------------------------------------------------------------------------- */
/*  Grouping                                                                   */
/* -------------------------------------------------------------------------- */

export const GROUP_BYS = ["none", "status", "seller", "outcome", "risk"] as const;
export type LedgerGroupBy = (typeof GROUP_BYS)[number];
export type ActiveGroupBy = Exclude<LedgerGroupBy, "none">;

export const GROUP_BY_LABEL: Record<LedgerGroupBy, string> = {
  none: "None",
  status: "Status",
  seller: "Seller",
  outcome: "Outcome",
  risk: "Risk",
};

export function isGroupBy(value: unknown): value is LedgerGroupBy {
  return typeof value === "string" && (GROUP_BYS as readonly string[]).includes(value);
}

export function groupKeyOf(row: Pick<OpsRow, "status" | "seller" | "outcome" | "risk">, by: ActiveGroupBy): string {
  switch (by) {
    case "status":
      return row.status;
    case "seller":
      return row.seller;
    case "outcome":
      return row.outcome;
    case "risk":
      return row.risk;
    default:
      return unreachable(by);
  }
}

export function groupLabel(by: ActiveGroupBy, key: string): string {
  switch (by) {
    case "status":
      return Object.hasOwn(DEAL_STATUS_LABEL, key) ? DEAL_STATUS_LABEL[key as DealStatus] : humanize(key);
    case "seller":
      return key;
    case "outcome":
      return Object.hasOwn(OUTCOME_LABEL, key) ? OUTCOME_LABEL[key as OpsOutcome] : humanize(key);
    case "risk":
      return Object.hasOwn(RISK_LABEL, key) ? `${RISK_LABEL[key as RiskLevel]} risk` : humanize(key);
    default:
      return unreachable(by);
  }
}

/** Position in a fixed list; unknown keys sort after every known one, alphabetically among themselves. */
function rank(order: readonly string[], key: string): number {
  const index = order.indexOf(key);
  return index === -1 ? order.length : index;
}

/**
 * Order of the groups themselves: lifecycle order for statuses, urgency for risk, a fixed
 * reading order for outcomes and A–Z for sellers. Rows inside a group keep the grid's sort.
 */
export function compareGroupKeys(by: ActiveGroupBy, a: string, b: string): number {
  const fixed: readonly string[] | null =
    by === "status" ? DEAL_STATUSES : by === "outcome" ? OUTCOME_ORDER : by === "risk" ? RISK_ORDER : null;
  if (fixed !== null) {
    const diff = rank(fixed, a) - rank(fixed, b);
    if (diff !== 0) return diff;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface LedgerGroup {
  key: string;
  label: string;
  count: number;
  priceMinor: number;
  authorizedMinor: number;
  capturedMinor: number;
}

/** One summary per group that has at least one row, in display order. */
export function buildGroups(rows: readonly OpsRow[], by: ActiveGroupBy): LedgerGroup[] {
  const groups = new Map<string, LedgerGroup>();
  for (const row of rows) {
    const key = groupKeyOf(row, by);
    const group = groups.get(key) ?? { key, label: groupLabel(by, key), count: 0, priceMinor: 0, authorizedMinor: 0, capturedMinor: 0 };
    group.count += 1;
    group.priceMinor += row.priceMinor;
    group.authorizedMinor += row.authorizedMinor;
    group.capturedMinor += row.capturedMinor;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => compareGroupKeys(by, a.key, b.key));
}

export interface GroupedItem {
  /** True for a group's header row, false for a member. */
  header: boolean;
  group: string;
}

/**
 * Lays out an already filtered and sorted list as "header, members, header, members…".
 *
 *  - groups appear in `compare` order; members keep their incoming (sorted) order;
 *  - a header whose group has no members is dropped (the filter removed them all);
 *  - members of a collapsed group are dropped, their header stays;
 *  - a member whose header is missing is still shown, so no deal can vanish from the ledger.
 */
export function arrangeGrouped<T>(
  items: readonly T[],
  describe: (item: T) => GroupedItem,
  compare: (a: string, b: string) => number,
  collapsed: ReadonlySet<string>,
): T[] {
  const headers = new Map<string, T>();
  const members = new Map<string, T[]>();
  for (const item of items) {
    const { header, group } = describe(item);
    if (header) {
      headers.set(group, item);
    } else {
      const list = members.get(group);
      if (list) list.push(item);
      else members.set(group, [item]);
    }
  }
  const arranged: T[] = [];
  for (const group of [...members.keys()].sort(compare)) {
    const header = headers.get(group);
    if (header !== undefined) arranged.push(header);
    // Without a header there is nothing to expand from, so the rows cannot be hidden.
    if (header === undefined || !collapsed.has(group)) arranged.push(...(members.get(group) ?? []));
  }
  return arranged;
}

/* -------------------------------------------------------------------------- */
/*  Totals                                                                     */
/* -------------------------------------------------------------------------- */

export interface LedgerTotals {
  count: number;
  priceMinor: number;
  listPriceMinor: number;
  savedMinor: number;
  authorizedMinor: number;
  capturedMinor: number;
  heldMinor: number;
}

export const ZERO_TOTALS: LedgerTotals = {
  count: 0,
  priceMinor: 0,
  listPriceMinor: 0,
  savedMinor: 0,
  authorizedMinor: 0,
  capturedMinor: 0,
  heldMinor: 0,
};

/** The pinned totals row: sums of every money column over the rows the filters let through. */
export function sumLedger(rows: readonly OpsRow[]): LedgerTotals {
  const totals: LedgerTotals = { ...ZERO_TOTALS };
  for (const row of rows) {
    totals.count += 1;
    totals.priceMinor += row.priceMinor;
    totals.listPriceMinor += row.listPriceMinor;
    totals.savedMinor += row.savedMinor;
    totals.authorizedMinor += row.authorizedMinor;
    totals.capturedMinor += row.capturedMinor;
    totals.heldMinor += row.heldMinor;
  }
  return totals;
}

/* -------------------------------------------------------------------------- */
/*  KPI strip                                                                  */
/* -------------------------------------------------------------------------- */

export type OpsKpiId = "deals" | "held" | "captured" | "released" | "review" | "firstPass";

export interface OpsKpi {
  id: OpsKpiId;
  label: string;
  /** One line that says what the figure means, so the strip explains itself. */
  caption: string;
  kind: "count" | "money" | "percent";
  /** A count, minor units or a 0–1 rate depending on `kind`; null when there is nothing to measure yet. */
  value: number | null;
}

export function buildKpis(snapshot: Pick<OpsSnapshot, "totals" | "deals">): OpsKpi[] {
  const { totals, deals } = snapshot;
  const verified = deals.filter((deal) => deal.verificationDecision !== null).length;
  return [
    { id: "deals", label: "Deals", caption: "Agent deals in this ledger", kind: "count", value: totals.deals },
    {
      id: "held",
      label: "Authorized, held now",
      caption: `On hold at PayPal, of ${formatMoney(totals.authorizedMinor)} authorized`,
      kind: "money",
      value: totals.heldMinor,
    },
    {
      id: "captured",
      label: "Captured",
      caption: "Paid to sellers after verification passed",
      kind: "money",
      value: totals.capturedMinor,
    },
    {
      id: "released",
      label: "Released back",
      caption: "Voided or uncaptured, back with the payer",
      kind: "money",
      value: totals.releasedMinor,
    },
    {
      id: "review",
      label: "Pending human review",
      caption: "Waiting on an approval or a review",
      kind: "count",
      value: totals.pendingHumanReview,
    },
    {
      id: "firstPass",
      label: "First-pass verification rate",
      caption:
        verified === 0
          ? "No delivery has been verified yet"
          : `First deliveries that passed, of ${verified} verified`,
      kind: "percent",
      // A rate over zero deliveries is not 0%: it is unknown.
      value: verified === 0 ? null : totals.firstPassRate,
    },
  ];
}

/* -------------------------------------------------------------------------- */
/*  Chart series                                                               */
/* -------------------------------------------------------------------------- */

export interface SellerVolumeDatum {
  seller: string;
  authorizedMinor: number;
  capturedMinor: number;
  deals: number;
}

/** Authorized vs captured per seller, largest authorized volume first. Sellers with no payment are left out. */
export function sellerVolume(rows: readonly OpsRow[]): SellerVolumeDatum[] {
  const bySeller = new Map<string, SellerVolumeDatum>();
  for (const row of rows) {
    const datum = bySeller.get(row.seller) ?? { seller: row.seller, authorizedMinor: 0, capturedMinor: 0, deals: 0 };
    datum.authorizedMinor += row.authorizedMinor;
    datum.capturedMinor += row.capturedMinor;
    datum.deals += 1;
    bySeller.set(row.seller, datum);
  }
  return [...bySeller.values()]
    .filter((datum) => datum.authorizedMinor > 0 || datum.capturedMinor > 0)
    .sort((a, b) => b.authorizedMinor - a.authorizedMinor || a.seller.localeCompare(b.seller));
}

export interface OutcomeDatum {
  outcome: OpsOutcome;
  label: string;
  count: number;
}

/** Deal count per outcome in display order; outcomes nobody has are omitted. */
export function outcomeBreakdown(rows: readonly OpsRow[]): OutcomeDatum[] {
  const counts = new Map<OpsOutcome, number>();
  for (const row of rows) counts.set(row.outcome, (counts.get(row.outcome) ?? 0) + 1);
  return OUTCOME_ORDER.filter((outcome) => counts.has(outcome)).map((outcome) => ({
    outcome,
    label: OUTCOME_LABEL[outcome],
    count: counts.get(outcome) ?? 0,
  }));
}

export interface RuleKindDatum {
  kind: string;
  label: string;
  pass: number;
  fail: number;
  uncertain: number;
}

/**
 * Check results per rule kind for the given deals (every verification round counts: a rule
 * that failed and then passed after a revision shows up in both columns). Kinds with the most
 * failures and uncertain results come first, because those are the ones worth reading.
 */
export function checksByRuleKind(checks: readonly OpsCheckRow[], dealIds: ReadonlySet<string>): RuleKindDatum[] {
  const byKind = new Map<string, RuleKindDatum>();
  for (const check of checks) {
    if (!dealIds.has(check.dealId)) continue;
    const datum = byKind.get(check.kind) ?? { kind: check.kind, label: ruleKindLabel(check.kind), pass: 0, fail: 0, uncertain: 0 };
    datum[check.result] += 1;
    byKind.set(check.kind, datum);
  }
  return [...byKind.values()].sort(
    (a, b) => b.fail + b.uncertain - (a.fail + a.uncertain) || b.pass - a.pass || a.label.localeCompare(b.label),
  );
}

export interface DayVolumeDatum {
  /** UTC day bucket, YYYY-MM-DD. */
  day: string;
  label: string;
  authorizedMinor: number;
  capturedMinor: number;
  deals: number;
}

/** How many day buckets the volume chart shows at most (the most recent ones). */
export const MAX_VOLUME_DAYS = 14;

/** Authorized and captured volume per day a deal was created, oldest first. */
export function volumeByDay(rows: readonly OpsRow[]): DayVolumeDatum[] {
  const byDay = new Map<string, DayVolumeDatum>();
  for (const row of rows) {
    const datum = byDay.get(row.day) ?? { day: row.day, label: dayLabel(row.day), authorizedMinor: 0, capturedMinor: 0, deals: 0 };
    datum.authorizedMinor += row.authorizedMinor;
    datum.capturedMinor += row.capturedMinor;
    datum.deals += 1;
    byDay.set(row.day, datum);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)).slice(-MAX_VOLUME_DAYS);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "2026-10-05" → "Oct 5". The bucket is a UTC calendar day, so no time zone maths is involved. */
export function dayLabel(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  const month = MONTHS[Number(match[2]) - 1];
  return month === undefined ? day : `${month} ${Number(match[3])}`;
}

/* -------------------------------------------------------------------------- */
/*  Deadline                                                                   */
/* -------------------------------------------------------------------------- */

export type DeadlineUrgency = "none" | "soon" | "overdue";

export interface DeadlineState {
  /** "in 14 h", "in 3 d", "overdue"; null when the deadline no longer matters or is unknown. */
  relative: string | null;
  urgency: DeadlineUrgency;
}

/** Inside this window an open deal's deadline is highlighted. Matches the risk engine's early warning. */
export const DEADLINE_SOON_HOURS = 24;

function formatHoursAhead(hours: number): string {
  if (hours < 1) return `in ${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `in ${Math.round(hours)} h`;
  return `in ${Math.round(hours / 24)} d`;
}

/**
 * How the ledger presents a deadline. Only an open deal can be late: once a deal has ended,
 * its deadline is history and gets neither a countdown nor a highlight.
 */
export function deadlineState(row: Pick<OpsRow, "deadline" | "hoursToDeadline" | "outcome">): DeadlineState {
  if (row.deadline === null || row.hoursToDeadline === null || row.outcome !== "in_progress") {
    return { relative: null, urgency: "none" };
  }
  if (row.hoursToDeadline <= 0) return { relative: "overdue", urgency: "overdue" };
  return {
    relative: formatHoursAhead(row.hoursToDeadline),
    urgency: row.hoursToDeadline < DEADLINE_SOON_HOURS ? "soon" : "none",
  };
}

/* -------------------------------------------------------------------------- */
/*  Formatting shared by cells, tooltips and the CSV export                    */
/* -------------------------------------------------------------------------- */

/** "47.00": a plain decimal a spreadsheet reads as a number. Integer arithmetic only. */
export function minorToDecimal(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${(abs % 100).toString().padStart(2, "0")}`;
}

/**
 * Free text on its way into a CSV cell. A title comes from a human's request, and a spreadsheet
 * runs any cell that starts with "=", "+", "-" or "@" as a formula; a leading apostrophe makes
 * it text again. Tabs and line breaks become spaces so one deal stays one line.
 */
export function csvText(value: string): string {
  const flat = value.replace(/[\t\r\n]+/g, " ").trim();
  return /^[=+\-@]/.test(flat) ? `'${flat}` : flat;
}

/** Axis-sized money: "$0", "$47", "$1.2k", "$15k". Whole dollars are enough to read a bar against. */
export function formatMoneyCompact(minor: number): string {
  const dollars = Math.round(Math.abs(minor) / 100);
  const sign = minor < 0 ? "-" : "";
  if (dollars < 1000) return `${sign}$${dollars}`;
  const thousands = dollars / 1000;
  const text = thousands >= 10 ? Math.round(thousands).toString() : (Math.round(thousands * 10) / 10).toString();
  return `${sign}$${text}k`;
}

/** 0.4 → "40%"; null (nothing measured) → an em dash. */
export function formatRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  return `${Math.round(Math.min(1, Math.max(0, rate)) * 100)}%`;
}

/** "1 / 2": revisions used out of the contract's limit. */
export function revisionsLabel(row: Pick<OpsRow, "revisionsUsed" | "revisionLimit">): string {
  return `${row.revisionsUsed} / ${row.revisionLimit}`;
}

/** "1 deal", "3 deals". */
export function dealCountLabel(count: number): string {
  return `${count} ${count === 1 ? "deal" : "deals"}`;
}

/* -------------------------------------------------------------------------- */
/*  Deal inspector                                                             */
/* -------------------------------------------------------------------------- */

/** "3 illustrations · 16:9 and 1:1" / "6 copy pieces · English and Japanese · 80–120 words each". */
export function deliverableLine(spec: DeliverableSpec): string {
  const count = deliverableCountLabel(spec.kind, spec.count);
  if (spec.kind === "illustration") return `${count} · ${joinList(spec.aspectRatios)}`;
  return `${count} · ${joinList(spec.languages.map(languageName))} · ${spec.minWords}–${spec.maxWords} words each`;
}

export interface CheckTally {
  pass: number;
  fail: number;
  uncertain: number;
}

export function tallyChecks(checks: readonly Pick<VerificationCheck, "result">[]): CheckTally {
  const tally: CheckTally = { pass: 0, fail: 0, uncertain: 0 };
  for (const check of checks) tally[check.result] += 1;
  return tally;
}

/** "5 passed · 1 failed": only the results that occurred, failures never hidden behind a count of passes. */
export function tallyLabel(tally: CheckTally): string {
  const parts: string[] = [];
  if (tally.pass > 0) parts.push(`${tally.pass} passed`);
  if (tally.fail > 0) parts.push(`${tally.fail} failed`);
  if (tally.uncertain > 0) parts.push(`${tally.uncertain} uncertain`);
  return parts.length === 0 ? "No conditions checked" : parts.join(" · ");
}

/**
 * Conditions in the order an operator needs them: what failed, then what a human must judge,
 * then what passed. The order inside each result is the contract's own (R1, R2, …).
 */
export function sortChecksForReview<T extends Pick<VerificationCheck, "result">>(checks: readonly T[]): T[] {
  const order: Record<CheckResult, number> = { fail: 0, uncertain: 1, pass: 2 };
  return checks
    .map((check, index) => ({ check, index }))
    .sort((a, b) => order[a.check.result] - order[b.check.result] || a.index - b.index)
    .map((entry) => entry.check);
}

/* -------------------------------------------------------------------------- */
/*  Persisted column layout                                                    */
/* -------------------------------------------------------------------------- */

/** Bump when a stored layout can no longer be applied to the current column set. */
export const LEDGER_LAYOUT_VERSION = 1;
export const LEDGER_LAYOUT_STORAGE_KEY = "pact.ops.ledger.layout";

export interface StoredColumn {
  colId: string;
  hide: boolean;
  width: number | null;
  sort: "asc" | "desc" | null;
  sortIndex: number | null;
  pinned: "left" | "right" | null;
}

export interface StoredLayout {
  columns: StoredColumn[];
  groupBy: LedgerGroupBy;
}

const MIN_COLUMN_WIDTH = 40;
const MAX_COLUMN_WIDTH = 1200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStoredColumn(value: unknown, known: ReadonlySet<string>): StoredColumn | null {
  if (!isRecord(value) || typeof value.colId !== "string" || !known.has(value.colId)) return null;
  const width =
    typeof value.width === "number" && Number.isFinite(value.width)
      ? Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(value.width)))
      : null;
  const sort = value.sort === "asc" || value.sort === "desc" ? value.sort : null;
  const sortIndex =
    sort !== null && typeof value.sortIndex === "number" && Number.isInteger(value.sortIndex) && value.sortIndex >= 0
      ? value.sortIndex
      : null;
  return {
    colId: value.colId,
    hide: value.hide === true,
    width,
    sort,
    sortIndex,
    pinned: value.pinned === "left" || value.pinned === "right" ? value.pinned : null,
  };
}

export function serializeLayout(layout: StoredLayout): string {
  return JSON.stringify({ version: LEDGER_LAYOUT_VERSION, ...layout });
}

/**
 * Reads a layout back from localStorage. Storage is untrusted input (another version of the
 * app, a hand edit, a truncated write): anything that is not a layout for the columns that
 * exist today is ignored, entry by entry, and a layout with no usable column is discarded.
 */
export function parseLayout(raw: string | null, knownColumnIds: readonly string[]): StoredLayout | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== LEDGER_LAYOUT_VERSION || !Array.isArray(parsed.columns)) return null;
  const known = new Set(knownColumnIds);
  const seen = new Set<string>();
  const columns: StoredColumn[] = [];
  for (const entry of parsed.columns) {
    const column = toStoredColumn(entry, known);
    if (column === null || seen.has(column.colId)) continue;
    seen.add(column.colId);
    columns.push(column);
  }
  if (columns.length === 0) return null;
  return { columns, groupBy: isGroupBy(parsed.groupBy) ? parsed.groupBy : "none" };
}

/** Exhaustiveness guard for the switches above. */
function unreachable(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
