/**
 * What the "PACT auditor" agent knows and can look up — the pure part.
 *
 * The auditor is a custom AG Studio agent that Studio's lead agent delegates to for questions
 * about deals rather than about charts: what needs a human, why something was or was not
 * captured, whether PACT's ledger agrees with PayPal. Its tools are thin wrappers (see the
 * dashboard's agent/tools.ts); everything they return is shaped here, from data the visitor can
 * already see: the operations snapshot, GET /api/deals/{id} and POST /api/deals/{id}/reconcile.
 *
 * The auditor is read-only by construction. There is no tool that captures, voids, approves,
 * declines or decides, so no prompt can make it do so; its instructions say that too, so it
 * tells the user instead of pretending.
 */
import type { DealView, OpsRow, OpsSnapshot, ReconciliationView } from "../api/dto";
import { formatMoney } from "../domain/money";
import { isTerminal } from "../domain/status";
import { DEMO_FAULT_DETAIL, providerLabel } from "./ops-derive";
import { OUTCOME_LABEL, PAYMENT_STATUS_TEXT, RISK_LABEL, isAwaitingHuman, sellerNoteOf, stopReasonOf } from "./studio-data";

export const AUDITOR_AGENT_ID = "auditor";
export const AUDITOR_AGENT_NAME = "PACT auditor";

export const TOOL = {
  attention: "list_attention_items",
  find: "find_deals",
  explain: "explain_deal",
  reconcile: "reconcile_with_paypal",
} as const;

/* -------------------------------------------------------------------------- */
/*  Wording                                                                    */
/* -------------------------------------------------------------------------- */

/** Shown above the prompt starters of an empty conversation, and (in short) under the chat box. */
export const AGENT_INTRO =
  "Ask about deals, held funds and verdicts, or ask for a chart. The agents are read-only: they can explain, query, reconcile and rearrange this dashboard. They can never capture, void, approve or decide — that stays with PACT's deterministic engine and with you.";

export const AGENT_INPUT_PLACEHOLDER = "Ask about deals, holds and verdicts…";

export interface PromptStarter {
  label: string;
  prompt: string;
}

export const PROMPT_STARTERS: readonly PromptStarter[] = [
  { label: "Which deals need a human right now?", prompt: "Which deals need a human right now? For each one say what is being asked and why it stopped." },
  {
    label: "Show contracts at risk of missing their deadline",
    prompt: "Show contracts at risk of missing their deadline: which open deals are close to or past their deadline, and is money held on them?",
  },
  {
    label: "Authorized vs captured by seller",
    prompt: "Authorized vs captured by seller: give me the numbers per seller, and say which seller has the largest gap.",
  },
  {
    label: "Why was the latest failed deal not captured?",
    prompt: "Why was the latest failed deal not captured? Name the conditions that failed, with the evidence.",
  },
  {
    label: "Reconcile the most recent captured deal with PayPal",
    prompt: "Reconcile the most recent captured deal with PayPal and tell me whether PACT's ledger and PayPal agree.",
  },
];

const READ_ONLY_RULE =
  "You are strictly read-only with respect to money and decisions. You cannot capture, void, refund, approve, decline, release or decide anything, and no tool exists for it. If asked to, say that PACT only moves money through its deterministic engine after a human or the verifier allows it, and point to the deal page where a person can decide.";

