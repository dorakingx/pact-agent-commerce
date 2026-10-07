/**
 * The operations snapshot reshaped into the flat tables AG Studio reads.
 *
 * Studio's data engine works on rows of primitives, groups by text and aggregates numbers, so
 * three things happen here and nowhere else:
 *
 *  1. Every enum becomes the label a person reads ("In review", not "in_review"). The label IS
 *     the category value, so chart legends, filter lists and group headers are finished text.
 *  2. Money gains dollar-valued twins of the integer minor-unit columns. They exist for charts
 *     and totals only: nothing reads them back, and no amount in PACT is ever computed from them.
 *  3. Counting columns (`deals`, `checks`, `events`) are a constant 1 per row, so "sum of Deals"
 *     is a count that carries a finished name into every widget title.
 *
 * Everything is pure and deterministic: the same snapshot always yields the same rows, which is
 * what lets the dashboard skip an update when a 15-second refresh brought nothing new.
 */
import type { OpsCheckRow, OpsPaymentEvent, OpsRow, OpsSnapshot, RiskLevel } from "../api/dto";
import type { PolicyOutcome, VerificationDecision } from "../domain/schemas";
import type { DealStatus, PaymentStatus } from "../domain/status";
import {
  CATEGORY_LABEL,
  DEMO_FAULT_DETAIL,
  OUTCOME_LABEL,
  RISK_LABEL,
  STAGE_LABEL,
  approvalModeLabel,
  demoFaultOf,
  providerLabel,
  ruleKindLabel,
} from "./ops-derive";

// One vocabulary for the whole Operations page: the dashboard's categories are the Ledger's labels.
export { OUTCOME_LABEL, RISK_LABEL, STAGE_LABEL, ruleKindLabel };

/* -------------------------------------------------------------------------- */
/*  Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

export type StageKey = OpsRow["stage"];
export type OutcomeKey = OpsRow["outcome"];

/** Lifecycle order of the coarse stages. The two exits come last. */
export const STAGE_KEYS = [
  "negotiation",
  "contract",
  "payment",
  "fulfillment",
  "verification",
  "settled",
  "closed",
] as const satisfies readonly StageKey[];

/** The stages a deal passes THROUGH, in order: what the settlement funnel counts. */
export const FUNNEL_STAGES = [
  "negotiation",
  "contract",
  "payment",
  "fulfillment",
  "verification",
  "settled",
] as const satisfies readonly StageKey[];
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

const RISK_ORDER: Record<RiskLevel, number> = { high: 1, medium: 2, low: 3 };

const TRUST_LABEL: Record<OpsRow["sellerTrust"], string> = { established: "Established", new: "New seller" };
const ORIGIN_LABEL: Record<OpsRow["origin"], string> = { mine: "This session", showcase: "Showcase" };

export const PAYMENT_STATUS_TEXT: Record<PaymentStatus, string> = {
  none: "No payment yet",
  created: "Order created",
  approved: "Approved by payer",
  authorized: "Authorized · held",
  captured: "Captured",
  voided: "Voided",
  expired: "Expired",
  failed: "Failed",
};

const VERIFICATION_LABEL: Record<VerificationDecision, string> = {
  capture_eligible: "Capture eligible",
  human_review: "Human review",
  revision_required: "Revision required",
  reject: "Rejected",
};

const POLICY_LABEL: Record<PolicyOutcome, string> = {
  allow: "Within policy",
  needs_approval: "Needs approval",
  block: "Blocked",
};

/** What each policy check id means when it is the reason a deal stopped. */
const POLICY_FLAG_TEXT: Record<string, string> = {
  autonomous_limit: "Price is above the agent's autonomous limit",
  per_transaction_max: "Price is above the per-transaction maximum",
  daily_limit: "Daily spending limit would be exceeded",
  seller_trust: "New seller: first spend needs approval",
  category_allowed: "Category is not on the allowed list",
};

