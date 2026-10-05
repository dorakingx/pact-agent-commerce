/**
 * The data behind the Agent Commerce Operations dashboard (AG Grid / AG Studio read it as three
 * flat data sources: deals, payment events and verification checks).
 *
 * Everything here is a READ MODEL: it is derived from the stored deal graph on every request
 * and never written back, so a figure on the dashboard can always be traced to the contract,
 * the payment record, a verification report or an audit event. The mapping functions are pure;
 * only getOpsSnapshot touches the database, with a fixed number of statements however many
 * deals are shown.
 */
import "server-only";
import type { OpsCheckRow, OpsPaymentEvent, OpsRow, OpsSnapshot } from "../api/dto";
import { listDealsForOwners, loadDealGraphs, type DealGraph } from "../db";
import { HOUR_MS, assertNever, parseTimestamp, singleLine, truncate } from "../domain/format";
import { isMinor } from "../domain/money";
import { assessRisk } from "../domain/risk";
import type { AuditEventType } from "../domain/schemas";
import { BUYER_IDENTITY, getSeller } from "../domain/sellers";
import { DEAL_STATUS_LABEL, type DealStatus } from "../domain/status";
import type { ProviderKind } from "../payments/types";
import type { ServiceContext } from "./context";
import { SYSTEM_OWNER } from "./session";

/** Most recent deals shown. Keeps the snapshot a bounded payload and a bounded query. */
export const OPS_DEAL_LIMIT = 300;

/** Shown wherever a deal has no seller the directory knows (none matched, or since removed). */
export const UNKNOWN_SELLER = "—";

const TITLE_FALLBACK_CHARS = 80;
const HUMAN_EVENT_PREFIX = "human.";

/* -------------------------------------------------------------------------- */
/*  Deal rows                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Funnel stage. Open deals are placed by the work that is in progress; "revision_required"
 * counts as fulfillment because the seller is producing again, and "rejecting" as verification
 * because its consequence (the void) has not happened yet. Only a capture is "settled"; every
 * other terminal state is "closed".
 */
function stageOf(status: DealStatus): OpsRow["stage"] {
  switch (status) {
    case "negotiating":
    case "agreed":
      return "negotiation";
    case "contracted":
    case "awaiting_approval":
      return "contract";
    case "payment_pending":
    case "awaiting_payment":
      return "payment";
    case "authorized":
    case "revision_required":
      return "fulfillment";
    case "submitted":
    case "in_review":
    case "verified":
    case "rejecting":
      return "verification";
    case "completed":
      return "settled";
    case "rejected":
    case "declined":
    case "blocked":
    case "negotiation_failed":
    case "cancelled":
    case "expired":
    case "failed":
      return "closed";
    default:
      return assertNever(status);
  }
}

/**
 * Final outcome. "voided" groups every ending in which a hold (or an unapproved order) was
 * released without a capture: a rejected delivery, a payer who cancelled, an authorization that
 * lapsed. Anything not terminal is "in_progress".
 */
function outcomeOf(status: DealStatus): OpsRow["outcome"] {
  switch (status) {
    case "completed":
      return "captured";
    case "rejected":
    case "cancelled":
    case "expired":
      return "voided";
    case "declined":
      return "declined";
    case "blocked":
      return "blocked";
    case "negotiation_failed":
      return "no_agreement";
    case "failed":
      return "failed";
    case "negotiating":
    case "agreed":
    case "contracted":
    case "awaiting_approval":
    case "payment_pending":
    case "awaiting_payment":
    case "authorized":
    case "submitted":
    case "revision_required":
    case "in_review":
    case "verified":
    case "rejecting":
      return "in_progress";
    default:
      return assertNever(status);
  }
}

/** Title: the contract's, else the buyer agent's one-line mandate, else the start of the human's request. */
function titleOf(graph: DealGraph): string {
  return (
    graph.signed?.contract.title ??
    graph.deal.mandate?.summary ??
    truncate(singleLine(graph.deal.intent), TITLE_FALLBACK_CHARS)
  );
}

interface SellerRef {
  id: string;
  name: string;
  trust: OpsRow["sellerTrust"];
  /** False when the directory has no such seller: its trust is then unknown, not "new". */
  known: boolean;
}

/**
 * Seller columns come from the directory, the same source the policy engine reads trust from.
 * An unknown seller is shown as "—" with trust "new" (no settled history is the only safe
 * reading), and is not reported to the risk rating as a new seller.
 */
