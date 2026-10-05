/**
 * Deterministic scripted negotiators.
 *
 * They are the fallback when the AI gateway is unavailable and the agents used by tests and
 * end-to-end runs. Like the AI agents they only PROPOSE: every move still goes through
 * applyMove, which enforces the real limits. Messages name concrete trade-offs and never state
 * a private limit (the buyer's budget, the seller's floor).
 */
import type { BuyerContext, SellerContext } from "../ai/types";
import {
  HOUR_MS,
  assertNever,
  deliverableCountLabel,
  formatUtcShort,
  joinList,
  languageName,
  parseTimestamp,
  revisionsLabel,
} from "./format";
import { formatMoney, percentOf, roundToMajor } from "./money";
import { quoteFor } from "./quote";
import type { DeliverableSpec, Mandate, NegotiationMove, Party, ProposedMove, Quote, Terms } from "./schemas";

const MIN_PRICE_MINOR = 100;
const MAX_REVISIONS = 3;

/** Share of the list-to-floor gap the seller has conceded by its 1st..4th move, in percent. */
const SELLER_CONCESSION_PERCENT = [0, 45, 80, 100] as const;
/** Share of its target price the buyer offers on its 1st..4th move, in percent. */
const BUYER_OFFER_PERCENT = [80, 90, 96, 100] as const;

function latestOfferTerms(history: readonly NegotiationMove[], party: Party): Terms | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const move = history[i];
    if (move.actor === party && (move.action === "offer" || move.action === "counter") && move.terms !== null) {
      return move.terms;
    }
  }
  return null;
}

function ownMoveNumber(history: readonly NegotiationMove[], party: Party): number {
  return history.filter((move) => move.actor === party).length + 1;
}

/** The rung for a 1-based move number; moves beyond the ladder stay on its last rung. */
function ladderStep(ladder: readonly number[], moveNumber: number): number {
  return ladder[Math.min(Math.max(moveNumber, 1), ladder.length) - 1];
}

function scopeLabel(deliverable: DeliverableSpec, count: number): string {
  switch (deliverable.kind) {
    case "illustration":
      return `${deliverableCountLabel("illustration", count)} in ${joinList(deliverable.aspectRatios)}`;
    case "copy":
      return `${deliverableCountLabel("copy", count)} of ${deliverable.minWords}–${deliverable.maxWords} words in ${joinList(
        deliverable.languages.map(languageName),
      )}`;
    default:
      return assertNever(deliverable);
  }
}

function termsLabel(terms: Terms, kind: DeliverableSpec["kind"]): string {
  return `${deliverableCountLabel(kind, terms.count)} with ${revisionsLabel(terms.revisionLimit)}, delivered by ${formatUtcShort(terms.deadline)}`;
}

/* -------------------------------------------------------------------------- */
/*  Seller                                                                     */
/* -------------------------------------------------------------------------- */

function sellerLadderPrice(quote: Quote, moveNumber: number): number {
  const conceded = ladderStep(SELLER_CONCESSION_PERCENT, moveNumber);
  const gap = Math.max(0, quote.listMinor - quote.floorMinor);
  const price = quote.listMinor - Math.round((gap * conceded) / 100);
  return Math.max(quote.floorMinor, roundToMajor(price), MIN_PRICE_MINOR);
}

function ceilToHour(ms: number): number {
  return Math.ceil(ms / HOUR_MS) * HOUR_MS;
}

/**
 * The seller's own floor for the exact terms it is about to propose. `ctx.quote` prices the
 * buyer's request, which can differ from what the seller offers back (another deadline, another
 * number of revisions); a script must never ask for less than its floor for its own terms.
 */
function atLeastOwnFloor(ctx: SellerContext, terms: Terms): Terms {
  const floorMinor = quoteFor(ctx.seller, ctx.deliverable, terms, ctx.now).floorMinor;
  return terms.priceMinor >= floorMinor ? terms : { ...terms, priceMinor: floorMinor };
}

/**
 * The seller's answer to the request for quote: the requested scope at list price. The quote is
 * priced for exactly these terms, so the opening offer and its price always describe the same job.
 * Only a deadline the studio cannot meet is replaced, by the earliest one it can commit to.
 */