/** System instructions of the auditor. Built per run so the counts are current. */
export function auditorInstructions(snapshot: Pick<OpsSnapshot, "deals" | "totals">): string {
  const waiting = snapshot.deals.filter((deal) => isAwaitingHuman(deal.status)).length;
  return [
    "## Role",
    `You are the ${AUDITOR_AGENT_NAME}, a specialist agent inside PACT (Programmable Agent Commerce Trust). PACT lets AI agents negotiate a deal, places a PayPal authorization hold, and captures the money only if the delivery is verified against the contract.`,
    "You answer questions about individual deals and about what needs attention: what is waiting for a human, what is at risk, why a deal was or was not captured, and whether PACT's ledger agrees with PayPal.",
    "",
    "## Rules",
    `1. ${READ_ONLY_RULE}`,
    "2. Use your tools for every fact. Never invent a deal code, an amount, an id or a reason. If a tool returns nothing, say so.",
    `3. To talk about one deal you need its code (like PACT-7K2Q). If the request does not name one ("the latest failed deal", "the most recent captured deal"), call ${TOOL.find} first and take the first match.`,
    `4. ${TOOL.explain} explains one deal: status, why it stopped or settled, failed conditions with evidence, policy flags, PayPal ids. ${TOOL.reconcile} re-reads PayPal's record and compares it field by field; it changes nothing.`,
    `5. ${TOOL.attention} lists deals that need a human or are at risk, with reasons. Use focus "deadline_risk" for deadline questions.`,
    "6. Vocabulary: say 'authorization hold', 'held', 'captured', 'voided' or 'released'. A simulated payment must be called simulated. A seller marked as a demo fault must be called that.",
    "7. Be brief and concrete: deal codes, amounts in USD, the failed condition and its evidence. No preamble, no speculation, no step-by-step reasoning.",
    "8. Finish by calling complete_task. Its `summary` is the ONLY thing the lead agent receives; it never sees your tool results. So the summary must BE the answer, complete and self-contained: every deal with its code, seller, amount, what is being asked and the reason, copied exactly from the tool results. Never describe what you did (\"Listed 4 deals…\"); write the answer itself. Call complete_task exactly once, with every item in that one summary.",
    "",
    "## Right now",
    `${snapshot.totals.deals} deals in view, ${waiting} waiting for a human, ${formatMoney(snapshot.totals.heldMinor)} held, ${formatMoney(snapshot.totals.capturedMinor)} captured.`,
  ].join("\n");
}

/** Appended to the built-in lead agent's instructions so it knows when to hand off to the auditor. */
export const LEAD_ADDENDUM = [
  "## PACT context",
  "This dashboard is PACT's Agent Commerce Operations report: AI agents negotiate deals, PayPal authorizations hold the money, and a capture only happens after the delivery is verified against the contract.",
  `${READ_ONLY_RULE.replace("You are strictly", "You and every delegate are strictly")}`,
  "",
  `**${AUDITOR_AGENT_NAME} (type: '${AUDITOR_AGENT_ID}')**`,
  "A read-only specialist for questions about deals rather than charts. Delegate to it, passing the user's question in full, when the user asks:",
  "- which deals need a human, what is waiting for approval or review, what is at risk or close to its deadline;",
  "- why a specific deal (or 'the latest failed deal') was or was not captured, stopped, was voided or blocked;",
  "- to reconcile a deal with PayPal, or anything about PayPal order, authorization or capture ids.",
  "Its reply is the source of truth. Relay it to the user faithfully: keep every deal code, seller, amount and reason exactly as given (you may tidy the formatting). NEVER add or change a fact. You have not seen the deals yourself, so anything not in its reply is unknown to you: say it is not available, or delegate again with a more specific question. Do not re-query what it already answered.",
  "For totals and breakdowns across deals ('authorized vs captured by seller') use Data; to put a chart on the page use Page then Widget.",
  "The widget catalogue includes three PACT widgets (settlement rail, human review queue, verdict card): prefer them when the request matches what they show.",
].join("\n");

/* -------------------------------------------------------------------------- */
/*  list_attention_items                                                       */
/* -------------------------------------------------------------------------- */

export const ATTENTION_FOCUS = ["all", "needs_human", "at_risk", "deadline_risk"] as const;
export type AttentionFocus = (typeof ATTENTION_FOCUS)[number];

export interface AttentionItem {
  code: string;
  title: string;
  status: string;
  seller: string;
  sellerNote: string | null;
  needsHuman: boolean;
  /** What a person is being asked to do, when the deal waits for one. */
  ask: string | null;
  risk: string;
  reasons: string[];
  /** Amounts are sent as finished text ("$136.80"): a model copies text faithfully and reformats numbers badly. */
  contractValue: string;
  held: string;
  /** "Simulated", "PayPal Sandbox", or "No payment yet". */
  payment: string;
  deadline: string | null;
  hoursToDeadline: number | null;
}

/** Inside this window an open deal's deadline is worth a look, matching the risk rating's early warning. */
const DEADLINE_WINDOW_HOURS = 24;
const RISK_RANK = { high: 0, medium: 1, low: 2 } as const;

function hasDeadlineRisk(deal: OpsRow): boolean {
  if (isTerminal(deal.status) || deal.hoursToDeadline === null) return false;
  // A delivery that already passed verification can no longer miss its deadline.
  if (deal.verificationDecision === "capture_eligible") return false;
  return deal.hoursToDeadline < DEADLINE_WINDOW_HOURS;
}

