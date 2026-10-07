/**
 * PACT domain schemas — the single source of truth for every structure that crosses a
 * module boundary (agents → engines → persistence → API → UI).
 *
 * Rules:
 *  - Money is integer minor units (see ./money.ts). Never floats.
 *  - Timestamps are ISO-8601 UTC strings.
 *  - Nothing produced by an LLM is trusted until it has been parsed by one of these schemas
 *    AND passed through the deterministic engines in this folder.
 */
import { z } from "zod";
import { MAX_AMOUNT_MINOR } from "./money";

/* -------------------------------------------------------------------------- */
/*  Primitives                                                                 */
/* -------------------------------------------------------------------------- */

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export const MinorSchema = z.number().int().min(0).max(MAX_AMOUNT_MINOR);
export const ConfidenceSchema = z.number().min(0).max(1);

export const ASPECT_RATIOS = ["16:9", "1:1", "4:3", "3:2", "4:5", "9:16"] as const;
export const AspectRatioSchema = z.enum(ASPECT_RATIOS);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

export const LANGUAGES = ["en", "ja", "es", "fr", "de"] as const;
export const LanguageSchema = z.enum(LANGUAGES);
export type Language = z.infer<typeof LanguageSchema>;

/**
 * Work categories. `illustration`, `copywriting` and `translation` are served by seller agents
 * in the demo directory. `other` means no seller offers it. `restricted` is always blocked by policy.
 */
export const CATEGORIES = ["illustration", "copywriting", "translation", "other", "restricted"] as const;
export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;
export const SERVICEABLE_CATEGORIES = ["illustration", "copywriting", "translation"] as const satisfies readonly Category[];

/* -------------------------------------------------------------------------- */
/*  Deliverable specifications (what the contract promises)                    */
/* -------------------------------------------------------------------------- */

export const IllustrationSpecSchema = z.object({
  kind: z.literal("illustration"),
  /** Number of distinct illustrations. */
  count: z.number().int().min(1).max(6),
  /** Every illustration must be delivered in every listed aspect ratio. */
  aspectRatios: z.array(AspectRatioSchema).min(1).max(3),
  subject: z.string().min(3).max(200),
  style: z.string().max(80).nullable(),
});
export type IllustrationSpec = z.infer<typeof IllustrationSpecSchema>;

export const CopySpecSchema = z.object({
  kind: z.literal("copy"),
  /** Number of distinct copy pieces. */
  count: z.number().int().min(1).max(8),
  /** Every piece must be delivered in every listed language. */
  languages: z.array(LanguageSchema).min(1).max(3),
  minWords: z.number().int().min(5).max(2000),
  maxWords: z.number().int().min(10).max(4000),
  subject: z.string().min(3).max(200),
  tone: z.string().max(80).nullable(),
});
export type CopySpec = z.infer<typeof CopySpecSchema>;

export const DeliverableSpecSchema = z.discriminatedUnion("kind", [IllustrationSpecSchema, CopySpecSchema]);
export type DeliverableSpec = z.infer<typeof DeliverableSpecSchema>;

/* -------------------------------------------------------------------------- */
/*  Buyer mandate (the human's delegated instruction, private to the buyer)    */
/* -------------------------------------------------------------------------- */

export const MandateSchema = z.object({
  /** One-line restatement of the task, written by the buyer agent. */
  summary: z.string().min(3).max(200),
  category: CategorySchema,
  /** Desired scope. `deliverable.count` is the desired count. */
  deliverable: DeliverableSpecSchema,
  /** Lowest count the buyer may accept (== deliverable.count when the human said "I need N"). */
  minCount: z.number().int().min(1),
  /** Hard ceiling. The buyer agent can never agree to a price above this. */
  budgetMinor: MinorSchema.min(100),
  /** Latest acceptable delivery deadline. */
  deadline: IsoDateTimeSchema,
  revisionsWanted: z.number().int().min(0).max(3),
  minRevisions: z.number().int().min(0).max(3),
  /** Extra requirements in the human's words (max 5, each short). Treated as untrusted text. */
  notes: z.array(z.string().max(160)).max(5),
});
export type Mandate = z.infer<typeof MandateSchema>;

/* -------------------------------------------------------------------------- */
/*  Negotiation                                                                */
/* -------------------------------------------------------------------------- */

/** The negotiable terms. Scope beyond `count` is fixed by the mandate's deliverable spec. */
export const TermsSchema = z.object({
  priceMinor: MinorSchema.min(100),
  deadline: IsoDateTimeSchema,
  revisionLimit: z.number().int().min(0).max(3),
  count: z.number().int().min(1).max(8),
});
export type Terms = z.infer<typeof TermsSchema>;