function sellerOf(graph: DealGraph): SellerRef {
  const id = graph.deal.sellerId;
  const profile = id === null ? undefined : getSeller(id);
  if (profile) return { id: profile.id, name: profile.name, trust: profile.trust, known: true };
  return { id: id ?? UNKNOWN_SELLER, name: UNKNOWN_SELLER, trust: "new", known: false };
}

/** The seller's opening offer is its list price: the first seller move that carries terms. */
function listPriceOf(graph: DealGraph): number {
  const opening = graph.moves.find((move) => move.actor === "seller" && move.terms !== null);
  return opening?.terms?.priceMinor ?? 0;
}

/** The deadline in force: the contract's once signed, before that the agreed or requested one. */
function deadlineOf(graph: DealGraph): string | null {
  return (
    graph.signed?.contract.deadline ??
    graph.deal.deadline ??
    graph.deal.agreedTerms?.deadline ??
    graph.deal.mandate?.deadline ??
    null
  );
}

/** Hours until the deadline to one decimal; negative once it has passed. */
function hoursUntil(iso: string | null, now: Date): number | null {
  if (iso === null) return null;
  const at = parseTimestamp(iso);
  if (at === null) return null;
  const hours = Math.round(((at - now.getTime()) / HOUR_MS) * 10) / 10;
  // Math.round can produce -0, which JSON would print as 0 but strict comparisons would not equal.
  return hours === 0 ? 0 : hours;
}

/**
 * One row of the operations ledger.
 *
 * Money columns: `priceMinor` is the contract price and stays 0 until a contract exists, so a
 * deal that never got that far adds nothing to any total. `savedMinor` is what negotiation took
 * off the seller's opening price, reported only once there is a contract price to compare with.
 * `heldMinor` is authorized-minus-captured while PayPal still holds the authorization
 * (payment status "authorized") and 0 in every other state: after a capture or a void nothing
 * is held, whatever the amounts say.
 */
export function toOpsRow(graph: DealGraph, viewerSessionId: string | null, now: Date): OpsRow {
  const { deal, payment, signed } = graph;
  const seller = sellerOf(graph);
  const latestReport = graph.reports[graph.reports.length - 1] ?? null;
  const priceMinor = signed?.contract.price.amountMinor ?? 0;
  const listPriceMinor = listPriceOf(graph);
  const authorizedMinor = payment?.authorizedMinor ?? 0;
  const capturedMinor = payment?.capturedMinor ?? 0;
  const paymentStatus = payment?.status ?? "none";
  const revisionLimit = signed?.contract.revisionLimit ?? deal.revisionLimit ?? 0;
  const deadline = deadlineOf(graph);
  const policy = deal.policyEvaluation;
  const confirmed = payment?.webhookConfirmed;
  const risk = assessRisk({
    status: deal.status,
    deadline,
    now,
    sellerTrust: seller.known ? seller.trust : null,
    verificationDecision: latestReport?.decision ?? null,
    revisionsUsed: deal.revisionsUsed,
    revisionLimit,
    aiDegraded: deal.aiDegraded,
    policyOutcome: policy?.outcome ?? null,
    paymentStatus,
    authorizationExpiresAt: payment?.authorizationExpiresAt ?? null,
  });

  return {
    id: deal.id,
    code: deal.code,
    title: titleOf(graph),
    status: deal.status,
    statusLabel: DEAL_STATUS_LABEL[deal.status],
    stage: stageOf(deal.status),
    outcome: outcomeOf(deal.status),
    buyer: BUYER_IDENTITY.name,
    seller: seller.name,
    sellerId: seller.id,
    sellerTrust: seller.trust,
    category: deal.category,
    scenarioId: deal.scenarioId,
    // The snapshot only ever contains the viewer's own deals and the seeded ones.
    origin: viewerSessionId !== null && deal.owner === viewerSessionId ? "mine" : "showcase",
    priceMinor,
    listPriceMinor,
    savedMinor: signed === null ? 0 : Math.max(0, listPriceMinor - priceMinor),
    authorizedMinor,
    capturedMinor,
    heldMinor: paymentStatus === "authorized" ? Math.max(0, authorizedMinor - capturedMinor) : 0,
    currency: "USD",
    paymentStatus,
    paymentProvider: payment?.provider ?? null,
    paymentMode: payment?.mode ?? null,
    paypalOrderId: payment?.orderId ?? null,
    paypalAuthorizationId: payment?.authorizationId ?? null,
    paypalCaptureId: payment?.captureId ?? null,
    webhookConfirmed: confirmed !== undefined && (confirmed.authorized || confirmed.captured || confirmed.voided),
    // Verification columns describe the LATEST report: after a revision, the one that counted.
    verificationDecision: latestReport?.decision ?? null,
    confidence: latestReport?.confidence ?? null,
    failedRules: latestReport?.failedRuleIds.length ?? 0,
    revisionsUsed: deal.revisionsUsed,
    revisionLimit,
    negotiationMoves: graph.moves.length,
    // A move counts once however many corrections the rules engine made to it.
    guardrailInterventions: graph.moves.filter((move) => move.guardrails.length > 0).length,
    policyOutcome: policy?.outcome ?? null,
    policyFlags: policy?.checks.filter((check) => check.outcome !== "pass").map((check) => check.id) ?? [],
    // Every decision a person made is its own "human.*" event; the original request is not one.
    humanDecisions: graph.audit.filter((event) => event.type.startsWith(HUMAN_EVENT_PREFIX)).length,
    risk: risk.level,
    riskReasons: risk.reasons,
    aiDegraded: deal.aiDegraded,
    deadline,
    hoursToDeadline: hoursUntil(deadline, now),
    createdAt: deal.createdAt,
    updatedAt: deal.updatedAt,
    day: dayOf(deal.createdAt),
  };
}