function matchesFocus(deal: OpsRow, focus: AttentionFocus): boolean {
  switch (focus) {
    case "needs_human":
      return isAwaitingHuman(deal.status);
    case "at_risk":
      return deal.risk !== "low";
    case "deadline_risk":
      return hasDeadlineRisk(deal);
    case "all":
      return isAwaitingHuman(deal.status) || deal.risk !== "low" || hasDeadlineRisk(deal);
  }
}

function paymentLabel(deal: Pick<OpsRow, "paymentProvider">): string {
  return providerLabel(deal.paymentProvider) ?? "No payment yet";
}

function toAttentionItem(deal: OpsRow): AttentionItem {
  const needsHuman = isAwaitingHuman(deal.status);
  const reasons = [...deal.riskReasons];
  const stop = stopReasonOf(deal);
  if (stop !== null && !reasons.includes(stop)) reasons.unshift(stop);
  if (hasDeadlineRisk(deal) && !reasons.some((reason) => reason.toLowerCase().includes("deadline"))) {
    const hours = deal.hoursToDeadline ?? 0;
    reasons.push(hours <= 0 ? `Deadline passed ${Math.abs(hours)}h ago` : `Deadline in ${hours}h`);
  }
  return {
    code: deal.code,
    title: deal.title,
    status: deal.statusLabel,
    seller: deal.seller,
    sellerNote: sellerNoteOf(deal.sellerId),
    needsHuman,
    ask: !needsHuman ? null : deal.status === "awaiting_approval" ? "Approve or decline the spend" : "Review the delivery and decide",
    risk: RISK_LABEL[deal.risk],
    reasons,
    contractValue: formatMoney(deal.priceMinor),
    held: formatMoney(deal.heldMinor),
    payment: paymentLabel(deal),
    deadline: deal.deadline,
    hoursToDeadline: deal.hoursToDeadline,
  };
}

export interface AttentionResult {
  focus: AttentionFocus;
  total: number;
  needsHuman: number;
  held: string;
  items: AttentionItem[];
  /** Matching deals beyond `items`. */
  omitted: number;
}

/**
 * Deals that need a person or are at risk, most urgent first: human gates, then by risk, then by
 * the nearest deadline. Bounded, so a large ledger cannot flood the model's context.
 */
export function listAttentionItems(snapshot: Pick<OpsSnapshot, "deals">, focus: AttentionFocus, limit = 12): AttentionResult {
  const matches = snapshot.deals.filter((deal) => matchesFocus(deal, focus));
  const ordered = [...matches].sort(
    (a, b) =>
      Number(isAwaitingHuman(b.status)) - Number(isAwaitingHuman(a.status)) ||
      RISK_RANK[a.risk] - RISK_RANK[b.risk] ||
      (a.hoursToDeadline ?? Number.POSITIVE_INFINITY) - (b.hoursToDeadline ?? Number.POSITIVE_INFINITY) ||
      a.code.localeCompare(b.code),
  );
  const shown = ordered.slice(0, Math.max(1, limit));
  return {
    focus,
    total: matches.length,
    needsHuman: matches.filter((deal) => isAwaitingHuman(deal.status)).length,
    held: formatMoney(matches.reduce((total, deal) => total + deal.heldMinor, 0)),
    items: shown.map(toAttentionItem),
    omitted: matches.length - shown.length,
  };
}

/* -------------------------------------------------------------------------- */
/*  find_deals                                                                 */
/* -------------------------------------------------------------------------- */

export const DEAL_FILTER = ["any", "captured", "not_captured", "failed_verification", "in_progress", "needs_human"] as const;
export type DealFilter = (typeof DEAL_FILTER)[number];

export interface DealBrief {
  code: string;
  title: string;
  status: string;
  outcome: string;
  seller: string;
  contractValue: string;
  captured: string;
  held: string;
  verification: string | null;
  failedConditions: number;
  payment: string;
  updatedAt: string;
}

function matchesFilter(deal: OpsRow, filter: DealFilter): boolean {
  switch (filter) {
    case "any":
      return true;
    case "captured":
      return deal.outcome === "captured";
    case "not_captured":
      // Ended without a capture: voided, declined, blocked, no agreement, failed.
      return deal.outcome !== "captured" && deal.outcome !== "in_progress";
    case "failed_verification":
      return deal.failedRules > 0 || deal.verificationDecision === "reject" || deal.verificationDecision === "revision_required" || deal.revisionsUsed > 0;
    case "in_progress":
      return deal.outcome === "in_progress";
    case "needs_human":
      return isAwaitingHuman(deal.status);
  }
}