export const CHECK_RESULT_TEXT: Record<OpsCheckRow["result"], string> = {
  pass: "Pass",
  fail: "Fail",
  uncertain: "Uncertain",
};
export const EVALUATOR_LABEL: Record<OpsCheckRow["evaluator"], string> = { deterministic: "Deterministic", ai: "AI" };

const PAYMENT_EVENT_LABEL: Record<OpsPaymentEvent["type"], string> = {
  order_created: "Order created",
  approved: "Approved by payer",
  authorized: "Authorized",
  capture_blocked: "Capture blocked",
  capture_pending: "Capture pending",
  captured: "Captured",
  voided: "Voided",
  cancelled: "Cancelled by payer",
  expired: "Expired",
  failed: "Failed",
  webhook: "Webhook confirmation",
  reconciled: "Reconciled",
};

/**
 * Which countable column an event feeds. A chart of these columns has one series per kind of
 * outcome in a fixed order, so the theme's series colours mean the same thing as the pills:
 * emerald captured, amber held, red blocked or failed.
 */
export const PAYMENT_EVENT_GROUP: Record<OpsPaymentEvent["type"], PaymentEventGroup> = {
  captured: "captures",
  authorized: "authorizations",
  capture_blocked: "problems",
  failed: "problems",
  order_created: "orders",
  approved: "orders",
  voided: "releases",
  cancelled: "releases",
  expired: "releases",
  webhook: "confirmations",
  capture_pending: "confirmations",
  reconciled: "confirmations",
};

/**
 * Confidence bands for the distribution chart. `max` is exclusive except for the last band.
 * The labels sort alphabetically into numeric order, so a chart only has to sort by the band.
 */
export const CONFIDENCE_BANDS = [
  { label: "0–49%", max: 0.5 },
  { label: "50–69%", max: 0.7 },
  { label: "70–84%", max: 0.85 },
  { label: "85–94%", max: 0.95 },
  { label: "95–100%", max: Number.POSITIVE_INFINITY },
] as const;

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** "no_embedded_instructions" → "No embedded instructions", for ids this file has no label for. */
export function humanizeKey(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.length === 0 ? key : words.charAt(0).toUpperCase() + words.slice(1);
}

/** Display dollars of an integer minor-unit amount. Exact for every amount PACT can hold. */
export function minorToUsd(minor: number): number {
  return Math.round(minor) / 100;
}

export function policyFlagText(flag: string): string {
  return POLICY_FLAG_TEXT[flag] ?? humanizeKey(flag);
}

export function confidenceBandIndex(confidence: number): number {
  const index = CONFIDENCE_BANDS.findIndex((band) => confidence < band.max);
  return index === -1 ? CONFIDENCE_BANDS.length - 1 : index;
}

/** The stage a label (or raw key) names, in any letter case; null for anything else. */
export function stageKeyOf(value: unknown): StageKey | null {
  if (typeof value !== "string") return null;
  const needle = value.trim().toLowerCase();
  return STAGE_KEYS.find((key) => key === needle || STAGE_LABEL[key].toLowerCase() === needle) ?? null;
}

/** Deals that are waiting for a person: the two human gates that hold money or a decision. */
export function isAwaitingHuman(status: DealStatus): boolean {
  return status === "awaiting_approval" || status === "in_review";
}

/* -------------------------------------------------------------------------- */
/*  Derivations                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Money PayPal released without capturing it: the whole authorization of a voided or expired
 * payment, and the uncaptured remainder of a partial capture. Mirrors the server's ledger rule
 * so the tile and the API total agree.
 */
export function releasedMinorOf(row: Pick<OpsRow, "paymentStatus" | "authorizedMinor" | "capturedMinor">): number {
  if (row.paymentStatus === "voided" || row.paymentStatus === "expired") return row.authorizedMinor;
  if (row.paymentStatus === "captured") return Math.max(0, row.authorizedMinor - row.capturedMinor);
  return 0;
}

