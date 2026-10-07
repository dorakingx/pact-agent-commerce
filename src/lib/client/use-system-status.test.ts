import { describe, expect, it } from "vitest";
import type { SystemStatus } from "../api/dto";
import { describeSystemStatus, type SystemStatusRow } from "./use-system-status";

function status(overrides: { payments?: Partial<SystemStatus["payments"]>; ai?: Partial<SystemStatus["ai"]> } & Partial<Omit<SystemStatus, "payments" | "ai">> = {}): SystemStatus {
  const { payments, ai, ...rest } = overrides;
  return {
    payments: { provider: "paypal_sandbox", configured: true, webhooks: true, delegatedWallet: true, ...payments },
    ai: {
      mode: "ai",
      buyerModel: "google/gemini-2.5-flash",
      sellerModel: "openai/gpt-5-mini",
      verifierModel: "google/gemini-2.5-flash",
      ...ai,
    },
    database: "postgres",
    version: "0.1.0",
    ...rest,
  };
}

function row(view: { rows: SystemStatusRow[] }, id: string): SystemStatusRow {
  const found = view.rows.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found;
}

describe("describeSystemStatus", () => {
  it("reports a fully live deployment as healthy", () => {
    const view = describeSystemStatus(status());
    expect(view.provider).toBe("paypal_sandbox");
    expect(view.ai).toBe("ai");
    expect(view.problems).toEqual([]);
    expect(row(view, "payment-rail")).toMatchObject({ value: "PayPal Sandbox · live", tone: "success" });
    expect(row(view, "webhooks")).toMatchObject({ value: "Signatures verified", tone: "success" });
    expect(row(view, "demo-wallet")).toMatchObject({ value: "Connected", tone: "success" });
    expect(row(view, "database")).toMatchObject({ value: "Postgres", tone: "neutral" });
    expect(row(view, "version")).toMatchObject({ value: "v0.1.0", mono: true });
  });

  it("lists the three agent models by their exact ids", () => {
    const view = describeSystemStatus(status());
    expect(view.rows.filter((r) => r.group === "agents").map((r) => [r.label, r.value, r.mono])).toEqual([
      ["Buyer agent", "google/gemini-2.5-flash", true],
      ["Seller agent", "openai/gpt-5-mini", true],
      ["Verifier", "google/gemini-2.5-flash", true],
    ]);
  });

  it("replaces the model rows with one honest line when agents are scripted", () => {
    const view = describeSystemStatus(status({ ai: { mode: "scripted" } }));
    const agents = view.rows.filter((r) => r.group === "agents");
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ value: "Scripted agents", tone: "hold" });
    expect(agents[0]?.detail).toContain("No model calls are made");
    expect(view.ai).toBe("scripted");
  });

  it("says why payments are simulated: no credentials", () => {
    const view = describeSystemStatus(status({ payments: { provider: "simulated", configured: false, webhooks: false, delegatedWallet: false } }));
    expect(row(view, "payment-rail")).toMatchObject({ value: "Simulated", tone: "hold" });
    expect(row(view, "payment-rail").detail).toContain("No PayPal credentials are configured");
    expect(row(view, "webhooks")).toMatchObject({ value: "Not used", tone: "neutral" });
    expect(row(view, "demo-wallet")).toMatchObject({ value: "Not connected", tone: "neutral" });
    expect(view.problems).toEqual([]);
  });

  it("says why payments are simulated: forced although credentials exist", () => {
    const view = describeSystemStatus(status({ payments: { provider: "simulated", configured: true } }));
    expect(row(view, "payment-rail").detail).toContain("set to use the in-process simulator");
  });

  it("warns when live PayPal runs without webhook verification", () => {
    const view = describeSystemStatus(status({ payments: { webhooks: false } }));
    expect(row(view, "webhooks")).toMatchObject({ value: "Not configured", tone: "hold" });
  });

  it("surfaces an unreachable database on every row that depends on it", () => {
    const view = describeSystemStatus(status({ database: "pglite", degraded: ["database"], payments: { delegatedWallet: false } }));
    expect(view.problems).toHaveLength(1);
    expect(view.problems[0]).toContain("database is not answering");
    expect(row(view, "database")).toMatchObject({ value: "PGlite (in-process Postgres) · unreachable", tone: "danger" });
    // "Not connected" would be a guess: the wallet could not be looked up.
    expect(row(view, "demo-wallet")).toMatchObject({ value: "Unknown", tone: "danger" });
  });

  it("does not call a misconfigured PayPal setup live", () => {
    const view = describeSystemStatus(status({ degraded: ["payments"], payments: { configured: false, webhooks: false } }));
    expect(row(view, "payment-rail")).toMatchObject({ value: "Misconfigured", tone: "danger" });
    expect(view.problems).toEqual(["The PayPal configuration is invalid. No payment can be started."]);
  });

  it("reports both problems when both components are degraded", () => {
    expect(describeSystemStatus(status({ degraded: ["database", "payments"] })).problems).toHaveLength(2);
  });

  it("gives every row a unique id", () => {
    const ids = describeSystemStatus(status()).rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
