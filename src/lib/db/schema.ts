/**
 * Database schema (PostgreSQL via Drizzle). The same schema and migrations run on
 * managed Postgres in production and on PGlite (in-process Postgres) for local dev and CI.
 *
 * JSONB columns hold documents whose shape is defined — and validated on every read and
 * write — by the Zod schemas in src/lib/domain/schemas.ts.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  Artifact,
  GuardrailNote,
  HumanDecision,
  Mandate,
  Policy,
  PolicyEvaluation,
  SignedContract,
  Terms,
  VerificationCheck,
} from "../domain/schemas";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

/** One row per deal: the aggregate root. Summary columns are denormalised for the operations grid. */
export const deals = pgTable(
  "deals",
  {
    id: text("id").primaryKey(),
    /** Human-friendly reference, e.g. "PACT-7Q4M". */
    code: text("code").notNull(),
    /** Anonymous session id that created the deal, or "system" for seeded showcase deals. */
    owner: text("owner").notNull(),
    scenarioId: text("scenario_id"),
    status: text("status").notNull(),
    intent: text("intent").notNull(),
    mandate: jsonb("mandate").$type<Mandate>(),
    category: text("category"),
    sellerId: text("seller_id"),
    negotiationStatus: text("negotiation_status").notNull().default("open"),
    agreedTerms: jsonb("agreed_terms").$type<Terms>(),
    negotiationFailure: text("negotiation_failure"),
    policyEvaluation: jsonb("policy_evaluation").$type<PolicyEvaluation>(),
    /** Latest human decision at a gate (spend approval or delivery review). */
    humanDecision: jsonb("human_decision").$type<HumanDecision>(),
    priceMinor: integer("price_minor"),
    deadline: ts("deadline"),
    revisionLimit: integer("revision_limit"),
    revisionsUsed: integer("revisions_used").notNull().default(0),
    /** True if any AI call for this deal fell back to a scripted agent / degraded verification. */
    aiDegraded: boolean("ai_degraded").notNull().default(false),
    lastError: text("last_error"),
    /** Optimistic concurrency + step lease so two requests can never run the same step twice. */
    version: integer("version").notNull().default(0),
    lockId: text("lock_id"),
    lockedUntil: ts("locked_until"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("deals_code_idx").on(t.code),
    index("deals_owner_idx").on(t.owner, t.createdAt),
    index("deals_status_idx").on(t.status),
  ],
);

export const negotiationMoves = pgTable(
  "negotiation_moves",
  {
    dealId: text("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    terms: jsonb("terms").$type<Terms>(),
    message: text("message").notNull(),
    guardrails: jsonb("guardrails").$type<GuardrailNote[]>().notNull(),
    source: text("source").notNull(),
    model: text("model"),
    latencyMs: integer("latency_ms"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.dealId, t.seq] })],
);

