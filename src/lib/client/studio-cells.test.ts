import { describe, expect, it } from "vitest";
import { DEAL_STATUSES, DEAL_STATUS_LABEL } from "../domain/status";
import { cellKindOf, checkResultOfLabel, dealStatusOfLabel, isSimulatedRail, riskOfLabel, verificationOfLabel } from "./studio-cells";
import { toStudioDealRow } from "./studio-data";
import { opsRow } from "./studio-fixtures";

describe("studio cell helpers", () => {
  it("maps every status label back to its status", () => {
    for (const status of DEAL_STATUSES) expect(dealStatusOfLabel(DEAL_STATUS_LABEL[status])).toBe(status);
    expect(dealStatusOfLabel("Total")).toBeNull();
    expect(dealStatusOfLabel(undefined)).toBeNull();
    // Labels must be distinct, or a pill could be coloured for the wrong status.
    expect(new Set(Object.values(DEAL_STATUS_LABEL)).size).toBe(DEAL_STATUSES.length);
  });

  it("reads check results, risks and verification decisions from the labels the tables hold", () => {
    expect(["Pass", "Fail", "Uncertain", "Other"].map(checkResultOfLabel)).toEqual(["pass", "fail", "uncertain", null]);
    expect(["High", "Medium", "Low", "Extreme"].map(riskOfLabel)).toEqual(["high", "medium", "low", null]);
    expect(["Capture eligible", "Human review", "Revision required", "Rejected", "—"].map(verificationOfLabel)).toEqual([
      "capture_eligible",
      "human_review",
      "revision_required",
      "reject",
      null,
    ]);
  });

  it("agrees with the labels the data layer writes", () => {
    for (const status of DEAL_STATUSES) {
      const row = toStudioDealRow(opsRow(status), new Set());
      expect(dealStatusOfLabel(row.status)).toBe(status);
      expect(riskOfLabel(row.risk)).not.toBeNull();
      if (row.verification !== null) expect(verificationOfLabel(row.verification)).not.toBeNull();
      if (row.paymentRail !== null) expect(isSimulatedRail(row.paymentRail)).toBe(true);
    }
  });

  it("recognises a simulated rail and nothing else as simulated", () => {
    expect(isSimulatedRail("Simulated")).toBe(true);
    expect(isSimulatedRail("PayPal Sandbox")).toBe(false);
    expect(isSimulatedRail(null)).toBe(false);
  });

  it("reads a cell kind from a field context and rejects anything else", () => {
    expect(cellKindOf({ cell: "status" })).toBe("status");
    expect(cellKindOf({ cell: "deal" })).toBe("deal");
    expect(cellKindOf({ cell: "sparkline" })).toBeNull();
    expect(cellKindOf("status")).toBeNull();
    expect(cellKindOf(null)).toBeNull();
    expect(cellKindOf(undefined)).toBeNull();
  });
});