/** UTC calendar day of a canonical ISO timestamp. */
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/*  Payment events                                                             */
/* -------------------------------------------------------------------------- */

type PaymentAuditType = Extract<AuditEventType, `payment.${string}`>;
type PaymentEventKind = OpsPaymentEvent["type"];

/**
 * Every payment.* audit type and its row type. Typed as a complete record on purpose: a new
 * payment event in the domain does not compile until the dashboard knows about it.
 */
const PAYMENT_EVENT_KIND: Record<PaymentAuditType, PaymentEventKind> = {
  "payment.order_created": "order_created",
  "payment.approved": "approved",
  "payment.authorized": "authorized",
  "payment.capture_blocked": "capture_blocked",
  "payment.capture_pending": "capture_pending",
  "payment.captured": "captured",
  "payment.voided": "voided",
  "payment.cancelled": "cancelled",
  "payment.expired": "expired",
  "payment.failed": "failed",
  "payment.webhook": "webhook",
  "payment.reconciled": "reconciled",
};

function isPaymentAuditType(type: AuditEventType): type is PaymentAuditType {
  return type.startsWith("payment.");
}

function textField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function providerField(data: Record<string, unknown>): ProviderKind | null {
  const value = data.provider;
  return value === "paypal_sandbox" || value === "simulated" ? value : null;
}

/** The most specific PayPal id the event is about: capture, then authorization, then order. */
function referenceOf(kind: PaymentEventKind, data: Record<string, unknown>): string | null {
  const order = textField(data, "orderId");
  const authorization = textField(data, "authorizationId");
  const capture = textField(data, "captureId");
  switch (kind) {
    case "order_created":
    case "approved":
    case "cancelled":
      return order;
    case "authorized":
    case "capture_blocked":
    case "capture_pending":
    case "voided":
    case "expired":
      return authorization ?? order;
    case "captured":
    case "failed":
    case "webhook":
    case "reconciled":
      return capture ?? authorization ?? order;
    default:
      return assertNever(kind);
  }
}

/**
 * One row per payment.* audit event, in the order they were recorded. The amount is the one
 * the event itself states (`data.amountMinor`) and 0 when it states none: the dashboard never
 * attributes money to an event that did not move or hold any.
 */
