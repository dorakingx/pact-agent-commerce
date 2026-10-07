/**
 * View model of the "Verdict card" widget: every contract condition of one verified delivery,
 * with its result, who evaluated it, how confident the evaluator was and what it observed.
 *
 * Two sources meet here. Studio's query over the checks table decides WHICH deal is shown (the
 * pinned one, or the most recently verified under the active filters) and supplies the results.
 * The evidence sentences are not in that table, so the card reads them from the deal itself
 * (GET /api/deals/{id}) and `withEvidence` merges them in. The card is complete without them.
 */
import type { CheckResult, VerificationDecision, VerificationReport } from "../domain/schemas";
import { toEpochMs } from "./studio-review";

export interface VerdictInputRow {
  deal: unknown;
  condition: unknown;
  result: unknown;
  round?: unknown;
  rule?: unknown;
  evaluator?: unknown;
  confidence?: unknown;
  at?: unknown;
}

export interface VerdictCheck {
  rule: string | null;
  condition: string;
  result: CheckResult;
  evaluator: "deterministic" | "ai" | null;
  /** 0–1, or null when no confidence field is mapped. */
  confidence: number | null;
  evidence: string | null;
  explanation: string | null;
}

export type VerdictTone = "success" | "review" | "danger";

export interface VerdictModel {
  dealCode: string;
  round: number;
  verifiedAtMs: number | null;
  checks: VerdictCheck[];
  counts: Record<CheckResult, number>;
  tone: VerdictTone;
  /** The decision in a few words: "All 6 conditions verified". */
  headline: string;
  /** What the decision means for the money. */
  consequence: string;
  /** The verifier's own one-line summary, once the report has been read. */
  summary: string | null;
  /** True when the AI verifier was unavailable and its rules were marked uncertain. */
  degraded: boolean;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resultOf(value: unknown): CheckResult | null {
  const text = textOf(value)?.toLowerCase();
  return text === "pass" || text === "fail" || text === "uncertain" ? text : null;
}

function evaluatorOf(value: unknown): VerdictCheck["evaluator"] {
  const text = textOf(value)?.toLowerCase();
  if (text === "ai") return "ai";
  return text === "deterministic" ? "deterministic" : null;
}

function roundOf(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 1;
}

/** "R2" → 2, so R10 sorts after R9. Rules without a number keep their arrival order at the end. */
function ruleOrder(rule: string | null): number {
  const match = rule === null ? null : /\d+/.exec(rule);
  return match === null ? Number.MAX_SAFE_INTEGER : Number(match[0]);
}

const CONSEQUENCE: Record<VerdictTone, string> = {
  success: "Eligible for capture: the authorization can be captured.",
  review: "Not captured automatically: a human decides while the funds stay held.",
  danger: "Not captured: the delivery goes back for revision or the hold is released.",
};

function verdictOf(counts: Record<CheckResult, number>): Pick<VerdictModel, "tone" | "headline" | "consequence"> {
  const total = counts.pass + counts.fail + counts.uncertain;
  const conditions = (n: number): string => `${n} ${n === 1 ? "condition" : "conditions"}`;
  if (counts.fail > 0) {
    return { tone: "danger", headline: `${conditions(counts.fail)} failed of ${total}`, consequence: CONSEQUENCE.danger };
  }
  if (counts.uncertain > 0) {
    return { tone: "review", headline: `${conditions(counts.uncertain)} uncertain of ${total}`, consequence: CONSEQUENCE.review };
  }
  return { tone: "success", headline: `All ${conditions(total)} verified`, consequence: CONSEQUENCE.success };
}

/**
 * Pick the deal and the round, and shape its checks. `pinnedCode` (from the widget's form) wins
 * when it matches a deal in the rows; otherwise the most recently verified deal is shown, and
 * within it the latest round — the delivery that actually counted.
 */
export function buildVerdict(rows: readonly VerdictInputRow[], pinnedCode = ""): VerdictModel | null {
  const usable = rows.flatMap((row) => {
    const deal = textOf(row.deal);
    const condition = textOf(row.condition);
    const result = resultOf(row.result);
    return deal === null || condition === null || result === null ? [] : [{ row, deal, condition, result, atMs: toEpochMs(row.at) }];
  });
  if (usable.length === 0) return null;

  const wanted = pinnedCode.trim().toLowerCase();
  const pinned = wanted.length === 0 ? undefined : usable.find((entry) => entry.deal.toLowerCase() === wanted);
  const latest = usable.reduce((best, entry) => ((entry.atMs ?? -1) > (best.atMs ?? -1) ? entry : best));
  const dealCode = (pinned ?? latest).deal;

  const ofDeal = usable.filter((entry) => entry.deal === dealCode);
  const round = Math.max(...ofDeal.map((entry) => roundOf(entry.row.round)));
  const ofRound = ofDeal.filter((entry) => roundOf(entry.row.round) === round);

  const checks = ofRound
    .map((entry, index) => ({
      index,
      check: {
        rule: textOf(entry.row.rule),
        condition: entry.condition,
        result: entry.result,
        evaluator: evaluatorOf(entry.row.evaluator),
        confidence: typeof entry.row.confidence === "number" && Number.isFinite(entry.row.confidence) ? entry.row.confidence : null,
        evidence: null,
        explanation: null,
      } satisfies VerdictCheck,
    }))
    .sort((a, b) => ruleOrder(a.check.rule) - ruleOrder(b.check.rule) || a.index - b.index)
    .map((entry) => entry.check);

  const counts: Record<CheckResult, number> = { pass: 0, fail: 0, uncertain: 0 };
  for (const check of checks) counts[check.result] += 1;
  const times = ofRound.map((entry) => entry.atMs).filter((ms): ms is number => ms !== null);
  return {
    dealCode,
    round,
    verifiedAtMs: times.length === 0 ? null : Math.max(...times),
    checks,
    counts,
    ...verdictOf(counts),
    summary: null,
    degraded: false,
  };
}

const DECISION_TONE: Record<VerificationDecision, VerdictTone> = {
  capture_eligible: "success",
  human_review: "review",
  revision_required: "danger",
  reject: "danger",
};

const DECISION_CONSEQUENCE: Record<VerificationDecision, string> = {
  capture_eligible: CONSEQUENCE.success,
  human_review: CONSEQUENCE.review,
  revision_required: "Not captured: sent back to the seller for a revision. The funds stay held.",
  reject: "Not captured: no revisions remain, so the authorization is voided.",
};

/**
 * Merge the verifier's report for the shown round into the model: evidence and explanation per
 * rule, the report's summary, and the engine's actual decision (which also weighs confidence
 * against the policy thresholds, something the counts alone cannot know).
 */
export function withEvidence(model: VerdictModel, reports: readonly VerificationReport[]): VerdictModel {
  const report = reports.find((candidate) => candidate.round === model.round);
  if (report === undefined) return model;
  const byRule = new Map(report.checks.map((check) => [check.ruleId, check]));
  return {
    ...model,
    checks: model.checks.map((check) => {
      const source = check.rule === null ? undefined : byRule.get(check.rule);
      return source === undefined ? check : { ...check, evidence: source.evidence, explanation: source.explanation };
    }),
    tone: DECISION_TONE[report.decision],
    consequence: DECISION_CONSEQUENCE[report.decision],
    summary: report.summary.trim().length > 0 ? report.summary : null,
    degraded: report.degraded,
  };
}