const VERIFICATION_TEXT: Record<NonNullable<OpsRow["verificationDecision"]>, string> = {
  capture_eligible: "Capture eligible",
  human_review: "Human review",
  revision_required: "Revision required",
  reject: "Rejected",
};

/** Deals matching a filter, most recently updated first. */
export function findDeals(snapshot: Pick<OpsSnapshot, "deals">, filter: DealFilter, limit = 5): { filter: DealFilter; total: number; deals: DealBrief[] } {
  const matches = snapshot.deals.filter((deal) => matchesFilter(deal, filter)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    filter,
    total: matches.length,
    deals: matches.slice(0, Math.max(1, limit)).map((deal) => ({
      code: deal.code,
      title: deal.title,
      status: deal.statusLabel,
      outcome: OUTCOME_LABEL[deal.outcome],
      seller: deal.seller,
      contractValue: formatMoney(deal.priceMinor),
      captured: formatMoney(deal.capturedMinor),
      held: formatMoney(deal.heldMinor),
      verification: deal.verificationDecision === null ? null : VERIFICATION_TEXT[deal.verificationDecision],
      failedConditions: deal.failedRules,
      payment: paymentLabel(deal),
      updatedAt: deal.updatedAt,
    })),
  };
}

/** The deal a code names, case-insensitively and tolerant of surrounding punctuation or spaces. */
export function dealByCode(snapshot: Pick<OpsSnapshot, "deals">, code: string): OpsRow | null {
  const wanted = code.trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "").toLowerCase();
  if (wanted.length === 0) return null;
  return snapshot.deals.find((deal) => deal.code.toLowerCase() === wanted) ?? null;
}

/* -------------------------------------------------------------------------- */
/*  explain_deal                                                               */
/* -------------------------------------------------------------------------- */

export interface ExplainedCondition {
  rule: string;
  condition: string;
  result: "fail" | "uncertain";
  evaluator: "deterministic" | "ai";
  confidence: string;
  evidence: string;
  explanation: string;
}

export interface DealExplanation {
  code: string;
  title: string;
  status: string;
  /** One or two sentences: why the deal stopped where it is, or how it settled. */
  why: string;
  nextStep: string;
  seller: { name: string; trust: string; note: string | null } | null;
  contract: { price: string; deadline: string; revisionLimit: number; termsHash: string } | null;
  policy: { outcome: string; flags: { check: string; outcome: string; detail: string }[] } | null;
  verification: {
    rounds: number;
    round: number;
    decision: string;
    /** Weakest required check, as a percentage. */
    confidence: string;
    summary: string;
    degraded: boolean;
    conditionsChecked: number;
    notPassed: ExplainedCondition[];
  } | null;
  payment: {
    rail: string;
    simulated: boolean;
    status: string;
    approvalMode: string;
    authorized: string;
    captured: string;
    paypalOrderId: string | null;
    paypalAuthorizationId: string | null;
    paypalCaptureId: string | null;
    confirmedByWebhook: boolean;
    lastError: string | null;
  } | null;
  humanDecision: { decision: string; reason: string | null; at: string } | null;
  revisions: { used: number; limit: number };
  auditTrail: { events: number; hashChainValid: boolean };
  aiDegraded: boolean;
}

const DECISION_TEXT: Record<DealView["reports"][number]["decision"], string> = {
  capture_eligible: "capture eligible",
  human_review: "sent to human review",
  revision_required: "revision required",
  reject: "rejected",
};

const POLICY_TEXT: Record<NonNullable<DealView["policy"]>["outcome"], string> = {
  allow: "Within policy",
  needs_approval: "Needs human approval",
  block: "Blocked",
};

const HUMAN_DECISION_TEXT: Record<NonNullable<DealView["humanDecision"]>["kind"], string> = {
  approve_spend: "Approved the spend",
  decline_spend: "Declined the spend",
  release_payment: "Released the full payment",
  release_partial: "Released part of the payment",
  request_revision: "Requested a revision",
  reject_delivery: "Rejected the delivery",
  cancel_payment: "Cancelled the payment",
};

function failedRuleList(report: DealView["reports"][number]): string {
  const failed = report.checks.filter((check) => check.result === "fail").map((check) => `${check.ruleId} (${check.condition})`);
  return failed.length === 0 ? "" : ` Failed: ${failed.join("; ")}.`;
}