export function toOpsPaymentEvents(graph: DealGraph): OpsPaymentEvent[] {
  const seller = sellerOf(graph).name;
  const rows: OpsPaymentEvent[] = [];
  for (const event of graph.audit) {
    if (!isPaymentAuditType(event.type)) continue;
    const kind = PAYMENT_EVENT_KIND[event.type];
    const data = event.data ?? {};
    rows.push({
      id: event.id,
      dealId: graph.deal.id,
      dealCode: graph.deal.code,
      at: event.at,
      day: dayOf(event.at),
      type: kind,
      amountMinor: isMinor(data.amountMinor) ? data.amountMinor : 0,
      seller,
      provider: providerField(data) ?? graph.payment?.provider ?? null,
      reference: referenceOf(kind, data),
    });
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/*  Verification checks                                                        */
/* -------------------------------------------------------------------------- */

/** Every check of every report (all rounds), for failure analysis by rule, seller and evaluator. */
export function toOpsCheckRows(graph: DealGraph): OpsCheckRow[] {
  const seller = sellerOf(graph).name;
  return graph.reports.flatMap((report) =>
    report.checks.map((check) => ({
      id: `${report.id}:${check.ruleId}`,
      dealId: graph.deal.id,
      dealCode: graph.deal.code,
      round: report.round,
      ruleId: check.ruleId,
      kind: check.kind,
      condition: check.condition,
      evaluator: check.evaluator,
      result: check.result,
      confidence: check.confidence,
      required: check.required,
      seller,
      at: report.createdAt,
    })),
  );
}

/* -------------------------------------------------------------------------- */
/*  Totals                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Money PayPal released without it being captured: the whole authorization of a voided or
 * expired payment, and the uncaptured remainder of a partial capture (PACT always captures
 * with final_capture, so the remainder is released at once).
 */
function releasedMinorOf(row: OpsRow): number {
  switch (row.paymentStatus) {
    case "voided":
    case "expired":
      return row.authorizedMinor;
    case "captured":
      return Math.max(0, row.authorizedMinor - row.capturedMinor);
    case "none":
    case "created":
    case "approved":
    case "authorized":
    case "failed":
      return 0;
    default:
      return assertNever(row.paymentStatus);
  }
}

function rate(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 10_000) / 10_000;
}

/**
 * Ledger totals. For every payment that is not "failed",
 * authorized = captured + held + released.
 *
 * The two verification rates are about FIRST deliveries, the honest measure of seller quality:
 * a deal that was captured after a revision still failed its first verification. A row only
 * carries its latest decision, so the first one is recovered from the check rows: a deal with
 * a second round cannot have passed the first (the state machine has no path from a
 * capture-eligible report back to a delivery), and a deal with a single round is described by
 * its latest decision. Both rates are 0 when no delivery has been verified yet.
 */
export function summarize(rows: OpsRow[], checks: OpsCheckRow[]): OpsSnapshot["totals"] {
  const revised = new Set(checks.filter((check) => check.round > 1).map((check) => check.dealId));
  const verified = rows.filter((row) => row.verificationDecision !== null);
  const firstFailures = verified.filter(
    (row) => revised.has(row.id) || row.verificationDecision !== "capture_eligible",
  ).length;
  const sum = (pick: (row: OpsRow) => number): number => rows.reduce((total, row) => total + pick(row), 0);

  return {
    deals: rows.length,
    authorizedMinor: sum((row) => row.authorizedMinor),
    capturedMinor: sum((row) => row.capturedMinor),
    heldMinor: sum((row) => row.heldMinor),
    releasedMinor: sum(releasedMinorOf),
    pendingHumanReview: rows.filter((row) => row.status === "awaiting_approval" || row.status === "in_review").length,
    verificationFailureRate: rate(firstFailures, verified.length),
    firstPassRate: rate(verified.length - firstFailures, verified.length),
  };
}

/* -------------------------------------------------------------------------- */
/*  Snapshot                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The viewer's own deals plus the seeded showcase deals, newest first. Without a session only
 * the showcase is visible. Two repository calls (eight statements) regardless of how many deals
 * there are; artifact bodies are never read.
 */
export async function getOpsSnapshot(ctx: ServiceContext, viewerSessionId: string | null): Promise<OpsSnapshot> {
  const now = ctx.now();
  const owners = viewerSessionId === null ? [SYSTEM_OWNER] : [viewerSessionId, SYSTEM_OWNER];
  const listed = await listDealsForOwners(ctx.db, owners, OPS_DEAL_LIMIT);
  // The map iterates in the order the ids were given, so "newest first" survives the batch load.
  const graphs = [...(await loadDealGraphs(ctx.db, listed.map((deal) => deal.id), { artifacts: false })).values()];

  const deals = graphs.map((graph) => toOpsRow(graph, viewerSessionId, now));
  const checks = graphs.flatMap(toOpsCheckRows);
  return {
    generatedAt: now.toISOString(),
    deals,
    paymentEvents: graphs.flatMap(toOpsPaymentEvents),
    checks,
    totals: summarize(deals, checks),
  };
}
