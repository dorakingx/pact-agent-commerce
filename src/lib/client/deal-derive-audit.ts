/**
 * Pure view logic for the audit trail: who an entry is attributed to, and how its structured
 * `data` is shown as a short list of facts instead of raw JSON.
 */
import { formatMoney, isMinor } from "@/lib/domain/money";
import type { AuditActor, AuditEvent } from "@/lib/domain/schemas";

const ACTOR_LABEL: Record<AuditActor, string> = {
  human: "You",
  buyer_agent: "Buyer agent",
  seller_agent: "Seller agent",
  contract_engine: "Contract engine",
  policy_engine: "Policy engine",
  payment_orchestrator: "Payment orchestrator",
  paypal: "PayPal",
  verifier: "Verifier",
  system: "System",
};

/**
 * The name shown next to an entry. A visitor did not take the human's decisions, and a
 * simulated provider is never passed off as PayPal.
 */
export function auditActorLabel(actor: AuditActor, context: { isOwner: boolean; simulatedPayment: boolean }): string {
  if (actor === "human" && !context.isOwner) return "Deal owner";
  if (actor === "paypal" && context.simulatedPayment) return "PayPal (simulated)";
  return ACTOR_LABEL[actor];
}

/**
 * The engine words a human's own actions in the second person ("You approved this spend").
 * For anyone else reading the trail, that sentence would claim an action they did not take.
 */
export function auditTitle(event: Pick<AuditEvent, "actor" | "title">, context: { isOwner: boolean }): string {
  if (context.isOwner || event.actor !== "human") return event.title;
  return event.title.replace(/^You\b/, "The deal's owner");
}

export type AuditFactKind = "text" | "money" | "id" | "time";

export interface AuditFact {
  key: string;
  label: string;
  value: string;
  kind: AuditFactKind;
}

/** Labels that read better than the mechanical camelCase split. */
const FACT_LABEL: Record<string, string> = {
  customId: "PayPal custom_id",
  invoiceId: "PayPal invoice_id",
  orderId: "Order ID",
  authorizationId: "Authorization ID",
  captureId: "Capture ID",
  contractId: "Contract ID",
  submissionId: "Submission ID",
  reportId: "Report ID",
  sellerId: "Seller",
  scenarioId: "Scenario",
  termsHash: "Terms hash",
  idempotencyKey: "Idempotency key",
  failedRuleIds: "Failed rules",
  seq: "Move",
  debugId: "PayPal debug ID",
};

function humanise(key: string): string {
  const fixed = FACT_LABEL[key];
  if (fixed !== undefined) return fixed;
  const words = key
    .replace(/Minor$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words === "" ? key : words[0].toUpperCase() + words.slice(1);
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const FACT_VALUE_MAX = 160;

function scalar(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return null;
}

function factFor(key: string, value: unknown): AuditFact | null {
  if (value === null || value === undefined) return null;
  const label = humanise(key);
  if (key.endsWith("Minor") && isMinor(value)) return { key, label, value: formatMoney(value), kind: "money" };
  if (Array.isArray(value)) {
    const items = value.map(scalar).filter((item): item is string => item !== null);
    return { key, label, value: items.length === 0 ? "None" : items.join(", "), kind: "text" };
  }
  if (typeof value === "object") {
    // Nested structures are rare; show them compactly rather than dropping a fact silently.
    const json = JSON.stringify(value);
    return { key, label, value: json.length > FACT_VALUE_MAX ? `${json.slice(0, FACT_VALUE_MAX - 1)}…` : json, kind: "text" };
  }
  const text = scalar(value);
  if (text === null) return null;
  if (typeof value === "string") {
    if (ISO_TIME.test(value)) return { key, label, value, kind: "time" };
    if (/(?:Id|Hash|Key)$/.test(key) && key !== "sellerId" && key !== "scenarioId") {
      return { key, label, value, kind: "id" };
    }
  }
  return { key, label, value: text, kind: "text" };
}

/** The key facts of an audit entry, in the order the engine recorded them. */
export function auditFacts(data: AuditEvent["data"]): AuditFact[] {
  if (data === null) return [];
  return Object.entries(data)
    .map(([key, value]) => factFor(key, value))
    .filter((fact): fact is AuditFact => fact !== null);
}

/** The newest link of the hash chain, shown in the trail's header. */
export function auditHeadHash(audit: readonly Pick<AuditEvent, "hash">[]): string | null {
  return audit.length === 0 ? null : audit[audit.length - 1].hash;
}

export type AuditTone = "neutral" | "info" | "hold" | "success" | "review" | "danger";

/**
 * The colour of an entry's marker. It follows what happened to the money and who had to act:
 * amber for a hold, emerald for a capture, violet wherever a human is involved.
 */
export function auditEventTone(event: Pick<AuditEvent, "type" | "data">): AuditTone {
  switch (event.type) {
    case "payment.authorized":
      return "hold";
    case "payment.captured":
    case "deal.completed":
      return "success";
    case "payment.failed":
    case "payment.capture_blocked":
    case "deal.failed":
    case "system.error":
      return "danger";
    case "system.degraded":
    case "negotiation.guardrail":
    case "revision.requested":
    case "payment.capture_pending":
      return "hold";
    case "policy.approval_requested":
    case "verification.review_requested":
      return "review";
    case "verification.completed": {
      const decision = event.data?.decision;
      if (decision === "capture_eligible") return "success";
      if (decision === "human_review") return "review";
      return decision === "revision_required" || decision === "reject" ? "danger" : "info";
    }
    case "negotiation.agreed":
    case "contract.created":
      return "info";
    default:
      return event.type.startsWith("human.") ? "review" : "neutral";
  }
}
