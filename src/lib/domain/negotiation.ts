/**
 * Negotiation rules engine.
 *
 * Agents (AI or scripted) only PROPOSE moves. This module decides what is actually recorded:
 * it enforces turn order, clamps every offer to the proposing party's private limits, and
 * vetoes an acceptance that would bind a party to terms outside those limits. Every correction
 * is recorded on the move as a GuardrailNote, so the transcript shows exactly where the engine
 * overruled an agent.
 *
 * The seller moves first (its list offer answers the buyer's request for quote), then the
 * parties alternate for at most MAX_MOVES moves.
 */
import type { BuyerContext, RequestedTerms, SellerContext } from "../ai/types";
import {
  HOUR_MS,
  assertNever,
  deliverableCountLabel,
  formatUtcShort,
  formatUtcTimestamp,
  parseTimestamp,
  revisionsLabel,
  singleLine,
  truncate,
} from "./format";
import { MAX_AMOUNT_MINOR, formatMoney } from "./money";
import { quoteFor } from "./quote";
import {
  IsoDateTimeSchema,
  type AgentSource,
  type DeliverableSpec,
  type GuardrailNote,
  type Mandate,
  type MoveAction,
  type NegotiationMove,
  type NegotiationState,
  type Party,
  type ProposedMove,
  type Terms,
} from "./schemas";
import { toSellerPublic, type SellerProfile } from "./sellers";

export const MAX_MOVES = 8;

/** Contracts carry at most this many revision rounds (same bound as TermsSchema). */
const MAX_REVISIONS = 3;
const MIN_PRICE_MINOR = 100;
/** Offers are whole dollars, so the ceiling is the platform maximum rounded down to a dollar. */
const MAX_PRICE_MINOR = Math.floor(MAX_AMOUNT_MINOR / 100) * 100;
const MAX_MESSAGE_CHARS = 480;

/** Every code the engine can attach to a move, for UI copy and analytics. */
export const GUARDRAIL_CODES = [
  "price_rounded",
  "price_out_of_range",
  "revisions_above_limit",
  "price_above_budget",
  "deadline_after_mandate",
  "count_outside_mandate",
  "revisions_below_mandate",
  "price_below_floor",
  "deadline_too_soon",
  "count_outside_scope",
  "scope_above_platform_maximum",
  "accept_vetoed",
  "private_limit_redacted",
] as const;
export type GuardrailCode = (typeof GUARDRAIL_CODES)[number];

export interface RulesContext {
  /** The buyer's private mandate (budget, deadline, acceptable scope). */
  mandate: Mandate;
  /** The seller's profile including its private rate card. */
  seller: SellerProfile;
  now: Date;
}

/** The proposal cannot be turned into a legal move at all (wrong turn, closed negotiation, malformed terms). */
export class InvalidMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMoveError";
  }
}

export function initialNegotiation(): NegotiationState {
  return { status: "open", moves: [], agreedTerms: null, failureReason: null };
}

function counterpartyOf(party: Party): Party {
  return party === "buyer" ? "seller" : "buyer";
}

/** Seller on an empty history, then strict alternation. */
export function nextActor(state: NegotiationState): Party {
  const last = state.moves[state.moves.length - 1];
  return last ? counterpartyOf(last.actor) : "seller";
}

export function movesRemaining(state: NegotiationState): number {
  return Math.max(0, MAX_MOVES - state.moves.length);
}

/** The latest offer or counter-offer (with terms) made by `party`, or null. */
export function lastOfferBy(state: NegotiationState, party: Party): NegotiationMove | null {
  for (let i = state.moves.length - 1; i >= 0; i -= 1) {
    const move = state.moves[i];
    if (move.actor === party && (move.action === "offer" || move.action === "counter") && move.terms !== null) {
      return move;
    }
  }
  return null;
}

/**
 * The scope a seller should price right now: the buyer's latest offer, or — before the buyer
 * has made one — the request for quote implied by the mandate. It never includes a price.
 */
export function termsOnTable(state: NegotiationState, mandate: Mandate): RequestedTerms {
  const buyerOffer = lastOfferBy(state, "buyer");
  if (buyerOffer?.terms) {
    const { count, deadline, revisionLimit } = buyerOffer.terms;
    return { count, deadline, revisionLimit };
  }
  return { count: mandate.deliverable.count, deadline: mandate.deadline, revisionLimit: mandate.revisionsWanted };
}

/**
 * What the seller agent is given for its next move. Built here so that the quote is always
 * priced for exactly the terms the agent is told were requested, at the same instant the rules
 * engine will use to check the move.
 */