/** Why the deal is where it is, written from the deal's own records. */
export function whyOf(deal: DealView): string {
  const price = deal.contract ? formatMoney(deal.contract.contract.price.amountMinor) : null;
  const held = deal.payment ? formatMoney(Math.max(0, deal.payment.authorizedMinor - deal.payment.capturedMinor)) : null;
  const report = deal.reports[deal.reports.length - 1];
  const simulated = deal.flags.simulatedPayment ? " (simulated payment)" : "";
  switch (deal.status) {
    case "completed": {
      const captured = formatMoney(deal.payment?.capturedMinor ?? 0);
      const after = deal.humanDecision?.kind === "release_payment" || deal.humanDecision?.kind === "release_partial" ? "a human released it after review" : "every required condition was verified";
      return `Settled: ${captured} was captured${simulated} because ${after}${deal.revisions.used > 0 ? `, after ${deal.revisions.used} revision` : ""}.`;
    }
    case "rejected":
      return `Not captured: the delivery was rejected and the authorization was voided${simulated}.${report ? failedRuleList(report) : ""} ${deal.humanDecision?.kind === "reject_delivery" ? "A human rejected it in review." : "No revisions remained."}`.trim();
    case "in_review":
      return `Stopped for a human: verification was inconclusive${report ? ` (${report.summary})` : ""}. ${held ?? "The amount"} stays held${simulated}; nothing is captured until someone decides.`;
    case "awaiting_approval": {
      const flags = (deal.policy?.checks ?? []).filter((check) => check.outcome !== "pass").map((check) => check.detail);
      return `Stopped for a human before any payment: the spending policy requires approval${flags.length > 0 ? ` (${flags.join(" ")})` : ""}. No PayPal order exists yet.`;
    }
    case "awaiting_payment":
      return `Waiting for the payer to approve the ${price ?? ""} order in PayPal${simulated}. Nothing is held yet.`.replace("  ", " ");
    case "revision_required":
      return `Not captured: the delivery failed verification and was sent back for a revision.${report ? failedRuleList(report) : ""} ${held ?? "The amount"} stays held${simulated}.`;
    case "declined":
      return `Closed without payment: a human declined the spend${deal.humanDecision?.reason ? ` (“${deal.humanDecision.reason}”)` : ""}.`;
    case "blocked": {
      const blocks = (deal.policy?.checks ?? []).filter((check) => check.outcome === "block").map((check) => check.detail);
      return `Closed without payment: blocked by the spending policy${blocks.length > 0 ? ` (${blocks.join(" ")})` : ""}.`;
    }
    case "negotiation_failed":
      return `Closed without a contract: the agents could not agree${deal.negotiation.failureReason ? ` (${deal.negotiation.failureReason})` : ""}.`;
    case "cancelled":
      return `Closed without capture: the payer cancelled, and any authorization was released${simulated}.`;
    case "expired":
      return `Closed without capture: the PayPal authorization expired or was released before the delivery was verified${simulated}.`;
    case "failed":
      return `Closed: a payment step failed terminally${deal.payment?.lastError ? ` (${deal.payment.lastError.issue}: ${deal.payment.lastError.message})` : ""}.`;
    case "authorized":
      return `In progress: ${held ?? "the amount"} is held${simulated} while the seller agent works. Nothing has been captured.`;
    case "submitted":
      return `In progress: the seller delivered and verification is running. ${held ?? "The amount"} stays held${simulated}.`;
    case "verified":
      return `In progress: the delivery passed verification and the capture is being executed${simulated}.`;
    case "rejecting":
      return `In progress: the delivery was rejected and the authorization is being voided${simulated}.`;
    case "negotiating":
    case "agreed":
    case "contracted":
    case "payment_pending":
      return `In progress: ${deal.next.label}. No money is held yet.`;
  }
}

