import { describe, expect, it } from "vitest";
import { report } from "./deal-derive.fixtures";
import { buildVerdict, withEvidence, type VerdictInputRow } from "./studio-verdict";

function check(deal: string, rule: string, result: string, extra: Partial<VerdictInputRow> = {}): VerdictInputRow {
  return { deal, rule, condition: `Condition ${rule}`, result, round: 1, evaluator: "Deterministic", confidence: 1, at: "2026-10-06T01:00:00.000Z", ...extra };
}

describe("buildVerdict", () => {
  it("returns null when no check can be read", () => {
    expect(buildVerdict([])).toBeNull();
    expect(buildVerdict([{ deal: "PACT-A", condition: "x", result: "maybe" }, { deal: null, condition: "x", result: "Pass" }])).toBeNull();
  });

  it("shows the most recently verified deal", () => {
    const verdict = buildVerdict([
      check("PACT-OLD", "R1", "Pass", { at: "2026-10-05T01:00:00.000Z" }),
      check("PACT-NEW", "R1", "Pass", { at: "2026-10-06T09:00:00.000Z" }),
      check("PACT-MID", "R1", "Fail", { at: "2026-10-06T01:00:00.000Z" }),
    ]);
    expect(verdict?.dealCode).toBe("PACT-NEW");
    expect(verdict?.verifiedAtMs).toBe(Date.parse("2026-10-06T09:00:00.000Z"));
  });

  it("shows the pinned deal when it is among the rows, whatever its letter case", () => {
    const rows = [check("PACT-OLD", "R1", "Fail", { at: "2026-10-05T01:00:00.000Z" }), check("PACT-NEW", "R1", "Pass", { at: "2026-10-06T09:00:00.000Z" })];
    expect(buildVerdict(rows, " pact-old ")?.dealCode).toBe("PACT-OLD");
    // A pin that matches nothing does not blank the card.
    expect(buildVerdict(rows, "PACT-GONE")?.dealCode).toBe("PACT-NEW");
  });

  it("shows the latest round only: the delivery that counted", () => {
    const verdict = buildVerdict([
      check("PACT-A", "R1", "Pass", { round: 1 }),
      check("PACT-A", "R2", "Fail", { round: 1 }),
      check("PACT-A", "R1", "Pass", { round: 2, at: "2026-10-06T02:00:00.000Z" }),
      check("PACT-A", "R2", "Pass", { round: 2, at: "2026-10-06T02:00:00.000Z" }),
    ]);
    expect(verdict).toMatchObject({ round: 2, counts: { pass: 2, fail: 0, uncertain: 0 }, tone: "success", headline: "All 2 conditions verified" });
  });

  it("orders conditions by rule number, so R10 follows R9", () => {
    const verdict = buildVerdict([check("PACT-A", "R10", "Pass"), check("PACT-A", "R2", "Pass"), check("PACT-A", "R9", "Pass"), check("PACT-A", "R1", "Pass")]);
    expect(verdict?.checks.map((entry) => entry.rule)).toEqual(["R1", "R2", "R9", "R10"]);
  });

  it("reads results and evaluators from their labels", () => {
    const verdict = buildVerdict([
      check("PACT-A", "R1", "PASS", { evaluator: "AI", confidence: 0.91 }),
      check("PACT-A", "R2", "uncertain", { evaluator: "Deterministic", confidence: null }),
      check("PACT-A", "R3", "Fail", { evaluator: "someone" }),
    ]);
    expect(verdict?.checks.map((entry) => [entry.result, entry.evaluator, entry.confidence])).toEqual([
      ["pass", "ai", 0.91],
      ["uncertain", "deterministic", null],
      ["fail", null, 1],
    ]);
  });

  it("lets a failure outrank an uncertainty in the headline", () => {
    const failed = buildVerdict([check("PACT-A", "R1", "Fail"), check("PACT-A", "R2", "Uncertain"), check("PACT-A", "R3", "Pass")]);
    expect(failed).toMatchObject({ tone: "danger", headline: "1 condition failed of 3" });
    expect(failed?.consequence).toMatch(/^Not captured/);
    const unsure = buildVerdict([check("PACT-A", "R1", "Uncertain"), check("PACT-A", "R2", "Uncertain"), check("PACT-A", "R3", "Pass")]);
    expect(unsure).toMatchObject({ tone: "review", headline: "2 conditions uncertain of 3" });
    expect(unsure?.consequence).toMatch(/human decides/);
  });

  it("works with only the three required slots mapped", () => {
    const verdict = buildVerdict([{ deal: "PACT-A", condition: "3 illustrations delivered", result: "Pass" }]);
    expect(verdict).toMatchObject({ dealCode: "PACT-A", round: 1, verifiedAtMs: null, summary: null, degraded: false });
    expect(verdict?.checks[0]).toMatchObject({ rule: null, evaluator: null, confidence: null, evidence: null });
  });
});

describe("withEvidence", () => {
  const rows = ["R1", "R2", "R3", "R4", "R5", "R6"].map((rule) => check("PACT-A", rule, rule === "R2" ? "Fail" : "Pass"));

  it("adds what the verifier observed, and takes the engine's decision over the counts", () => {
    const base = buildVerdict(rows)!;
    const merged = withEvidence(base, [report(1, "revision_required")]);
    expect(merged.checks.find((entry) => entry.rule === "R2")).toMatchObject({ evidence: "1:1 missing on illustration #2", explanation: "Explanation." });
    expect(merged.summary).toBe("1 condition failed: 1:1 missing on illustration #2.");
    expect(merged.tone).toBe("danger");
    expect(merged.consequence).toMatch(/sent back to the seller for a revision/);
    // The input is not modified.
    expect(base.checks.every((entry) => entry.evidence === null)).toBe(true);
  });

  it("follows the report when confidence, not a failed rule, sent the deal to a human", () => {
    const allPass = buildVerdict(rows.map((entry) => ({ ...entry, result: "Pass" })))!;
    expect(allPass.tone).toBe("success");
    const merged = withEvidence(allPass, [{ ...report(1, "human_review"), degraded: true }]);
    expect(merged.tone).toBe("review");
    expect(merged.degraded).toBe(true);
  });

  it("leaves the model alone when the shown round has no report", () => {
    const base = buildVerdict(rows.map((entry) => ({ ...entry, round: 2 })))!;
    expect(withEvidence(base, [report(1, "reject")])).toBe(base);
    expect(withEvidence(base, [])).toBe(base);
  });
});