export function sellerContextFor(state: NegotiationState, ctx: RulesContext): SellerContext {
  const requested = termsOnTable(state, ctx.mandate);
  return {
    seller: ctx.seller,
    requested,
    quote: quoteFor(ctx.seller, ctx.mandate.deliverable, requested, ctx.now),
    deliverable: ctx.mandate.deliverable,
    history: state.moves,
    movesRemaining: movesRemaining(state),
    now: ctx.now,
  };
}

/** What the buyer agent is given for its next move: its own mandate and the seller's PUBLIC profile only. */
export function buyerContextFor(state: NegotiationState, ctx: RulesContext): BuyerContext {
  return {
    mandate: ctx.mandate,
    seller: toSellerPublic(ctx.seller),
    history: state.moves,
    movesRemaining: movesRemaining(state),
    now: ctx.now,
  };
}

/* -------------------------------------------------------------------------- */
/*  Notes and engine-authored messages                                         */
/* -------------------------------------------------------------------------- */

function note(code: GuardrailCode, detail: string): GuardrailNote {
  return { code, detail };
}

function describeOffer(terms: Terms, kind: DeliverableSpec["kind"]): string {
  return `${formatMoney(terms.priceMinor)} for ${deliverableCountLabel(kind, terms.count)} with ${revisionsLabel(
    terms.revisionLimit,
  )}, delivered by ${formatUtcShort(terms.deadline)}.`;
}

/**
 * Strip everything that could corrupt or spoof the transcript: control characters, zero-width
 * and bidirectional-override characters, and runs of whitespace.
 */
function cleanMessage(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return truncate(singleLine(raw), MAX_MESSAGE_CHARS);
}

function amountPattern(minor: number): string {
  const whole = Math.floor(minor / 100).toString();
  const cents = (minor % 100).toString().padStart(2, "0");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",?");
  return cents === "00" ? `${grouped}(?:\\.00)?` : `${grouped}\\.${cents}`;
}

/** True when the text states this exact amount as money ("$50", "50.00 USD", "50 dollars"). */
function mentionsAmount(text: string, minor: number): boolean {
  const amount = amountPattern(minor);
  const notMoreDigits = "(?![\\d]|[.,]\\d)";
  const pattern = new RegExp(
    `(?:\\$|usd)\\s?${amount}${notMoreDigits}|(?:^|[^\\d.,])${amount}\\s?(?:dollars?|usd|bucks)\\b`,
    "i",
  );
  return pattern.test(text);
}

/* -------------------------------------------------------------------------- */
/*  Terms: normalisation and per-party limits                                  */
/* -------------------------------------------------------------------------- */

function requireTimestamp(iso: string, label: string): number {
  const ms = parseTimestamp(iso);
  if (ms === null) throw new RangeError(`${label} is not a valid timestamp: ${JSON.stringify(iso)}`);
  return ms;
}

/**
 * Bring a raw proposal into canonical shape (whole dollars, UTC deadline, schema ranges).
 * Structurally broken terms cannot be repaired and are rejected as an invalid move.
 */
function normaliseTerms(raw: Terms): { terms: Terms; notes: GuardrailNote[] } {
  const { priceMinor, deadline, revisionLimit, count } = raw;
  if (typeof priceMinor !== "number" || !Number.isFinite(priceMinor) || priceMinor < 0) {
    throw new InvalidMoveError("Offer terms are malformed: priceMinor must be a non-negative number of minor units");
  }
  if (!Number.isInteger(count)) {
    throw new InvalidMoveError("Offer terms are malformed: count must be an integer");
  }
  if (!Number.isInteger(revisionLimit) || revisionLimit < 0) {
    throw new InvalidMoveError("Offer terms are malformed: revisionLimit must be a non-negative integer");
  }
  const deadlineMs = IsoDateTimeSchema.safeParse(deadline).success ? parseTimestamp(deadline) : null;
  if (deadlineMs === null) {
    throw new InvalidMoveError("Offer terms are malformed: deadline must be an ISO-8601 timestamp");
  }

  const notes: GuardrailNote[] = [];
  let price = Math.round(priceMinor / 100) * 100;
  if (price !== priceMinor) {
    notes.push(
      note(
        "price_rounded",
        `Offers are made in whole dollars, so the proposed price was rounded to ${formatMoney(price)}.`,
      ),
    );
  }
  if (price < MIN_PRICE_MINOR || price > MAX_PRICE_MINOR) {
    const bounded = Math.min(Math.max(price, MIN_PRICE_MINOR), MAX_PRICE_MINOR);
    notes.push(
      note(
        "price_out_of_range",
        `Prices must be between ${formatMoney(MIN_PRICE_MINOR)} and ${formatMoney(MAX_PRICE_MINOR)}, so ${formatMoney(price)} was changed to ${formatMoney(bounded)}.`,
      ),
    );
    price = bounded;
  }
  let revisions = revisionLimit;
  if (revisions > MAX_REVISIONS) {
    notes.push(
      note(
        "revisions_above_limit",
        `A contract allows at most ${MAX_REVISIONS} revision rounds, so ${revisions} was reduced to ${MAX_REVISIONS}.`,
      ),
    );
    revisions = MAX_REVISIONS;
  }
  return {
    terms: { priceMinor: price, deadline: new Date(deadlineMs).toISOString(), revisionLimit: revisions, count },
    notes,
  };
}

