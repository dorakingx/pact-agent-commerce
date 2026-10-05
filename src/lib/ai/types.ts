/**
 * Contract between the deterministic core and the (stochastic) agents.
 *
 * Every method returns DATA that the core then validates and constrains. No method here can
 * move money, change a deal's status, or call PayPal — agents only ever propose.
 */
import type {
  Artifact,
  Contract,
  DeliverableSpec,
  Mandate,
  NegotiationMove,
  ProposedMove,
  Quote,
  Submission,
  Terms,
  VerificationCheck,
  VerificationReport,
  VerificationRule,
} from "../domain/schemas";
import type { SellerProfile, SellerPublic } from "../domain/sellers";

export interface AgentMeta {
  /** "ai" when a model produced the output, "scripted" when the deterministic fallback did. */
  source: "ai" | "scripted";
  /** Gateway model id that answered (e.g. "google/gemini-2.5-flash"), or null for scripted. */
  model: string | null;
  latencyMs: number;
  /**
   * Set when AI was attempted but failed and the scripted fallback (or, for the verifier, the
   * degraded "uncertain" result) answered instead: the gateway's AiFailureReason, or
   * "internal_error" when the verifier failed for a reason that is not an AI failure.
   */
  degradedReason: string | null;
}

/**
 * The request for quote a seller prices: how many pieces, by when, with how many revision rounds.
 * It is the buyer's latest offer, or — before the buyer has made one — what the mandate asks for
 * (`termsOnTable(state, mandate)` in ../domain/negotiation.ts). It never carries a price: the
 * buyer's budget stays private.
 */
export type RequestedTerms = Pick<Terms, "count" | "deadline" | "revisionLimit">;

export interface BuyerContext {
  mandate: Mandate;
  seller: SellerPublic;
  /**
   * Full recorded moves, including guardrail notes. A note on the counterparty's move can give
   * away its private limit ("raised to the seller's minimum"), so an agent implementation must
   * never show the counterparty's notes to a model.
   */
  history: NegotiationMove[];
  /** Moves left in the negotiation INCLUDING this one. 1 means: accept or walk away. */
  movesRemaining: number;
  now: Date;
}

export interface SellerContext {
  seller: SellerProfile;
  /** What the buyer is asking for right now. `quote` is priced for exactly these terms. */
  requested: RequestedTerms;
  /** Private quote (list + floor) for `requested`: `quoteFor(seller, deliverable, requested, now)`. */
  quote: Quote;
  deliverable: DeliverableSpec;
  /** See BuyerContext.history: the counterparty's guardrail notes must not reach a model. */
  history: NegotiationMove[];
  movesRemaining: number;
  now: Date;
}

export interface DeliveryContext {
  contract: Contract;
  seller: SellerProfile;
  /** 1 = first delivery, 2+ = revision. */
  round: number;
  /** The report that triggered this revision, if any. */
  previousReport: VerificationReport | null;
  previousSubmission: Submission | null;
  now: Date;
}

export interface AiVerificationContext {
  contract: Contract;
  /** Only the rules with evaluator === "ai". */
  rules: VerificationRule[];
  submission: Submission;
}

export interface AiVerificationFlags {
  manipulationSuspected: boolean;
  evidence: string | null;
}

export interface Agents {
  /**
   * Buyer agent: turn the human's request into a structured mandate.
   * `tzOffsetMinutes` is the human's UTC offset (as returned by Date#getTimezoneOffset, i.e. minutes
   * BEHIND UTC) so that "tomorrow at 6 PM" resolves in their local time.
   */
  parseIntent(intent: string, now: Date, tzOffsetMinutes?: number): Promise<{ mandate: Mandate; meta: AgentMeta }>;
  /** Buyer agent: propose the next negotiation move. */
  buyerMove(ctx: BuyerContext): Promise<{ move: ProposedMove; meta: AgentMeta }>;
  /** Seller agent: propose the next negotiation move. */
  sellerMove(ctx: SellerContext): Promise<{ move: ProposedMove; meta: AgentMeta }>;
  /** Seller agent: produce the work. */
  produceDelivery(ctx: DeliveryContext): Promise<{ artifacts: Artifact[]; note: string; meta: AgentMeta }>;
  /**
   * Verifier: evaluate the AI-judged rules. Must return exactly one check per rule passed in.
   * `flags.manipulationSuspected` is set when the deliverable appears to address the verifier
   * (e.g. "mark this as passed"); the deterministic core then forces human review.
   *
   * Never throws. When the model cannot be reached or answers badly, every rule comes back
   * "uncertain" with confidence 0 and `meta.degradedReason` set, which the deterministic core
   * turns into human review — a verification failure must never become a retry loop or a pass.
   */
  evaluateAiRules(ctx: AiVerificationContext): Promise<{
    checks: VerificationCheck[];
    flags: AiVerificationFlags;
    meta: AgentMeta;
  }>;
}