/** Everything the auditor says about one deal, shaped from the deal view. Contains no reasoning text and no budget. */
export function explainDeal(deal: DealView): DealExplanation {
  const report = deal.reports[deal.reports.length - 1] ?? null;
  return {
    code: deal.code,
    // The request itself can state the buyer's budget, which is private to the buyer agent: before
    // a contract exists there is simply no title to give.
    title: deal.contract?.contract.title ?? "No contract yet",
    status: deal.statusLabel,
    why: whyOf(deal),
    nextStep: deal.next.label,
    seller:
      deal.seller === null
        ? null
        : {
            name: deal.seller.name,
            trust: deal.seller.trust === "new" ? "New seller" : "Established",
            note: deal.seller.demoFault === null ? null : DEMO_FAULT_DETAIL[deal.seller.demoFault],
          },
    contract:
      deal.contract === null
        ? null
        : {
            price: formatMoney(deal.contract.contract.price.amountMinor),
            deadline: deal.contract.contract.deadline,
            revisionLimit: deal.contract.contract.revisionLimit,
            termsHash: deal.contract.termsHash,
          },
    policy:
      deal.policy === null
        ? null
        : {
            outcome: POLICY_TEXT[deal.policy.outcome],
            flags: deal.policy.checks
              .filter((check) => check.outcome !== "pass")
              .map((check) => ({ check: check.label, outcome: check.outcome === "block" ? "Blocked" : "Needs approval", detail: check.detail })),
          },
    verification:
      report === null
        ? null
        : {
            rounds: deal.reports.length,
            round: report.round,
            decision: DECISION_TEXT[report.decision],
            confidence: `${Math.round(report.confidence * 100)}%`,
            summary: report.summary,
            degraded: report.degraded,
            conditionsChecked: report.checks.length,
            notPassed: report.checks.flatMap((check): ExplainedCondition[] =>
              check.result === "pass"
                ? []
                : [
                    {
                      rule: check.ruleId,
                      condition: check.condition,
                      result: check.result,
                      evaluator: check.evaluator,
                      confidence: `${Math.round(check.confidence * 100)}%`,
                      evidence: check.evidence,
                      explanation: check.explanation,
                    },
                  ],
            ),
          },
    payment:
      deal.payment === null
        ? null
        : {
            rail: providerLabel(deal.payment.provider) ?? "Unknown",
            simulated: deal.payment.provider === "simulated",
            status: PAYMENT_STATUS_TEXT[deal.payment.status],
            approvalMode: deal.payment.mode === "delegated" ? "Delegated agent wallet" : "Approved by the payer in PayPal",
            authorized: formatMoney(deal.payment.authorizedMinor),
            captured: formatMoney(deal.payment.capturedMinor),
            paypalOrderId: deal.payment.orderId,
            paypalAuthorizationId: deal.payment.authorizationId,
            paypalCaptureId: deal.payment.captureId,
            confirmedByWebhook: deal.payment.webhookConfirmed.authorized || deal.payment.webhookConfirmed.captured || deal.payment.webhookConfirmed.voided,
            lastError: deal.payment.lastError === null ? null : `${deal.payment.lastError.issue}: ${deal.payment.lastError.message}`,
          },
    humanDecision:
      deal.humanDecision === null
        ? null
        : { decision: HUMAN_DECISION_TEXT[deal.humanDecision.kind], reason: deal.humanDecision.reason, at: deal.humanDecision.decidedAt },
    revisions: deal.revisions,
    auditTrail: { events: deal.audit.length, hashChainValid: deal.flags.auditChainValid },
    aiDegraded: deal.flags.aiDegraded,
  };
}

/* -------------------------------------------------------------------------- */
/*  reconcile_with_paypal                                                      */
/* -------------------------------------------------------------------------- */

export interface ReconciliationSummary {
  code: string;
  /** "match", "mismatch" or "unavailable": the deterministic verdict. */
  status: ReconciliationView["status"];
  verdict: string;
  checkedAt: string;
  facts: ReconciliationView["facts"];
  mismatches: string[];
  /** The auditor agent's plain-language statement from the server, when one was written. */
  statement: string | null;
  /** How the comparison was produced: a deterministic read, optionally narrated by the server's auditor agent. */
  source: string;
  note: string | null;
}

/** The reconciliation result as the agent relays it. The facts are authoritative; the statement only narrates them. */
export function summarizeReconciliation(code: string, view: ReconciliationView): ReconciliationSummary {
  const mismatches = view.facts.filter((fact) => !fact.match).map((fact) => fact.field);
  const verdict =
    view.status === "match"
      ? `PACT's ledger and PayPal agree on all ${view.facts.length} fields.`
      : view.status === "mismatch"
        ? `PACT's ledger and PayPal disagree on ${mismatches.length} of ${view.facts.length} fields: ${mismatches.join(", ")}.`
        : "PayPal's record could not be read, so nothing was compared.";
  return {
    code,
    status: view.status,
    verdict,
    checkedAt: view.checkedAt,
    facts: view.facts,
    mismatches,
    statement: view.narrative,
    source:
      view.source === "ai"
        ? `Deterministic comparison, narrated by the server-side auditor agent${view.model ? ` (${view.model})` : ""} using read-only PayPal tools: ${view.toolCalls.map((call) => call.tool).join(", ") || "none"}`
        : "Deterministic comparison (no model involved)",
    note: view.note,
  };
}