interface Limited {
  /** The terms brought inside the party's limits, or null when no terms can satisfy them. */
  terms: Terms | null;
  /** One note per limit that had to be enforced. Empty means the terms were already acceptable. */
  notes: GuardrailNote[];
  /** The party's private price limit for these terms (budget or floor), used to catch leaks. */
  privateLimitMinor: number;
}

function limitForBuyer(terms: Terms, mandate: Mandate): Limited {
  const notes: GuardrailNote[] = [];
  let { priceMinor, deadline, count, revisionLimit } = terms;

  if (priceMinor > mandate.budgetMinor) {
    // Offers stay in whole dollars, so the cap is the budget rounded DOWN, never up.
    const cap = Math.max(MIN_PRICE_MINOR, Math.floor(mandate.budgetMinor / 100) * 100);
    notes.push(
      note(
        "price_above_budget",
        `${formatMoney(priceMinor)} is above the budget the buyer was given, so the price was capped at ${formatMoney(cap)}.`,
      ),
    );
    priceMinor = cap;
  }

  const mandateDeadlineMs = requireTimestamp(mandate.deadline, "mandate.deadline");
  if (requireTimestamp(deadline, "terms.deadline") > mandateDeadlineMs) {
    const latest = new Date(mandateDeadlineMs).toISOString();
    notes.push(
      note(
        "deadline_after_mandate",
        `Delivery by ${formatUtcTimestamp(deadline)} is later than the buyer needs, so the deadline was moved up to ${formatUtcTimestamp(latest)}.`,
      ),
    );
    deadline = latest;
  }

  const maxCount = mandate.deliverable.count;
  const minCount = Math.min(mandate.minCount, maxCount);
  if (count < minCount || count > maxCount) {
    const bounded = Math.min(Math.max(count, minCount), maxCount);
    const range = minCount === maxCount ? `exactly ${maxCount}` : `between ${minCount} and ${maxCount}`;
    notes.push(
      note(
        "count_outside_mandate",
        `The buyer may agree to a count of ${range}, so ${count} was changed to ${bounded}.`,
      ),
    );
    count = bounded;
  }

  if (revisionLimit < mandate.minRevisions) {
    notes.push(
      note(
        "revisions_below_mandate",
        `The buyer needs at least ${revisionsLabel(mandate.minRevisions)}, so the offer of ${revisionsLabel(revisionLimit)} was raised to match.`,
      ),
    );
    revisionLimit = mandate.minRevisions;
  }

  return { terms: { priceMinor, deadline, revisionLimit, count }, notes, privateLimitMinor: mandate.budgetMinor };
}

function limitForSeller(terms: Terms, ctx: RulesContext): Limited {
  const notes: GuardrailNote[] = [];
  let { priceMinor, deadline, count } = terms;
  const { revisionLimit } = terms;

  const maxCount = ctx.mandate.deliverable.count;
  if (count < 1 || count > maxCount) {
    const bounded = Math.min(Math.max(count, 1), maxCount);
    notes.push(
      note(
        "count_outside_scope",
        `The request covers a count of 1 to ${maxCount}, so ${count} was changed to ${bounded}.`,
      ),
    );
    count = bounded;
  }

  const minHours = ctx.seller.rateCard.minHours;
  const earliestMs = ctx.now.getTime() + minHours * HOUR_MS;
  if (requireTimestamp(deadline, "terms.deadline") < earliestMs) {
    const earliest = new Date(earliestMs).toISOString();
    notes.push(
      note(
        "deadline_too_soon",
        `Delivery by ${formatUtcTimestamp(deadline)} is faster than the seller's ${minHours}h minimum turnaround, so the deadline was moved to ${formatUtcTimestamp(earliest)}.`,
      ),
    );
    deadline = earliest;
  }

  // The floor depends on scope and urgency, so it is priced AFTER count and deadline are settled.
  const quote = quoteFor(ctx.seller, ctx.mandate.deliverable, { count, deadline, revisionLimit }, ctx.now);
  if (quote.floorMinor > MAX_PRICE_MINOR) {
    notes.push(
      note(
        "scope_above_platform_maximum",
        `The seller cannot price this scope within the ${formatMoney(MAX_PRICE_MINOR)} platform maximum, so no offer is possible.`,
      ),
    );
    return { terms: null, notes, privateLimitMinor: quote.floorMinor };
  }
  if (priceMinor < quote.floorMinor) {
    notes.push(
      note(
        "price_below_floor",
        `${formatMoney(priceMinor)} is below the seller's minimum for this scope, so the price was raised to ${formatMoney(quote.floorMinor)}.`,
      ),
    );
    priceMinor = quote.floorMinor;
  }

  return { terms: { priceMinor, deadline, revisionLimit, count }, notes, privateLimitMinor: quote.floorMinor };
}