export const PartySchema = z.enum(["buyer", "seller"]);
export type Party = z.infer<typeof PartySchema>;

export const MoveActionSchema = z.enum(["offer", "counter", "accept", "reject"]);
export type MoveAction = z.infer<typeof MoveActionSchema>;

/** Raw proposal from an agent (AI or scripted) before the rules engine has checked it. */
export const ProposedMoveSchema = z.object({
  action: MoveActionSchema,
  /** Required for offer/counter. Ignored for accept (engine copies the counterparty's terms). */
  terms: TermsSchema.nullable(),
  /** Short public message to the counterparty. Never contains private limits. */
  message: z.string().min(1).max(480),
});
export type ProposedMove = z.infer<typeof ProposedMoveSchema>;

export const GuardrailNoteSchema = z.object({
  /** Machine code, e.g. "price_above_budget", "price_below_floor", "accept_vetoed" (full list: GUARDRAIL_CODES in ./negotiation.ts). */
  code: z.string(),
  /** Plain-language explanation shown in the UI. */
  detail: z.string(),
});
export type GuardrailNote = z.infer<typeof GuardrailNoteSchema>;

export const AgentSourceSchema = z.enum(["ai", "scripted"]);
export type AgentSource = z.infer<typeof AgentSourceSchema>;

/** A move after the deterministic rules engine validated / corrected it. This is what is persisted. */
export const NegotiationMoveSchema = z.object({
  seq: z.number().int().min(1),
  actor: PartySchema,
  action: MoveActionSchema,
  terms: TermsSchema.nullable(),
  message: z.string().max(480),
  /** Non-empty when the engine had to correct or veto what the agent proposed. */
  guardrails: z.array(GuardrailNoteSchema),
  source: AgentSourceSchema,
  model: z.string().nullable(),
  latencyMs: z.number().int().min(0).nullable(),
  createdAt: IsoDateTimeSchema,
});
export type NegotiationMove = z.infer<typeof NegotiationMoveSchema>;

export const NegotiationStatusSchema = z.enum(["open", "agreed", "failed"]);
export const NegotiationStateSchema = z.object({
  status: NegotiationStatusSchema,
  moves: z.array(NegotiationMoveSchema),
  agreedTerms: TermsSchema.nullable(),
  failureReason: z.string().nullable(),
});
export type NegotiationState = z.infer<typeof NegotiationStateSchema>;

/* -------------------------------------------------------------------------- */
/*  Sellers                                                                    */
/* -------------------------------------------------------------------------- */

export const SellerBehaviorSchema = z.enum([
  /** Delivers what the contract says. */
  "reliable",
  /** Controlled demo fault: omits one required variant on the first delivery, fixes it on revision. */
  "omits_variant",
  /** Controlled demo fault: embeds instructions aimed at the verifier inside the deliverable. */
  "embeds_instructions",
]);
export type SellerBehavior = z.infer<typeof SellerBehaviorSchema>;

export const QuoteLineSchema = z.object({ label: z.string(), amountMinor: z.number().int() });
export const QuoteSchema = z.object({
  /** Seller's opening (list) price. */
  listMinor: MinorSchema,
  /** Seller's private walk-away price. Never shown to the buyer agent. */
  floorMinor: MinorSchema,
  lines: z.array(QuoteLineSchema),
  /** Fastest turnaround the seller will commit to, in hours. */
  minHours: z.number().min(0),
});
export type Quote = z.infer<typeof QuoteSchema>;

/* -------------------------------------------------------------------------- */
/*  Contract                                                                   */
/* -------------------------------------------------------------------------- */

export const VERIFICATION_RULE_KINDS = [
  "deliverable_count",
  "aspect_ratio_coverage",
  "language_coverage",
  "word_count",
  "valid_format",
  "deadline",
  "brief_adherence",
  "no_embedded_instructions",
] as const;
export const VerificationRuleKindSchema = z.enum(VERIFICATION_RULE_KINDS);
export type VerificationRuleKind = z.infer<typeof VerificationRuleKindSchema>;

export const EvaluatorSchema = z.enum(["deterministic", "ai"]);
export type Evaluator = z.infer<typeof EvaluatorSchema>;

