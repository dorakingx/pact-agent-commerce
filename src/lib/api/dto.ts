/**
 * Shapes exchanged between the server (route handlers) and the browser.
 * These are plain serialisable types: no secrets, no vault ids, no seller floors, no raw model reasoning.
 */
import type {
  AuditEvent,
  Category,
  HumanDecision,
  HumanDecisionKind,
  Mandate,
  NegotiationMove,
  Policy,
  PolicyEvaluation,
  PolicyOutcome,
  SignedContract,
  Submission,
  Terms,
  VerificationDecision,
  VerificationReport,
} from "../domain/schemas";
import type { DealStatus, PaymentStatus } from "../domain/status";
import type { SellerPublic } from "../domain/sellers";
import type { ApprovalMode, PaymentRecord, ProviderKind } from "../payments/types";

/** The automatic steps the engine can execute. One HTTP call to /advance executes at most one. */
export type StepKind =
  | "negotiate" // one negotiation move (buyer or seller)
  | "contract" // compile + hash the contract
  | "policy" // evaluate spending policy
  | "order" // create the PayPal order (and authorize immediately in delegated mode)
  | "fulfill" // seller agent produces a delivery (first delivery or revision)
  | "verify" // run deterministic + AI verification
  | "capture" // capture the authorization
  | "void"; // void the authorization

export type HumanGate = "approval" | "payment" | "review";

export type NextStep =
  | { kind: "auto"; step: StepKind; label: string }
  | { kind: "human"; gate: HumanGate; label: string; options: HumanDecisionKind[] }
  | { kind: "done"; label: string };

export type PaymentView = PaymentRecord;

export interface DealView {
  id: string;
  code: string;
  status: DealStatus;
  statusLabel: string;
  scenarioId: string | null;
  intent: string;
  createdAt: string;
  updatedAt: string;
  /** True when the current browser session created this deal and may act on it. */
  isOwner: boolean;
  seller: SellerPublic | null;
  mandate: Mandate | null;
  negotiation: {
    status: "open" | "agreed" | "failed";
    moves: NegotiationMove[];
    agreedTerms: Terms | null;
    failureReason: string | null;
    maxMoves: number;
    /** Seller's opening list price, for the "negotiated saving" figure. Null until the seller has quoted. */
    listPriceMinor: number | null;
  };
  /** The hashed contract plus the live payment state (the state is NOT part of the hash). */
  contract: (SignedContract & { paymentState: PaymentStatus }) | null;
  policy: PolicyEvaluation | null;
  payment: PaymentView | null;
  submissions: Submission[];
  reports: VerificationReport[];
  audit: AuditEvent[];
  revisions: { used: number; limit: number };
  humanDecision: HumanDecision | null;
  next: NextStep;
  flags: {
    /** An AI call failed and a scripted fallback or degraded verification was used. */
    aiDegraded: boolean;
    /** Payments for this deal are simulated (no PayPal credentials were configured). */
    simulatedPayment: boolean;
    /** Result of re-verifying the audit hash chain on read. */
    auditChainValid: boolean;
  };
  lastError: string | null;
}

export interface CreateDealRequest {
  intent: string;
  scenarioId?: string;
}
export interface CreateDealResponse {
  deal: DealView;
}

export interface AdvanceResponse {
  deal: DealView;
  /** The step that was executed by this call, or null if nothing ran (human gate, terminal, or busy). */
  executed: StepKind | null;
  /** True when another request holds the step lease; the client should simply poll again. */
  busy: boolean;
}

export interface DecisionRequest {
  kind: HumanDecisionKind;
  percent?: number;
  reason?: string;
}

export interface DealSummary {
  id: string;
  code: string;
  title: string;
  status: DealStatus;
  statusLabel: string;
  scenarioId: string | null;
  sellerName: string | null;
  priceMinor: number | null;
  createdAt: string;
  updatedAt: string;
}

export type RiskLevel = "low" | "medium" | "high";