/**
 * How far along the lifecycle a deal got, as the stages it passed through in order.
 *
 * A row only records where a deal is NOW, and a closed deal's stage is just "closed", so the
 * furthest point is recovered from what the deal left behind: a contract price, a PayPal order,
 * an authorization, a verification decision, a capture. The result is always a prefix of
 * FUNNEL_STAGES, which is what makes the funnel monotonic.
 */
export function stagesReached(
  row: Pick<
    OpsRow,
    "stage" | "outcome" | "priceMinor" | "paymentStatus" | "authorizedMinor" | "paypalAuthorizationId" | "verificationDecision"
  >,
): FunnelStage[] {
  let furthest = 0;
  const reach = (stage: FunnelStage): void => {
    furthest = Math.max(furthest, FUNNEL_STAGES.indexOf(stage));
  };
  if (row.stage !== "closed") reach(row.stage);
  if (row.priceMinor > 0) reach("contract");
  if (row.paymentStatus !== "none") reach("payment");
  if (row.authorizedMinor > 0 || row.paypalAuthorizationId !== null) reach("fulfillment");
  if (row.verificationDecision !== null) reach("verification");
  if (row.outcome === "captured") reach("settled");
  return FUNNEL_STAGES.slice(0, furthest + 1);
}

/**
 * Whether a deal's FIRST delivery passed verification: 1, 0, or null when nothing has been
 * verified yet. A row carries only its latest decision, so a second round (known from the check
 * rows) means the first one failed — the same reading the server's totals use.
 */
export function firstPassOf(row: Pick<OpsRow, "id" | "verificationDecision">, revisedDealIds: ReadonlySet<string>): 0 | 1 | null {
  if (row.verificationDecision === null) return null;
  return revisedDealIds.has(row.id) || row.verificationDecision !== "capture_eligible" ? 0 : 1;
}

/**
 * One sentence on why a deal is standing still, for the review queue and the agent. Policy
 * flags explain an approval gate; the latest verification explains a review gate; otherwise
 * the first risk reason is the best available account.
 */