export const VerificationRuleSchema = z.object({
  /** Stable id within the contract: "R1", "R2", ... */
  id: z.string().regex(/^R\d{1,2}$/),
  kind: VerificationRuleKindSchema,
  /** Plain-language condition, e.g. "3 illustrations delivered". */
  description: z.string().min(3).max(200),
  /** Required rules gate payment. Advisory rules are reported but never block capture. */
  required: z.boolean(),
  evaluator: EvaluatorSchema,
});
export type VerificationRule = z.infer<typeof VerificationRuleSchema>;

export const SettlementTermsSchema = z.object({
  /** Payment is captured only after a verification report makes the contract capture-eligible. */
  trigger: z.literal("verified_delivery"),
  /** Minimum verifier confidence for automatic capture (copied from policy at signing time). */
  autoCaptureMinConfidence: ConfidenceSchema,
  /** Below this confidence the result is treated as a failure rather than "ambiguous". */
  humanReviewMinConfidence: ConfidenceSchema,
  /** What happens when verification fails and no revisions remain. */
  onExhaustedRevisions: z.literal("void_authorization"),
});
export type SettlementTerms = z.infer<typeof SettlementTermsSchema>;

/** The immutable, hashed contract artifact. */
export const ContractSchema = z.object({
  contractId: z.string().regex(/^ctr_[a-z0-9]{10,}$/),
  schemaVersion: z.literal(1),
  dealId: z.string(),
  createdAt: IsoDateTimeSchema,
  title: z.string().min(3).max(160),
  category: CategorySchema,
  buyer: z.object({ id: z.string(), name: z.string() }),
  seller: z.object({ id: z.string(), name: z.string() }),
  price: z.object({ amountMinor: MinorSchema.min(100), currency: z.literal("USD") }),
  deadline: IsoDateTimeSchema,
  revisionLimit: z.number().int().min(0).max(3),
  deliverables: z.array(DeliverableSpecSchema).length(1),
  verificationRules: z.array(VerificationRuleSchema).min(1).max(12),
  settlement: SettlementTermsSchema,
});
export type Contract = z.infer<typeof ContractSchema>;