function limitFor(actor: Party, terms: Terms, ctx: RulesContext): Limited {
  return actor === "buyer" ? limitForBuyer(terms, ctx.mandate) : limitForSeller(terms, ctx);
}

/* -------------------------------------------------------------------------- */
/*  Resolving a proposal into the move that is recorded                        */
/* -------------------------------------------------------------------------- */

interface Resolved {
  action: MoveAction;
  terms: Terms | null;
  message: string;
  notes: GuardrailNote[];
}

function agentLabel(actor: Party): string {
  return actor === "buyer" ? "Buyer agent" : "Seller agent";
}

function termBearingAction(state: NegotiationState, actor: Party): "offer" | "counter" {
  return state.moves.some((move) => move.actor === actor) ? "counter" : "offer";
}

/**
 * Keep the agent's own words unless they are empty or state the party's private limit while
 * a different price is on the table (e.g. offering $40 and adding "our budget is $50").
 */
function publicMessage(
  actor: Party,
  proposed: ProposedMove,
  fallback: string,
  privateLimitMinor: number,
  priceOnTableMinor: number | null,
): { message: string; notes: GuardrailNote[] } {
  const message = cleanMessage(proposed.message);
  if (message === "") return { message: fallback, notes: [] };
  if (priceOnTableMinor !== privateLimitMinor && mentionsAmount(message, privateLimitMinor)) {
    return {
      message: fallback,
      notes: [
        note(
          "private_limit_redacted",
          `${agentLabel(actor)}'s message stated its private price limit, so the message was replaced with a neutral one.`,
        ),
      ],
    };
  }
  return { message, notes: [] };
}

function resolveOffer(state: NegotiationState, actor: Party, proposed: ProposedMove, ctx: RulesContext): Resolved {
  if (proposed.terms === null || typeof proposed.terms !== "object") {
    throw new InvalidMoveError(`A ${proposed.action} must include terms`);
  }
  const kind = ctx.mandate.deliverable.kind;
  const normalised = normaliseTerms(proposed.terms);
  const limited = limitFor(actor, normalised.terms, ctx);
  const corrections = [...normalised.notes, ...limited.notes];

  if (limited.terms === null) {
    return {
      action: "reject",
      terms: null,
      message: "This scope is beyond what can be contracted here, so we have to decline.",
      notes: corrections,
    };
  }

  const action = termBearingAction(state, actor);
  if (corrections.length > 0) {
    // The agent's message describes terms that no longer exist; replacing it keeps the
    // transcript (which the counterparty agent reads) consistent with the recorded terms.
    return {
      action,
      terms: limited.terms,
      message: `Our offer: ${describeOffer(limited.terms, kind)}`,
      notes: corrections,
    };
  }
  const { message, notes } = publicMessage(
    actor,
    proposed,
    `Our offer: ${describeOffer(limited.terms, kind)}`,
    limited.privateLimitMinor,
    limited.terms.priceMinor,
  );
  return { action, terms: limited.terms, message, notes };
}