export function stopReasonOf(
  row: Pick<OpsRow, "status" | "policyFlags" | "failedRules" | "confidence" | "riskReasons" | "verificationDecision">,
): string | null {
  if (row.status === "awaiting_approval") {
    return row.policyFlags.length > 0 ? row.policyFlags.map(policyFlagText).join("; ") : "Spend needs human approval under policy";
  }
  if (row.status === "in_review") {
    const parts: string[] = [];
    if (row.failedRules > 0) parts.push(`${row.failedRules} required ${row.failedRules === 1 ? "condition" : "conditions"} failed`);
    if (row.confidence !== null) parts.push(`weakest check at ${Math.round(row.confidence * 100)}% confidence`);
    return parts.length > 0 ? `Verification was inconclusive: ${parts.join(", ")}` : "Verification was inconclusive";
  }
  return row.riskReasons[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/*  Rows                                                                       */
/* -------------------------------------------------------------------------- */

export interface StudioDealRow {
  id: string;
  code: string;
  title: string;
  status: string;
  stage: string;
  stageOrder: number;
  outcome: string;
  seller: string;
  sellerTrust: string;
  sellerNote: string | null;
  category: string | null;
  origin: string;
  deals: number;
  priceUsd: number;
  listPriceUsd: number;
  savedUsd: number;
  authorizedUsd: number;
  capturedUsd: number;
  heldUsd: number;
  releasedUsd: number;
  paymentStatus: string;
  paymentRail: string | null;
  approvalMode: string | null;
  paypalOrderId: string | null;
  paypalAuthorizationId: string | null;
  paypalCaptureId: string | null;
  webhookConfirmed: boolean;
  verification: string | null;
  confidence: number | null;
  firstPass: number | null;
  failedRules: number;
  revisionsUsed: number;
  negotiationMoves: number;
  guardrailInterventions: number;
  policy: string | null;
  policyFlags: string | null;
  humanDecisions: number;
  awaitingHuman: number;
  stopReason: string | null;
  risk: string;
  riskOrder: number;
  riskReasons: string | null;
  aiDegraded: boolean;
  deadline: string | null;
  hoursToDeadline: number | null;
  createdAt: string;
  updatedAt: string;
  day: string;
}

export interface StudioStageRow {
  id: string;
  dealId: string;
  stage: string;
  stageOrder: number;
  deals: number;
  valueUsd: number;
}

/** The six kinds of thing that happen to a payment, each a countable column (see PAYMENT_EVENT_GROUP). */
export type PaymentEventGroup = "captures" | "authorizations" | "problems" | "orders" | "releases" | "confirmations";

export interface StudioPaymentEventRow extends Record<PaymentEventGroup, number> {
  id: string;
  dealId: string;
  deal: string;
  at: string;
  day: string;
  type: string;
  events: number;
  amountUsd: number;
  seller: string;
  paymentRail: string | null;
  reference: string | null;
}

export interface StudioCheckRow {
  id: string;
  dealId: string;
  deal: string;
  round: number;
  rule: string;
  kind: string;
  condition: string;
  evaluator: string;
  result: string;
  confidence: number;
  confidenceBand: string;
  required: boolean;
  checks: number;
  passed: number;
  failed: number;
  uncertain: number;
  failPercent: number;
  seller: string;
  at: string;
  day: string;
}

export interface StudioRows {
  deals: StudioDealRow[];
  stages: StudioStageRow[];
  paymentEvents: StudioPaymentEventRow[];
  checks: StudioCheckRow[];
}

/** The honest label of a controlled demo-fault seller ("Demo fault: …"), or null for an ordinary one. */
export function sellerNoteOf(sellerId: string): string | null {
  const fault = demoFaultOf(sellerId);
  return fault === null ? null : DEMO_FAULT_DETAIL[fault];
}

export function toStudioDealRow(row: OpsRow, revisedDealIds: ReadonlySet<string>): StudioDealRow {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    status: row.statusLabel,
    stage: STAGE_LABEL[row.stage],
    stageOrder: STAGE_KEYS.indexOf(row.stage) + 1,
    outcome: OUTCOME_LABEL[row.outcome],
    seller: row.seller,
    sellerTrust: TRUST_LABEL[row.sellerTrust],
    sellerNote: sellerNoteOf(row.sellerId),
    category: row.category === null ? null : CATEGORY_LABEL[row.category],
    origin: ORIGIN_LABEL[row.origin],
    deals: 1,
    priceUsd: minorToUsd(row.priceMinor),
    listPriceUsd: minorToUsd(row.listPriceMinor),
    savedUsd: minorToUsd(row.savedMinor),
    authorizedUsd: minorToUsd(row.authorizedMinor),
    capturedUsd: minorToUsd(row.capturedMinor),
    heldUsd: minorToUsd(row.heldMinor),
    releasedUsd: minorToUsd(releasedMinorOf(row)),
    paymentStatus: PAYMENT_STATUS_TEXT[row.paymentStatus],
    // Simulated payments are named as such in every table, chart and export.
    paymentRail: providerLabel(row.paymentProvider),
    approvalMode: approvalModeLabel(row.paymentMode),
    paypalOrderId: row.paypalOrderId,
    paypalAuthorizationId: row.paypalAuthorizationId,
    paypalCaptureId: row.paypalCaptureId,
    webhookConfirmed: row.webhookConfirmed,
    verification: row.verificationDecision === null ? null : VERIFICATION_LABEL[row.verificationDecision],
    confidence: row.confidence,
    firstPass: firstPassOf(row, revisedDealIds),
    failedRules: row.failedRules,
    revisionsUsed: row.revisionsUsed,
    negotiationMoves: row.negotiationMoves,
    guardrailInterventions: row.guardrailInterventions,
    policy: row.policyOutcome === null ? null : POLICY_LABEL[row.policyOutcome],
    policyFlags: row.policyFlags.length === 0 ? null : row.policyFlags.map(policyFlagText).join("; "),
    humanDecisions: row.humanDecisions,
    awaitingHuman: isAwaitingHuman(row.status) ? 1 : 0,
    stopReason: stopReasonOf(row),
    risk: RISK_LABEL[row.risk],
    riskOrder: RISK_ORDER[row.risk],
    riskReasons: row.riskReasons.length === 0 ? null : row.riskReasons.join("; "),
    aiDegraded: row.aiDegraded,
    deadline: row.deadline,
    hoursToDeadline: row.hoursToDeadline,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    day: row.day,
  };
}

/** One row per stage a deal passed through, each carrying the contract value that got that far. */
export function toStudioStageRows(row: OpsRow): StudioStageRow[] {
  return stagesReached(row).map((stage) => ({
    id: `${row.id}:${stage}`,
    dealId: row.id,
    stage: STAGE_LABEL[stage],
    stageOrder: FUNNEL_STAGES.indexOf(stage) + 1,
    deals: 1,
    valueUsd: minorToUsd(row.priceMinor),
  }));
}

export function toStudioPaymentEventRow(event: OpsPaymentEvent): StudioPaymentEventRow {
  const group = PAYMENT_EVENT_GROUP[event.type];
  const flag = (name: PaymentEventGroup): number => (group === name ? 1 : 0);
  return {
    id: event.id,
    dealId: event.dealId,
    deal: event.dealCode,
    at: event.at,
    day: event.day,
    type: PAYMENT_EVENT_LABEL[event.type],
    events: 1,
    captures: flag("captures"),
    authorizations: flag("authorizations"),
    problems: flag("problems"),
    orders: flag("orders"),
    releases: flag("releases"),
    confirmations: flag("confirmations"),
    amountUsd: minorToUsd(event.amountMinor),
    seller: event.seller,
    paymentRail: providerLabel(event.provider),
    reference: event.reference,
  };
}

export function toStudioCheckRow(check: OpsCheckRow): StudioCheckRow {
  return {
    id: check.id,
    dealId: check.dealId,
    deal: check.dealCode,
    round: check.round,
    rule: check.ruleId,
    kind: ruleKindLabel(check.kind),
    condition: check.condition,
    evaluator: EVALUATOR_LABEL[check.evaluator],
    result: CHECK_RESULT_TEXT[check.result],
    confidence: check.confidence,
    confidenceBand: CONFIDENCE_BANDS[confidenceBandIndex(check.confidence)]!.label,
    required: check.required,
    checks: 1,
    passed: check.result === "pass" ? 1 : 0,
    failed: check.result === "fail" ? 1 : 0,
    uncertain: check.result === "uncertain" ? 1 : 0,
    // `failed` on a 0–100 scale: averaged over any grouping it reads as "percent of conditions that
    // failed", on chart axes as well as in tables (an axis shows numbers, not a field's format).
    failPercent: check.result === "fail" ? 100 : 0,
    seller: check.seller,
    at: check.at,
    // The report's UTC calendar day, the same bucket the deals and payment events use.
    day: check.at.slice(0, 10),
  };
}

export function buildStudioRows(snapshot: Pick<OpsSnapshot, "deals" | "paymentEvents" | "checks">): StudioRows {
  const revised = new Set(snapshot.checks.filter((check) => check.round > 1).map((check) => check.dealId));
  return {
    deals: snapshot.deals.map((row) => toStudioDealRow(row, revised)),
    stages: snapshot.deals.flatMap(toStudioStageRows),
    paymentEvents: snapshot.paymentEvents.map(toStudioPaymentEventRow),
    checks: snapshot.checks.map(toStudioCheckRow),
  };
}

/**
 * A fingerprint of the rows: equal fingerprints mean Studio has nothing to redraw. The
 * snapshot's `generatedAt` changes on every poll and is deliberately not part of it.
 */
export function studioRowsFingerprint(rows: StudioRows): string {
  return JSON.stringify([rows.deals, rows.paymentEvents, rows.checks]);
}