/** One row of the operations ledger (AG Grid / AG Studio data source "deals"). */
export interface OpsRow {
  id: string;
  code: string;
  title: string;
  status: DealStatus;
  statusLabel: string;
  /** Coarse stage for funnels: negotiated → authorized → delivered → verified → captured. */
  stage: "negotiation" | "contract" | "payment" | "fulfillment" | "verification" | "settled" | "closed";
  outcome: "in_progress" | "captured" | "voided" | "declined" | "blocked" | "no_agreement" | "failed";
  buyer: string;
  seller: string;
  sellerId: string;
  sellerTrust: "established" | "new";
  category: Category | null;
  scenarioId: string | null;
  /** "mine" = created in this browser session, "showcase" = seeded reference deals. */
  origin: "mine" | "showcase";
  priceMinor: number;
  listPriceMinor: number;
  savedMinor: number;
  authorizedMinor: number;
  capturedMinor: number;
  /** Authorized but not yet captured or released. */
  heldMinor: number;
  currency: "USD";
  paymentStatus: PaymentStatus;
  paymentProvider: ProviderKind | null;
  paymentMode: ApprovalMode | null;
  paypalOrderId: string | null;
  paypalAuthorizationId: string | null;
  paypalCaptureId: string | null;
  webhookConfirmed: boolean;
  verificationDecision: VerificationDecision | null;
  /** 0–1, weakest required check of the latest report. */
  confidence: number | null;
  failedRules: number;
  revisionsUsed: number;
  revisionLimit: number;
  negotiationMoves: number;
  guardrailInterventions: number;
  policyOutcome: PolicyOutcome | null;
  /** Ids of policy checks that did not pass, e.g. ["autonomous_limit"]. */
  policyFlags: string[];
  humanDecisions: number;
  risk: RiskLevel;
  riskReasons: string[];
  aiDegraded: boolean;
  deadline: string | null;
  hoursToDeadline: number | null;
  createdAt: string;
  updatedAt: string;
  /** Day bucket (YYYY-MM-DD, UTC) for time-series charts. */
  day: string;
}

/** One row per PayPal-facing event, for the "payment events" data source. */
export interface OpsPaymentEvent {
  id: string;
  dealId: string;
  dealCode: string;
  at: string;
  day: string;
  type: "order_created" | "approved" | "authorized" | "captured" | "voided" | "failed" | "webhook" | "capture_blocked";
  amountMinor: number;
  seller: string;
  provider: ProviderKind | null;
  reference: string | null;
}

/** One row per verification check, for failure analysis. */
export interface OpsCheckRow {
  id: string;
  dealId: string;
  dealCode: string;
  round: number;
  ruleId: string;
  kind: string;
  condition: string;
  evaluator: "deterministic" | "ai";
  result: "pass" | "fail" | "uncertain";
  confidence: number;
  required: boolean;
  seller: string;
  at: string;
}

export interface OpsSnapshot {
  generatedAt: string;
  deals: OpsRow[];
  paymentEvents: OpsPaymentEvent[];
  checks: OpsCheckRow[];
  totals: {
    deals: number;
    authorizedMinor: number;
    capturedMinor: number;
    heldMinor: number;
    releasedMinor: number;
    pendingHumanReview: number;
    verificationFailureRate: number;
    firstPassRate: number;
  };
}

export interface SystemStatus {
  payments: {
    provider: ProviderKind;
    /** PayPal REST credentials are configured. */
    configured: boolean;
    /** A verified webhook id is configured. */
    webhooks: boolean;
    /** A delegated (vaulted) demo wallet is connected, so in-policy deals authorize without a PayPal login. */
    delegatedWallet: boolean;
  };
  ai: {
    mode: "ai" | "scripted";
    buyerModel: string;
    sellerModel: string;
    verifierModel: string;
  };
  database: "postgres" | "pglite";
  version: string;
}

export interface PolicyResponse {
  policy: Policy;
  spentTodayMinor: number;
  isDefault: boolean;
}

export interface ApiErrorBody {
  error: {
    /** Stable machine code, e.g. "not_found", "forbidden", "invalid_request", "rate_limited", "conflict", "payment_error", "internal". */
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}