function sellerOpening(ctx: SellerContext, moveNumber: number): ProposedMove {
  const { requested } = ctx;
  const earliestMs = ctx.now.getTime() + ctx.quote.minHours * HOUR_MS;
  const requestedMs = parseTimestamp(requested.deadline);
  const deadlineMs =
    requestedMs !== null && requestedMs >= earliestMs
      ? requestedMs
      : // Rounded UP to the hour so the proposed lead time never dips under the quoted turnaround.
        ceilToHour(earliestMs);
  const terms = atLeastOwnFloor(ctx, {
    priceMinor: sellerLadderPrice(ctx.quote, moveNumber),
    deadline: new Date(deadlineMs).toISOString(),
    revisionLimit: Math.min(Math.max(requested.revisionLimit, 0), MAX_REVISIONS),
    count: Math.min(Math.max(requested.count, 1), ctx.deliverable.count),
  });
  return {
    action: "offer",
    terms,
    message: `We can deliver ${scopeLabel(ctx.deliverable, terms.count)} by ${formatUtcShort(terms.deadline)} for ${formatMoney(
      terms.priceMinor,
    )}, with ${revisionsLabel(terms.revisionLimit)} included.`,
  };
}

function sellerCounterMessage(
  terms: Terms,
  kind: DeliverableSpec["kind"],
  variant: "deadline" | "final" | "early" | "late",
  askedDeadline: string,
): string {
  const price = formatMoney(terms.priceMinor);
  switch (variant) {
    case "deadline":
      return `We can't turn this around by ${formatUtcShort(askedDeadline)}; the earliest we can commit to is ${formatUtcShort(
        terms.deadline,
      )}, at ${price} for ${deliverableCountLabel(kind, terms.count)} with ${revisionsLabel(terms.revisionLimit)}.`;
    case "final":
      return `Final offer: ${price} for ${termsLabel(terms, kind)}.`;
    case "early":
      return `We can come down to ${price} for ${deliverableCountLabel(kind, terms.count)}, keeping ${revisionsLabel(
        terms.revisionLimit,
      )} and delivery by ${formatUtcShort(terms.deadline)}.`;
    case "late":
      return `We can stretch to ${price} as long as the scope stays at ${termsLabel(terms, kind)}.`;
    default:
      return assertNever(variant);
  }
}

/**
 * Seller script: answer the request for quote at list, concede along a fixed ladder towards the
 * floor, accept as soon as the buyer's price reaches the next rung and the deadline is feasible.
 */
export function scriptedSellerMove(ctx: SellerContext): ProposedMove {
  const kind = ctx.deliverable.kind;
  const moveNumber = ownMoveNumber(ctx.history, "seller");
  const asked = latestOfferTerms(ctx.history, "buyer");
  const mustClose = ctx.movesRemaining <= 1;
  // With two or fewer moves left the seller will not get another turn: this is its last word.
  const lastWord = ctx.movesRemaining <= 2;
  const walkAway: ProposedMove = {
    action: "reject",
    terms: null,
    message: "We can't make this scope work at that price, so we'll pass this time. Thank you for considering us.",
  };

  if (asked === null) return mustClose ? walkAway : sellerOpening(ctx, moveNumber);

  const earliestMs = ctx.now.getTime() + ctx.quote.minHours * HOUR_MS;
  const askedDeadlineMs = parseTimestamp(asked.deadline);
  const deadlineFeasible = askedDeadlineMs !== null && askedDeadlineMs >= earliestMs;
  const scopeFeasible =
    asked.count >= 1 && asked.count <= ctx.deliverable.count && asked.revisionLimit <= MAX_REVISIONS;
  const askPrice = lastWord ? Math.max(ctx.quote.floorMinor, MIN_PRICE_MINOR) : sellerLadderPrice(ctx.quote, moveNumber);
  // The engine would veto an accept under the floor for the buyer's exact terms; do not propose one.
  const clearsOwnFloor =
    scopeFeasible && asked.priceMinor >= quoteFor(ctx.seller, ctx.deliverable, asked, ctx.now).floorMinor;

  if (asked.priceMinor >= askPrice && deadlineFeasible && clearsOwnFloor) {
    return {
      action: "accept",
      terms: null,
      message: `Agreed: ${formatMoney(asked.priceMinor)} for ${termsLabel(asked, kind)}. We'll start as soon as the funds are authorized.`,
    };
  }
  if (mustClose) return walkAway;

  const terms = atLeastOwnFloor(ctx, {
    // Never undercut a price the buyer has already put on the table.
    priceMinor: Math.max(askPrice, asked.priceMinor),
    deadline: deadlineFeasible ? asked.deadline : new Date(ceilToHour(earliestMs)).toISOString(),
    revisionLimit: Math.min(asked.revisionLimit, MAX_REVISIONS),
    count: Math.min(Math.max(asked.count, 1), ctx.deliverable.count),
  });
  const variant = !deadlineFeasible ? "deadline" : lastWord ? "final" : moveNumber <= 2 ? "early" : "late";
  return { action: "counter", terms, message: sellerCounterMessage(terms, kind, variant, asked.deadline) };
}

