/**
 * View model of the "Human review queue" widget: the deals that are waiting for a person.
 *
 * PACT stops for a human in exactly two places that hold a decision about money: the spending
 * policy asks for approval before any order exists, and an inconclusive verification asks for a
 * review while the authorization is held. Everything else either runs by itself or has ended.
 */
import type { DealView } from "../api/dto";
import { DEAL_STATUS_LABEL } from "../domain/status";

export type ReviewGate = "approval" | "review";

export interface ReviewQueueInputRow {
  deal: unknown;
  status: unknown;
  seller?: unknown;
  amount?: unknown;
  reason?: unknown;
  since?: unknown;
}

export interface ReviewQueueItem {
  code: string;
  gate: ReviewGate;
  /** What the person is being asked to do. */
  ask: string;
  seller: string | null;
  amountUsd: number | null;
  reason: string | null;
  /** When the deal last moved, i.e. since when it has been waiting; null when no timestamp is mapped. */
  sinceMs: number | null;
}

export interface ReviewQueueModel {
  items: ReviewQueueItem[];
  /** Deals waiting beyond the ones listed. */
  hidden: number;
  total: number;
  approvals: number;
  reviews: number;
}

const GATE_BY_STATUS: ReadonlyMap<string, ReviewGate> = new Map([
  [DEAL_STATUS_LABEL.awaiting_approval.toLowerCase(), "approval"],
  ["awaiting_approval", "approval"],
  [DEAL_STATUS_LABEL.in_review.toLowerCase(), "review"],
  ["in_review", "review"],
]);

const GATE_ASK: Record<ReviewGate, string> = {
  approval: "Approve or decline the spend",
  review: "Review the delivery",
};

/** Which human gate a status (label or raw key) is, or null when the deal is not waiting for anyone. */
export function reviewGateOf(status: unknown): ReviewGate | null {
  return typeof status === "string" ? (GATE_BY_STATUS.get(status.trim().toLowerCase()) ?? null) : null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Studio returns datetimes as Date objects or ISO strings depending on the path the row took. */
export function toEpochMs(value: unknown): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * The queue, longest-waiting first: a queue is read from the top, and the deal that has held
 * money or a seller's time the longest is the one to look at.
 */
export function buildReviewQueue(rows: readonly ReviewQueueInputRow[], maxItems: number): ReviewQueueModel {
  const waiting: ReviewQueueItem[] = [];
  for (const row of rows) {
    const gate = reviewGateOf(row.status);
    const code = textOf(row.deal);
    if (gate === null || code === null) continue;
    waiting.push({
      code,
      gate,
      ask: GATE_ASK[gate],
      seller: textOf(row.seller),
      amountUsd: typeof row.amount === "number" && Number.isFinite(row.amount) ? row.amount : null,
      reason: textOf(row.reason),
      sinceMs: toEpochMs(row.since),
    });
  }
  waiting.sort((a, b) => (a.sinceMs ?? Number.POSITIVE_INFINITY) - (b.sinceMs ?? Number.POSITIVE_INFINITY) || a.code.localeCompare(b.code));
  const limit = Math.max(1, Math.floor(maxItems));
  return {
    items: waiting.slice(0, limit),
    hidden: Math.max(0, waiting.length - limit),
    total: waiting.length,
    approvals: waiting.filter((item) => item.gate === "approval").length,
    reviews: waiting.filter((item) => item.gate === "review").length,
  };
}

/**
 * The engine's own account of why a deal stopped, read from the deal itself: the detail
 * sentences of the policy checks that did not pass, or the verifier's summary of the latest
 * report. Null when the deal offers nothing more specific than the ledger row already says.
 */
export function reviewReasonFromDeal(deal: Pick<DealView, "status" | "policy" | "reports">): string | null {
  if (deal.status === "awaiting_approval") {
    const details = (deal.policy?.checks ?? []).filter((check) => check.outcome !== "pass").map((check) => check.detail.trim());
    return details.length > 0 ? details.join(" ") : null;
  }
  if (deal.status === "in_review") {
    const summary = deal.reports[deal.reports.length - 1]?.summary.trim() ?? "";
    return summary.length > 0 ? summary : null;
  }
  return null;
}
