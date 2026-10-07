/**
 * Pure view logic for the negotiation transcript: what changed in each move compared with the
 * same party's previous position, and the one-sentence result.
 */
import type { DealView } from "@/lib/api/dto";
import { formatDuration, plural } from "@/lib/domain/format";
import { formatMoney } from "@/lib/domain/money";
import type { MoveAction, NegotiationMove, Party, Terms } from "@/lib/domain/schemas";

export const MOVE_ACTION_LABEL: Record<MoveAction, string> = {
  offer: "Offer",
  counter: "Counter",
  accept: "Accept",
  reject: "Walk away",
};

/** Signed change against the same party's previous terms. 0 means "unchanged". */
export interface TermsDelta {
  priceMinor: number;
  deadlineMs: number;
  revisionLimit: number;
  count: number;
}

export interface MoveView {
  move: NegotiationMove;
  /**
   * How this move differs from what the same party last put on the table. Null on a party's
   * first position and on moves that carry no terms.
   */
  delta: TermsDelta | null;
}

function deltaBetween(previous: Terms, current: Terms): TermsDelta {
  return {
    priceMinor: current.priceMinor - previous.priceMinor,
    deadlineMs: Date.parse(current.deadline) - Date.parse(previous.deadline),
    revisionLimit: current.revisionLimit - previous.revisionLimit,
    count: current.count - previous.count,
  };
}

/**
 * Pair every move with its delta. An acceptance is compared too: accepting the other side's
 * terms is that party's final concession, and the transcript should show how far it moved.
 */
export function annotateMoves(moves: readonly NegotiationMove[]): MoveView[] {
  const lastTerms: Record<Party, Terms | null> = { buyer: null, seller: null };
  return moves.map((move) => {
    if (move.terms === null) return { move, delta: null };
    const previous = lastTerms[move.actor];
    lastTerms[move.actor] = move.terms;
    return { move, delta: previous === null ? null : deltaBetween(previous, move.terms) };
  });
}

/** "▼ $6.00" / "▲ $2.00"; null when the price did not move. */
export function priceDeltaLabel(deltaMinor: number): string | null {
  if (deltaMinor === 0) return null;
  return `${deltaMinor < 0 ? "▼" : "▲"} ${formatMoney(Math.abs(deltaMinor))}`;
}

/** "▲ 1" / "▼ 2" for counts and revision rounds. */
export function countDeltaLabel(delta: number): string | null {
  if (delta === 0) return null;
  return `${delta < 0 ? "▼" : "▲"} ${Math.abs(delta)}`;
}

/** "+1d 2h" / "−6h" for a deadline that moved. */
export function deadlineDeltaLabel(deltaMs: number): string | null {
  if (deltaMs === 0 || Number.isNaN(deltaMs)) return null;
  return `${deltaMs < 0 ? "−" : "+"}${formatDuration(deltaMs)}`;
}

/** Whose move is due: the seller opens, then strict alternation (same rule as the engine). */
export function nextNegotiator(moves: readonly Pick<NegotiationMove, "actor">[]): Party {
  const last = moves[moves.length - 1];
  if (last === undefined) return "seller";
  return last.actor === "seller" ? "buyer" : "seller";
}

/** How many times the rules engine had to correct or veto an agent. */
export function guardrailCount(moves: readonly Pick<NegotiationMove, "guardrails">[]): number {
  return moves.reduce((total, move) => total + move.guardrails.length, 0);
}

export interface NegotiationResult {
  tone: "success" | "neutral";
  text: string;
}

/**
 * "Agreed at $47.00 — $6.00 under the opening quote, in 6 moves." Null while the agents are
 * still talking.
 */
export function negotiationResult(negotiation: DealView["negotiation"]): NegotiationResult | null {
  if (negotiation.status === "open") return null;
  if (negotiation.status === "failed") {
    return { tone: "neutral", text: negotiation.failureReason ?? "The agents could not agree on terms." };
  }
  const agreed = negotiation.agreedTerms?.priceMinor;
  if (agreed === undefined) return null;
  const moves = plural(negotiation.moves.length, "move");
  const list = negotiation.listPriceMinor;
  const price = formatMoney(agreed);
  if (list === null || list === agreed) {
    return { tone: "success", text: `Agreed at ${price} — the opening quote, in ${moves}.` };
  }
  const difference = formatMoney(Math.abs(list - agreed));
  return {
    tone: "success",
    text: `Agreed at ${price} — ${difference} ${agreed < list ? "under" : "over"} the opening quote, in ${moves}.`,
  };
}