/* -------------------------------------------------------------------------- */
/*  Buyer                                                                      */
/* -------------------------------------------------------------------------- */

function withinMandate(terms: Terms, mandate: Mandate): boolean {
  const deadlineMs = parseTimestamp(terms.deadline);
  const latestMs = parseTimestamp(mandate.deadline);
  return (
    terms.priceMinor <= mandate.budgetMinor &&
    deadlineMs !== null &&
    latestMs !== null &&
    deadlineMs <= latestMs &&
    terms.count >= mandate.minCount &&
    terms.count <= mandate.deliverable.count &&
    terms.revisionLimit >= mandate.minRevisions
  );
}

function buyerLadderPrice(targetMinor: number, budgetMinor: number, moveNumber: number): number {
  const share = ladderStep(BUYER_OFFER_PERCENT, moveNumber);
  // Whole dollars, and the cap is the budget rounded DOWN so rounding can never exceed it.
  const cap = Math.max(MIN_PRICE_MINOR, Math.floor(budgetMinor / 100) * 100);
  return Math.min(Math.max(roundToMajor(percentOf(targetMinor, share)), MIN_PRICE_MINOR), cap);
}

function buyerOfferMessage(terms: Terms, kind: DeliverableSpec["kind"], moveNumber: number, termsMismatch: boolean): string {
  const price = formatMoney(terms.priceMinor);
  if (termsMismatch) {
    return `We need ${termsLabel(terms, kind)}; on those terms we can offer ${price}.`;
  }
  if (moveNumber === 1) {
    return `Thanks for the quote. For ${termsLabel(terms, kind)}, we can offer ${price}.`;
  }
  if (moveNumber === 2) {
    return `We can move up to ${price}, provided ${revisionsLabel(terms.revisionLimit)} and delivery by ${formatUtcShort(
      terms.deadline,
    )} stay in.`;
  }
  return `${price} is a stretch for this scope; we can do it if you keep ${revisionsLabel(
    terms.revisionLimit,
  )} and deliver by ${formatUtcShort(terms.deadline)}.`;
}

/**
 * Buyer script: aim for the lower of the budget and the seller's opening price, climb a fixed
 * ladder towards that target, and accept as soon as the seller's price is at or under the next
 * rung and the seller's terms are inside the mandate.
 */
export function scriptedBuyerMove(ctx: BuyerContext): ProposedMove {
  const { mandate } = ctx;
  const kind = mandate.deliverable.kind;
  const moveNumber = ownMoveNumber(ctx.history, "buyer");
  const mustClose = ctx.movesRemaining <= 1;
  const sellerTerms = latestOfferTerms(ctx.history, "seller");
  const opening = ctx.history.find((move) => move.actor === "seller" && move.terms !== null)?.terms ?? null;

  const targetMinor = Math.min(mandate.budgetMinor, opening?.priceMinor ?? mandate.budgetMinor);
  const ladderPrice = buyerLadderPrice(targetMinor, mandate.budgetMinor, moveNumber);

  const sellerAcceptable = sellerTerms !== null && withinMandate(sellerTerms, mandate);
  if (sellerTerms !== null && sellerAcceptable && (mustClose || sellerTerms.priceMinor <= ladderPrice)) {
    return {
      action: "accept",
      terms: null,
      message: `Agreed at ${formatMoney(sellerTerms.priceMinor)} for ${termsLabel(sellerTerms, kind)}. Let's put it in a contract.`,
    };
  }
  if (mustClose) {
    return {
      action: "reject",
      terms: null,
      message: "We couldn't reach terms that work for this job, so we'll leave it here. Thank you for your time.",
    };
  }

  const terms: Terms = {
    // Never offer more than the seller is already asking.
    priceMinor: sellerTerms === null ? ladderPrice : Math.max(MIN_PRICE_MINOR, Math.min(ladderPrice, sellerTerms.priceMinor)),
    deadline: mandate.deadline,
    revisionLimit: Math.max(mandate.revisionsWanted, mandate.minRevisions),
    count: mandate.deliverable.count,
  };
  const priceAlreadyFine = sellerTerms !== null && sellerTerms.priceMinor <= ladderPrice;
  return {
    action: moveNumber === 1 ? "offer" : "counter",
    terms,
    message: buyerOfferMessage(terms, kind, moveNumber, priceAlreadyFine && !sellerAcceptable),
  };
}