function resolveAccept(state: NegotiationState, actor: Party, proposed: ProposedMove, ctx: RulesContext): Resolved {
  const offer = lastOfferBy(state, counterpartyOf(actor));
  if (offer === null || offer.terms === null) {
    throw new InvalidMoveError("There is no offer on the table to accept");
  }
  const kind = ctx.mandate.deliverable.kind;
  // Whatever terms the agent restated are ignored: only the counterparty's recorded offer counts.
  const limited = limitFor(actor, offer.terms, ctx);

  if (limited.notes.length === 0 && limited.terms !== null) {
    const terms: Terms = { ...offer.terms };
    const { message, notes } = publicMessage(
      actor,
      proposed,
      `Agreed: ${describeOffer(terms, kind)}`,
      limited.privateLimitMinor,
      terms.priceMinor,
    );
    return { action: "accept", terms, message, notes };
  }

  // A counter on the very last move could never be answered, so the only honest outcome is a rejection.
  if (limited.terms === null || movesRemaining(state) <= 1) {
    return {
      action: "reject",
      terms: null,
      message: "We can't accept those terms, and there is no room left to negotiate.",
      notes: [
        note(
          "accept_vetoed",
          `${agentLabel(actor)} tried to accept terms outside its limits. With no way left to counter, the acceptance was recorded as a rejection.`,
        ),
        ...limited.notes,
      ],
    };
  }
  return {
    action: termBearingAction(state, actor),
    terms: limited.terms,
    message: `We can't accept those terms as they stand. We can do ${describeOffer(limited.terms, kind)}`,
    notes: [
      note(
        "accept_vetoed",
        `${agentLabel(actor)} tried to accept terms outside its limits. The acceptance was replaced with a counter-offer inside those limits.`,
      ),
      ...limited.notes,
    ],
  };
}

function resolveReject(state: NegotiationState, actor: Party, proposed: ProposedMove, ctx: RulesContext): Resolved {
  const privateLimitMinor =
    actor === "buyer"
      ? ctx.mandate.budgetMinor
      : quoteFor(ctx.seller, ctx.mandate.deliverable, termsOnTable(state, ctx.mandate), ctx.now).floorMinor;
  const { message, notes } = publicMessage(
    actor,
    proposed,
    "We'll have to pass on this one. Thank you for your time.",
    privateLimitMinor,
    null,
  );
  return { action: "reject", terms: null, message, notes };
}

function resolve(state: NegotiationState, actor: Party, proposed: ProposedMove, ctx: RulesContext): Resolved {
  const action = proposed.action;
  switch (action) {
    case "offer":
    case "counter":
      return resolveOffer(state, actor, proposed, ctx);
    case "accept":
      return resolveAccept(state, actor, proposed, ctx);
    case "reject":
      return resolveReject(state, actor, proposed, ctx);
    default: {
      // Unreachable for typed callers; a model that invents an action must not crash the step loop.
      const unknown: never = action;
      throw new InvalidMoveError(`Unknown negotiation action: ${JSON.stringify(unknown)}`);
    }
  }
}

function stateAfter(previous: NegotiationState, move: NegotiationMove): NegotiationState {
  const moves = [...previous.moves, move];
  switch (move.action) {
    case "accept":
      return { status: "agreed", moves, agreedTerms: move.terms, failureReason: null };
    case "reject":
      return {
        status: "failed",
        moves,
        agreedTerms: null,
        failureReason: move.actor === "buyer" ? "Buyer agent walked away" : "Seller agent declined",
      };
    case "offer":
    case "counter":
      return moves.length >= MAX_MOVES
        ? { status: "failed", moves, agreedTerms: null, failureReason: `No agreement within ${MAX_MOVES} moves` }
        : { status: "open", moves, agreedTerms: null, failureReason: null };
    default:
      return assertNever(move.action);
  }
}

/**
 * Validate, correct and record one proposed move. Pure: returns a new state and never mutates
 * its inputs.
 *
 * @throws InvalidMoveError when the negotiation is closed, it is not `actor`'s turn, an
 *   offer/counter has no (or malformed) terms, or there is nothing to accept.
 */
export function applyMove(
  state: NegotiationState,
  actor: Party,
  proposed: ProposedMove,
  meta: { source: AgentSource; model: string | null; latencyMs: number | null },
  ctx: RulesContext,
): { state: NegotiationState; move: NegotiationMove } {
  if (state.status !== "open") {
    throw new InvalidMoveError(`The negotiation is already ${state.status}; no further moves are possible`);
  }
  if (state.moves.length >= MAX_MOVES) {
    throw new InvalidMoveError(`The negotiation has used all ${MAX_MOVES} moves`);
  }
  const expected = nextActor(state);
  if (actor !== expected) {
    throw new InvalidMoveError(`It is the ${expected}'s turn to move, not the ${actor}'s`);
  }

  const resolved = resolve(state, actor, proposed, ctx);
  const latencyMs =
    meta.latencyMs !== null && Number.isFinite(meta.latencyMs) ? Math.max(0, Math.round(meta.latencyMs)) : null;
  const move: NegotiationMove = {
    seq: state.moves.length + 1,
    actor,
    action: resolved.action,
    terms: resolved.terms,
    message: resolved.message,
    guardrails: resolved.notes,
    source: meta.source,
    model: meta.model,
    latencyMs,
    createdAt: ctx.now.toISOString(),
  };
  return { state: stateAfter(state, move), move };
}