export const contracts = pgTable(
  "contracts",
  {
    id: text("id").primaryKey(),
    dealId: text("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    termsHash: text("terms_hash").notNull(),
    document: jsonb("document").$type<SignedContract>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("contracts_deal_idx").on(t.dealId)],
);

/** One payment record per deal. Every id here is PayPal's. */
export const payments = pgTable(
  "payments",
  {
    dealId: text("deal_id")
      .primaryKey()
      .references(() => deals.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    mode: text("mode").notNull(),
    status: text("status").notNull(),
    orderId: text("order_id"),
    authorizationId: text("authorization_id"),
    captureId: text("capture_id"),
    amountMinor: integer("amount_minor").notNull(),
    authorizedMinor: integer("authorized_minor").notNull().default(0),
    capturedMinor: integer("captured_minor").notNull().default(0),
    currency: text("currency").notNull().default("USD"),
    approveUrl: text("approve_url"),
    authorizationExpiresAt: ts("authorization_expires_at"),
    payerEmailMasked: text("payer_email_masked"),
    lastError: jsonb("last_error").$type<{ issue: string; message: string; debugId: string | null; at: string }>(),
    webhookConfirmed: jsonb("webhook_confirmed")
      .$type<{ authorized: boolean; captured: boolean; voided: boolean }>()
      .notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("payments_order_idx").on(t.orderId), index("payments_auth_idx").on(t.authorizationId)],
);

/**
 * Idempotency ledger for money-moving calls. The primary key IS the idempotency key
 * (also sent to PayPal as PayPal-Request-Id), so a duplicate capture cannot be recorded.
 */
export const paymentOperations = pgTable(
  "payment_operations",
  {
    key: text("key").primaryKey(),
    dealId: text("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    request: jsonb("request").$type<Record<string, unknown>>(),
    response: jsonb("response").$type<Record<string, unknown>>(),
    error: jsonb("error").$type<{ issue: string; message: string; debugId: string | null }>(),
    attempts: integer("attempts").notNull().default(1),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("payment_ops_deal_idx").on(t.dealId)],
);

export const submissions = pgTable(
  "submissions",
  {
    id: text("id").primaryKey(),
    dealId: text("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    artifacts: jsonb("artifacts").$type<Artifact[]>().notNull(),
    note: text("note").notNull(),
    source: text("source").notNull(),
    model: text("model"),
    submittedAt: ts("submitted_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("submissions_deal_round_idx").on(t.dealId, t.round)],
);

export const verificationReports = pgTable(
  "verification_reports",
  {
    id: text("id").primaryKey(),
    dealId: text("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    submissionId: text("submission_id").notNull(),
    round: integer("round").notNull(),
    contractHash: text("contract_hash").notNull(),
    checks: jsonb("checks").$type<VerificationCheck[]>().notNull(),
    decision: text("decision").notNull(),
    confidence: real("confidence").notNull(),
    summary: text("summary").notNull(),
    failedRuleIds: jsonb("failed_rule_ids").$type<string[]>().notNull(),
    degraded: boolean("degraded").notNull().default(false),
    model: text("model"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("verification_deal_round_idx").on(t.dealId, t.round)],
);

/** Append-only, hash-chained audit trail. */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    dealId: text("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    at: ts("at").notNull(),
    actor: text("actor").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    detail: text("detail"),
    data: jsonb("data").$type<Record<string, unknown>>(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [uniqueIndex("audit_deal_seq_idx").on(t.dealId, t.seq), index("audit_at_idx").on(t.at)],
);

/** Spending policy per owner (anonymous session). Owner "default" is the fallback. */
export const policies = pgTable("policies", {
  owner: text("owner").primaryKey(),
  document: jsonb("document").$type<Policy>().notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/**
 * Delegated agent wallets: a PayPal vault token the human consented to once.
 * Owner "demo" is the shared, operator-connected sandbox wallet used by the public demo.
 * The vault id never leaves the server.
 */
export const wallets = pgTable("wallets", {
  owner: text("owner").primaryKey(),
  provider: text("provider").notNull(),
  status: text("status").notNull(),
  setupTokenId: text("setup_token_id"),
  vaultId: text("vault_id"),
  payerEmailMasked: text("payer_email_masked"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Every PayPal webhook delivery, deduplicated on PayPal's event id. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    resourceId: text("resource_id"),
    dealId: text("deal_id"),
    verified: boolean("verified").notNull(),
    verificationMethod: text("verification_method").notNull(),
    processed: boolean("processed").notNull().default(false),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [index("webhook_deal_idx").on(t.dealId)],
);

/** Fixed-window counters for abuse protection on the public demo. */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: ts("window_start").notNull(),
  count: integer("count").notNull().default(0),
});

export type DealRow = typeof deals.$inferSelect;
export type DealInsert = typeof deals.$inferInsert;
export type NegotiationMoveRow = typeof negotiationMoves.$inferSelect;
export type ContractRow = typeof contracts.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type PaymentInsert = typeof payments.$inferInsert;
export type PaymentOperationRow = typeof paymentOperations.$inferSelect;
export type SubmissionRow = typeof submissions.$inferSelect;
export type VerificationReportRow = typeof verificationReports.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type PolicyRow = typeof policies.$inferSelect;
export type WalletRow = typeof wallets.$inferSelect;
export type WebhookEventRow = typeof webhookEvents.$inferSelect;
