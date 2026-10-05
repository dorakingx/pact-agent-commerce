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
  /** Set when AI was attempted but failed and the scripted fallback answered instead. */
  degradedReason: string | null;
}

export interface BuyerContext {
  mandate: Mandate;
  seller: SellerPublic;
  history: NegotiationMove[];
  /** Moves left in the negotiation INCLUDING this one. 1 means: accept or walk away. */
  movesRemaining: number;
  now: Date;
}

export interface SellerContext {
  seller: SellerProfile;
  /** Private quote for the scope currently on the table (list + floor). */
  quote: Quote;
  deliverable: DeliverableSpec;
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

export interface Agents {
  /** Buyer agent: turn the human's request into a structured mandate. */
  parseIntent(intent: string, now: Date): Promise<{ mandate: Mandate; meta: AgentMeta }>;
  /** Buyer agent: propose the next negotiation move. */
  buyerMove(ctx: BuyerContext): Promise<{ move: ProposedMove; meta: AgentMeta }>;
  /** Seller agent: propose the next negotiation move. */
  sellerMove(ctx: SellerContext): Promise<{ move: ProposedMove; meta: AgentMeta }>;
  /** Seller agent: produce the work. */
  produceDelivery(ctx: DeliveryContext): Promise<{ artifacts: Artifact[]; note: string; meta: AgentMeta }>;
  /** Verifier: evaluate the AI-judged rules. Must return exactly one check per rule passed in. */
  evaluateAiRules(ctx: AiVerificationContext): Promise<{ checks: VerificationCheck[]; meta: AgentMeta }>;
}
