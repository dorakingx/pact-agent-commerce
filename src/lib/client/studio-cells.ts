/**
 * How the table widgets recognise PACT's vocabulary. A field in the data model carries a `cell`
 * kind in its `context`; the dashboard's cell renderers use it to draw a status as a pill or a
 * deal code as a link. Tables only hold the display label, so the helpers here map a label back
 * to the value it stands for.
 */
import type { CheckResult, VerificationDecision } from "../domain/schemas";
import { DEAL_STATUS_LABEL, DEAL_STATUSES, type DealStatus } from "../domain/status";
import { providerLabel } from "./ops-derive";

export type CellKind = "deal" | "status" | "risk" | "result" | "verification" | "rail" | "evaluator";

export interface CellContext {
  cell: CellKind;
}

export function cellKindOf(context: unknown): CellKind | null {
  if (typeof context !== "object" || context === null) return null;
  const kind = (context as { cell?: unknown }).cell;
  return kind === "deal" || kind === "status" || kind === "risk" || kind === "result" || kind === "verification" || kind === "rail" || kind === "evaluator"
    ? kind
    : null;
}

const STATUS_BY_LABEL: ReadonlyMap<string, DealStatus> = new Map(DEAL_STATUSES.map((status) => [DEAL_STATUS_LABEL[status], status]));

/** The lifecycle status a label names, or null for anything that is not a status label. */
export function dealStatusOfLabel(label: unknown): DealStatus | null {
  return typeof label === "string" ? (STATUS_BY_LABEL.get(label) ?? null) : null;
}

export function checkResultOfLabel(label: unknown): CheckResult | null {
  const text = typeof label === "string" ? label.toLowerCase() : "";
  return text === "pass" || text === "fail" || text === "uncertain" ? text : null;
}

const DECISION_BY_LABEL: Readonly<Record<string, VerificationDecision>> = {
  "capture eligible": "capture_eligible",
  "human review": "human_review",
  "revision required": "revision_required",
  rejected: "reject",
};

export function verificationOfLabel(label: unknown): VerificationDecision | null {
  return typeof label === "string" ? (DECISION_BY_LABEL[label.toLowerCase()] ?? null) : null;
}

export type RiskKey = "low" | "medium" | "high";

export function riskOfLabel(label: unknown): RiskKey | null {
  const text = typeof label === "string" ? label.toLowerCase() : "";
  return text === "low" || text === "medium" || text === "high" ? text : null;
}

/** True when the label says the payment never touched PayPal. */
export function isSimulatedRail(label: unknown): boolean {
  return label === providerLabel("simulated");
}