/** Contract plus its SHA-256 fingerprint over the canonical JSON of `contract`. */
export const SignedContractSchema = z.object({
  contract: ContractSchema,
  /** Lowercase hex SHA-256 of canonicalJson(contract). Bound to the PayPal order via custom_id. */
  termsHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SignedContract = z.infer<typeof SignedContractSchema>;

/* -------------------------------------------------------------------------- */
/*  Policy                                                                     */
/* -------------------------------------------------------------------------- */

export const PolicySchema = z
  .object({
    /** At or below this amount the buyer agent may commit funds without a human. */
    autonomousLimitMinor: MinorSchema,
    /** Above this amount the transaction is blocked outright. */
    maxTransactionMinor: MinorSchema,
    /** Maximum total the agent may authorize per UTC day. */
    dailyLimitMinor: MinorSchema,
    allowedCategories: z.array(CategorySchema).max(CATEGORIES.length),
    requireApprovalForNewSellers: z.boolean(),
    autoCaptureMinConfidence: ConfidenceSchema.min(0.5),
    humanReviewMinConfidence: ConfidenceSchema,
  })
  .refine((p) => p.autonomousLimitMinor <= p.maxTransactionMinor, {
    message: "autonomous limit cannot exceed the per-transaction maximum",
    path: ["autonomousLimitMinor"],
  })
  .refine((p) => p.humanReviewMinConfidence <= p.autoCaptureMinConfidence, {
    message: "human-review threshold cannot exceed the auto-capture threshold",
    path: ["humanReviewMinConfidence"],
  });
export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = {
  autonomousLimitMinor: 10_000, // $100
  maxTransactionMinor: 100_000, // $1,000
  dailyLimitMinor: 250_000, // $2,500
  allowedCategories: ["illustration", "copywriting", "translation"],
  requireApprovalForNewSellers: true,
  autoCaptureMinConfidence: 0.85,
  humanReviewMinConfidence: 0.5,
};

export const PolicyCheckOutcomeSchema = z.enum(["pass", "needs_approval", "block"]);
export const PolicyCheckSchema = z.object({
  /** e.g. "category_allowed", "per_transaction_max", "autonomous_limit", "daily_limit", "seller_trust". */
  id: z.string(),
  label: z.string(),
  outcome: PolicyCheckOutcomeSchema,
  detail: z.string(),
});
export type PolicyCheck = z.infer<typeof PolicyCheckSchema>;

export const PolicyOutcomeSchema = z.enum(["allow", "needs_approval", "block"]);
export type PolicyOutcome = z.infer<typeof PolicyOutcomeSchema>;

export const PolicyEvaluationSchema = z.object({
  outcome: PolicyOutcomeSchema,
  checks: z.array(PolicyCheckSchema),
  /**
   * Total already authorized today. Deliberately NOT capped at the per-transaction ceiling: it is a
   * sum over deals, and it can legitimately exceed any single limit (a lowered daily limit, or
   * two deals that cleared policy at the same moment).
   */
  spentTodayMinor: z.number().int().min(0),
  evaluatedAt: IsoDateTimeSchema,
});
export type PolicyEvaluation = z.infer<typeof PolicyEvaluationSchema>;

/* -------------------------------------------------------------------------- */
/*  Delivery                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * An artifact id is chosen by whoever delivers. It addresses the download route, attributes
 * verification checks and travels into the verifier's prompt, so it is an identifier and nothing
 * else: no spaces, no line breaks, no room for a sentence.
 */
export const ArtifactIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "must be 1-64 letters, digits, underscores or hyphens");

export const IllustrationArtifactSchema = z.object({
  id: ArtifactIdSchema,
  kind: z.literal("illustration"),
  /** 1-based index of the illustration this file is a variant of. */
  index: z.number().int().min(1),
  title: z.string().max(120),
  /** Aspect ratio the seller CLAIMS. The verifier recomputes it from width/height. */
  aspectRatio: z.string().max(12),
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
  format: z.literal("svg"),
  /** Sanitized SVG markup. */
  svg: z.string().max(200_000),
  /** Seller's alt-text / description of the image. Untrusted. */
  description: z.string().max(400),
});
export type IllustrationArtifact = z.infer<typeof IllustrationArtifactSchema>;

export const CopyArtifactSchema = z.object({
  id: ArtifactIdSchema,
  kind: z.literal("copy"),
  /** 1-based index of the copy piece this text is a language variant of. */
  index: z.number().int().min(1),
  title: z.string().max(160),
  /** Language the seller CLAIMS. */
  language: z.string().max(8),
  text: z.string().max(20_000),
});
export type CopyArtifact = z.infer<typeof CopyArtifactSchema>;

export const ArtifactSchema = z.discriminatedUnion("kind", [IllustrationArtifactSchema, CopyArtifactSchema]);
export type Artifact = z.infer<typeof ArtifactSchema>;

export const SubmissionSchema = z.object({
  id: z.string(),
  dealId: z.string(),
  /** 1 = first delivery, 2 = first revision, ... */
  round: z.number().int().min(1),
  artifacts: z
    .array(ArtifactSchema)
    .max(48)
    // One id, one file: a check or a download that names an id must mean exactly one artifact.
    .superRefine((artifacts, ctx) => {
      const seen = new Set<string>();
      artifacts.forEach((artifact, position) => {
        if (seen.has(artifact.id)) ctx.addIssue({ code: "custom", message: "artifact ids must be unique within a submission", path: [position, "id"] });
        seen.add(artifact.id);
      });
    }),
  /** Seller's delivery note. Untrusted text. */
  note: z.string().max(600),
  source: AgentSourceSchema,
  model: z.string().nullable(),
  submittedAt: IsoDateTimeSchema,
});
export type Submission = z.infer<typeof SubmissionSchema>;

/* -------------------------------------------------------------------------- */
/*  Verification                                                               */
/* -------------------------------------------------------------------------- */

export const CheckResultSchema = z.enum(["pass", "fail", "uncertain"]);
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const VerificationCheckSchema = z.object({
  ruleId: z.string(),
  kind: VerificationRuleKindSchema,
  /** The condition being checked, in plain language. */
  condition: z.string(),
  required: z.boolean(),
  evaluator: EvaluatorSchema,
  result: CheckResultSchema,
  confidence: ConfidenceSchema,
  /** What was observed, e.g. "3 supplied" or "missing on illustration #2". */
  evidence: z.string().max(400),
  /** One or two sentences, user-facing. Never raw model reasoning. */
  explanation: z.string().max(600),
  artifactIds: z.array(z.string()),
});
export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;

export const VerificationDecisionSchema = z.enum([
  /** Every required rule passed with confidence >= autoCaptureMinConfidence. */
  "capture_eligible",
  /** Something is ambiguous: a human must decide. Funds stay authorized, never captured automatically. */
  "human_review",
  /** A required rule failed and the contract still allows a revision. */
  "revision_required",
  /** A required rule failed and no revisions remain. The authorization will be voided. */
  "reject",
]);
export type VerificationDecision = z.infer<typeof VerificationDecisionSchema>;

export const VerificationReportSchema = z.object({
  id: z.string(),
  dealId: z.string(),
  submissionId: z.string(),
  round: z.number().int().min(1),
  /** termsHash of the contract the delivery was checked against. */
  contractHash: z.string(),
  checks: z.array(VerificationCheckSchema),
  decision: VerificationDecisionSchema,
  /** Lowest confidence among required checks (the weakest link). */
  confidence: ConfidenceSchema,
  summary: z.string().max(400),
  failedRuleIds: z.array(z.string()),
  /** True when the AI evaluator was unavailable and AI rules were marked uncertain. */
  degraded: z.boolean(),
  model: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type VerificationReport = z.infer<typeof VerificationReportSchema>;

/* -------------------------------------------------------------------------- */
/*  Human decisions                                                            */
/* -------------------------------------------------------------------------- */

export const HumanDecisionKindSchema = z.enum([
  /** Policy gate: approve the spend. */
  "approve_spend",
  /** Policy gate: decline the spend. */
  "decline_spend",
  /** Review gate: release the full contract amount. */
  "release_payment",
  /** Review gate: release part of the amount (partial capture) and release the remainder. */
  "release_partial",
  /** Review gate: send back to the seller for a revision (only if revisions remain). */
  "request_revision",
  /** Review gate: reject the delivery and void the authorization. */
  "reject_delivery",
  /** Payer cancelled the PayPal approval. */
  "cancel_payment",
]);
export type HumanDecisionKind = z.infer<typeof HumanDecisionKindSchema>;

export const HumanDecisionSchema = z.object({
  kind: HumanDecisionKindSchema,
  /** Required for release_partial: percentage of the contract price to capture (1–99). */
  percent: z.number().int().min(1).max(99).nullable(),
  reason: z.string().max(300).nullable(),
  decidedAt: IsoDateTimeSchema,
});
export type HumanDecision = z.infer<typeof HumanDecisionSchema>;

/* -------------------------------------------------------------------------- */
/*  Audit trail                                                                */
/* -------------------------------------------------------------------------- */

export const AUDIT_ACTORS = [
  "human",
  "buyer_agent",
  "seller_agent",
  "contract_engine",
  "policy_engine",
  "payment_orchestrator",
  "paypal",
  "verifier",
  "system",
] as const;
export const AuditActorSchema = z.enum(AUDIT_ACTORS);
export type AuditActor = z.infer<typeof AuditActorSchema>;

export const AUDIT_EVENT_TYPES = [
  "intent.received",
  "mandate.derived",
  "seller.matched",
  "negotiation.move",
  "negotiation.guardrail",
  "negotiation.agreed",
  "negotiation.failed",
  "contract.created",
  "policy.evaluated",
  "policy.approval_requested",
  "human.approved_spend",
  "human.declined_spend",
  "payment.order_created",
  "payment.approved",
  "payment.authorized",
  "payment.capture_blocked",
  "payment.capture_pending",
  "payment.captured",
  "payment.voided",
  "payment.cancelled",
  "payment.expired",
  "payment.failed",
  "payment.webhook",
  "payment.reconciled",
  "delivery.submitted",
  "verification.completed",
  "verification.review_requested",
  "human.released_payment",
  "human.requested_revision",
  "human.rejected_delivery",
  "revision.requested",
  "deal.completed",
  "deal.rejected",
  // Deal-level outcomes forced by the payment's state. Kept apart from payment.expired /
  // payment.failed, which state what the provider reported and are counted as payment events.
  "deal.expired",
  "deal.failed",
  "system.degraded",
  "system.error",
] as const;
export const AuditEventTypeSchema = z.enum(AUDIT_EVENT_TYPES);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export const AuditEventSchema = z.object({
  id: z.string(),
  dealId: z.string(),
  /** 1-based, gapless per deal. */
  seq: z.number().int().min(1),
  at: IsoDateTimeSchema,
  actor: AuditActorSchema,
  type: AuditEventTypeSchema,
  /** Plain-language headline a non-technical reader understands. */
  title: z.string().max(200),
  detail: z.string().max(800).nullable(),
  /** Structured facts (ids, amounts). Never secrets, never raw model reasoning. */
  data: z.record(z.string(), z.unknown()).nullable(),
  /** Hash chain: sha256(prevHash + canonicalJson(event without hash fields)). */
  prevHash: z.string(),
  hash: z.string(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** What callers supply; the audit module assigns id, seq, at, prevHash and hash. */
export type AuditEventInput = Pick<AuditEvent, "actor" | "type" | "title"> &
  Partial<Pick<AuditEvent, "detail" | "data" | "at">>;
