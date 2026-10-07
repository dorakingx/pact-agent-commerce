/**
 * Tones for the two ledger dimensions the shared status maps do not cover. Amber stays reserved
 * for "funds held", so a medium risk and a near deadline use violet: "a human should look".
 */
import type { StatusTone } from "@/components/ui/tone";
import type { RiskLevel } from "@/lib/api/dto";
import type { DeadlineUrgency, OpsOutcome } from "@/lib/client/ops-derive";

export const OUTCOME_TONE: Record<OpsOutcome, StatusTone> = {
  in_progress: "info",
  captured: "success",
  voided: "neutral",
  declined: "neutral",
  blocked: "danger",
  no_agreement: "neutral",
  failed: "danger",
};

export const RISK_TONE: Record<RiskLevel, StatusTone> = {
  high: "danger",
  medium: "review",
  low: "neutral",
};

export const DEADLINE_TONE: Record<Exclude<DeadlineUrgency, "none">, StatusTone> = {
  soon: "review",
  overdue: "danger",
};
