import { describe, expect, it } from "vitest";
import type { DealGraph, DealRow } from "../db";
import { buildAuditEvent } from "../domain/audit";
import type { Artifact, AuditEvent, AuditEventInput, NegotiationMove } from "../domain/schemas";
import { SCENARIO_MANDATES, signedContractFor } from "../domain/test-support";
import { newPaymentRecord } from "../payments/orchestrator";
import type { PaymentRecord } from "../payments/types";
import { buildDealView, toArtifactFile, toDealSummary } from "./deal-view";
import { SYSTEM_OWNER } from "./session";

const NOW = new Date("2026-10-06T05:00:00.000Z");
const OWNER = "sess_ownerownerownerownerown1";
const STRANGER = "sess_strangerstrangerstranger";
const DEAL_ID = "deal_test00000001";

function dealRow(overrides: Partial<DealRow> = {}): DealRow {
  return {
    id: DEAL_ID,
    code: "PACT-7KQ2",
    owner: OWNER,
    scenarioId: "happy-path",
    status: "negotiating",
    intent: "Get three landing-page illustrations for under $50 by tomorrow at 6 PM.",
    mandate: SCENARIO_MANDATES["happy-path"].mandate,
    category: "illustration",
    sellerId: "northwind",
    negotiationStatus: "open",
    agreedTerms: null,
    negotiationFailure: null,
    policyEvaluation: null,
    humanDecision: null,
    priceMinor: null,
    deadline: null,
    revisionLimit: null,
    revisionsUsed: 0,
    aiDegraded: false,
    lastError: null,
    version: 3,
    lockId: "step_some-lease",
    lockedUntil: "2026-10-06T05:02:00.000Z",
    createdAt: "2026-10-06T04:59:00.000Z",
    updatedAt: "2026-10-06T05:00:00.000Z",
    ...overrides,
  };
}

function graphOf(overrides: Partial<DealGraph> = {}): DealGraph {
  return { deal: dealRow(), moves: [], signed: null, payment: null, submissions: [], reports: [], audit: [], ...overrides };
}

function move(seq: number, actor: NegotiationMove["actor"], priceMinor: number | null): NegotiationMove {
  return {
    seq,
    actor,
    action: priceMinor === null ? "reject" : seq <= 2 ? "offer" : "counter",
    terms: priceMinor === null ? null : { priceMinor, deadline: "2026-10-07T09:00:00.000Z", revisionLimit: 1, count: 3 },
    message: `Move ${seq}`,
    guardrails: [],
    source: "scripted",
    model: null,
    latencyMs: null,
    createdAt: NOW.toISOString(),
  };
}

function payment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return { ...newPaymentRecord("simulated", "interactive", 4700, NOW), ...overrides };
}

function chain(inputs: AuditEventInput[]): AuditEvent[] {
  const events: AuditEvent[] = [];
  for (const [index, input] of inputs.entries()) {
    events.push(buildAuditEvent(events[index - 1] ?? null, DEAL_ID, input, { id: `evt_${index.toString().padStart(12, "0")}`, now: NOW }));
  }
  return events;
}

describe("buildDealView", () => {
  it("maps the stored deal without leaking anything that is not for the browser", () => {
    const view = buildDealView(graphOf(), OWNER, NOW);
    expect(view).toMatchObject({
      id: DEAL_ID,
      code: "PACT-7KQ2",
      status: "negotiating",
      statusLabel: "Negotiating",
      scenarioId: "happy-path",
      isOwner: true,
      seller: { id: "northwind", name: "Northwind Studio", trust: "established", demoFault: null },
      contract: null,
      policy: null,
      payment: null,
      revisions: { used: 0, limit: 0 },
      lastError: null,
    });
    const serialised = JSON.stringify(view);
    // No session id, no lease, no version, no seller rate card or floor.
    for (const secret of [OWNER, "step_some-lease", "lockedUntil", "rateCard", "floorFactor", "version"]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it("shows the private mandate to the owner and on showcase deals only", () => {
    const graph = graphOf();
    expect(buildDealView(graph, OWNER, NOW)).toMatchObject({ isOwner: true, mandate: { budgetMinor: 5000 } });
    expect(buildDealView(graph, STRANGER, NOW)).toMatchObject({ isOwner: false, mandate: null });
    expect(buildDealView(graph, null, NOW)).toMatchObject({ isOwner: false, mandate: null });

    const showcase = graphOf({ deal: dealRow({ owner: SYSTEM_OWNER }) });
    expect(buildDealView(showcase, STRANGER, NOW)).toMatchObject({ isOwner: false, mandate: { budgetMinor: 5000 } });
    expect(buildDealView(showcase, null, NOW).mandate).not.toBeNull();
    // Only the seed script, acting as the system owner, "owns" a showcase deal.
    expect(buildDealView(showcase, SYSTEM_OWNER, NOW).isOwner).toBe(true);
  });

  it("takes the list price from the seller's first offer", () => {
    expect(buildDealView(graphOf(), OWNER, NOW).negotiation).toMatchObject({ moves: [], listPriceMinor: null, maxMoves: 8, status: "open" });
    const moves = [move(1, "seller", 5300), move(2, "buyer", 4200), move(3, "seller", 4900)];
    expect(buildDealView(graphOf({ moves }), OWNER, NOW).negotiation.listPriceMinor).toBe(5300);
    // A seller that walks away at once never quoted.
    expect(buildDealView(graphOf({ moves: [move(1, "seller", null)] }), OWNER, NOW).negotiation.listPriceMinor).toBeNull();
  });

  it("says whose move is next while negotiating, and what is next otherwise", () => {
    expect(buildDealView(graphOf(), OWNER, NOW).next).toEqual({ kind: "auto", step: "negotiate", label: "Seller agent is preparing its offer" });
    expect(buildDealView(graphOf({ moves: [move(1, "seller", 5300)] }), OWNER, NOW).next).toMatchObject({ label: "Buyer agent is responding" });

    const review = graphOf({ deal: dealRow({ status: "in_review", revisionLimit: 1, revisionsUsed: 0 }) });
    expect(buildDealView(review, OWNER, NOW).next).toMatchObject({
      kind: "human",
      gate: "review",
      options: ["release_payment", "release_partial", "request_revision", "reject_delivery"],
    });
    const exhausted = graphOf({ deal: dealRow({ status: "in_review", revisionLimit: 1, revisionsUsed: 1 }) });
    expect(buildDealView(exhausted, OWNER, NOW)).toMatchObject({
      revisions: { used: 1, limit: 1 },
      next: { options: ["release_payment", "release_partial", "reject_delivery"] },
    });
    expect(buildDealView(graphOf({ deal: dealRow({ status: "completed" }) }), OWNER, NOW).next).toEqual({ kind: "done", label: "Completed · captured" });
  });

  it("attaches the live payment state to the contract without touching the hashed document", () => {
    const signed = signedContractFor("happy-path", { dealId: DEAL_ID });
    const unpaid = buildDealView(graphOf({ signed }), OWNER, NOW);
    expect(unpaid.contract).toEqual({ ...signed, paymentState: "none" });

    const held = buildDealView(graphOf({ signed, payment: payment({ status: "authorized", authorizedMinor: 4700 }) }), OWNER, NOW);
    expect(held.contract?.paymentState).toBe("authorized");
    expect(held.contract?.termsHash).toBe(signed.termsHash);
    expect(held.payment).toMatchObject({ status: "authorized", authorizedMinor: 4700 });
    expect(signed).not.toHaveProperty("paymentState");
  });

  it("labels simulated payments from the record, and from the active provider before one exists", () => {
    const simulated = (view: ReturnType<typeof buildDealView>): boolean => view.flags.simulatedPayment;
    expect(simulated(buildDealView(graphOf(), OWNER, NOW))).toBe(false);
    expect(simulated(buildDealView(graphOf(), OWNER, NOW, { providerKind: "simulated" }))).toBe(true);
    expect(simulated(buildDealView(graphOf(), OWNER, NOW, { providerKind: "paypal_sandbox" }))).toBe(false);
    // Once a payment exists, the record decides — whatever provider is active now.
    const real = graphOf({ payment: payment({ provider: "paypal_sandbox" }) });
    expect(simulated(buildDealView(real, OWNER, NOW, { providerKind: "simulated" }))).toBe(false);
    const fake = graphOf({ payment: payment({ provider: "simulated" }) });
    expect(simulated(buildDealView(fake, OWNER, NOW, { providerKind: "paypal_sandbox" }))).toBe(true);
  });

  it("re-verifies the audit chain on every read", () => {
    const audit = chain([
      { actor: "human", type: "intent.received", title: "Request received" },
      { actor: "system", type: "seller.matched", title: "Matched with Northwind Studio" },
      { actor: "system", type: "negotiation.agreed", title: "Terms agreed at $47.00" },
    ]);
    expect(buildDealView(graphOf({ audit }), OWNER, NOW).flags.auditChainValid).toBe(true);
    expect(buildDealView(graphOf(), OWNER, NOW).flags.auditChainValid).toBe(true);

    const edited = audit.map((event) => (event.seq === 3 ? { ...event, title: "Terms agreed at $4.70" } : event));
    expect(buildDealView(graphOf({ audit: edited }), OWNER, NOW).flags.auditChainValid).toBe(false);
    expect(buildDealView(graphOf({ audit: [audit[0], audit[2]] }), OWNER, NOW).flags.auditChainValid).toBe(false);
  });

  it("carries the degraded flag, the last error and a seller's demo-fault label", () => {
    const graph = graphOf({ deal: dealRow({ aiDegraded: true, lastError: "Nothing changed — retry the step.", sellerId: "pixelharbor" }) });
    const view = buildDealView(graph, OWNER, NOW);
    expect(view.flags.aiDegraded).toBe(true);
    expect(view.lastError).toBe("Nothing changed — retry the step.");
    expect(view.seller).toMatchObject({ id: "pixelharbor", trust: "new", demoFault: "embeds_instructions" });
    expect(buildDealView(graphOf({ deal: dealRow({ sellerId: null }) }), OWNER, NOW).seller).toBeNull();
    expect(buildDealView(graphOf({ deal: dealRow({ sellerId: "gone" }) }), OWNER, NOW).seller).toBeNull();
  });

  it("is pure: the same graph gives the same view at any time, and the graph is not modified", () => {
    const graph = graphOf({ moves: [move(1, "seller", 5300)], payment: payment() });
    const snapshot = structuredClone(graph);
    const first = buildDealView(graph, OWNER, NOW);
    const later = buildDealView(graph, OWNER, new Date(NOW.getTime() + 40 * 24 * 60 * 60 * 1000));
    expect(later).toEqual(first);
    expect(graph).toEqual(snapshot);
  });
});

describe("toDealSummary", () => {
  it("uses the buyer agent's one-line restatement as the title", () => {
    expect(toDealSummary(dealRow({ status: "completed", priceMinor: 4700 }))).toEqual({
      id: DEAL_ID,
      code: "PACT-7KQ2",
      title: "Three landing-page illustrations in 16:9 and 1:1",
      status: "completed",
      statusLabel: "Completed · captured",
      scenarioId: "happy-path",
      sellerName: "Northwind Studio",
      priceMinor: 4700,
      createdAt: "2026-10-06T04:59:00.000Z",
      updatedAt: "2026-10-06T05:00:00.000Z",
    });
  });

  it("falls back to the request itself, on one bounded line", () => {
    const summary = toDealSummary(dealRow({ mandate: null, sellerId: null, intent: `Write\n${"a very long request ".repeat(20)}` }));
    expect(summary.title.length).toBeLessThanOrEqual(90);
    expect(summary.title.startsWith("Write a very long request")).toBe(true);
    expect(summary.title).not.toContain("\n");
    expect(summary.sellerName).toBeNull();
  });
});

describe("toArtifactFile", () => {
  const illustration: Artifact = {
    id: "art_000000000001",
    kind: "illustration",
    index: 2,
    title: "Hero",
    aspectRatio: "16:9",
    width: 1600,
    height: 900,
    format: "svg",
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"></svg>',
    description: "A hero image",
  };
  const copy: Artifact = { id: "art_000000000002", kind: "copy", index: 1, title: "Espresso", language: "ja", text: "Sample text." };

  it("serves an illustration as SVG and copy as UTF-8 text, byte for byte", () => {
    expect(toArtifactFile("PACT-7KQ2", illustration)).toEqual({
      filename: "PACT-7KQ2-illustration-2-16x9.svg",
      contentType: "image/svg+xml",
      body: illustration.svg,
    });
    expect(toArtifactFile("PACT-7KQ2", copy)).toEqual({
      filename: "PACT-7KQ2-copy-1-ja.txt",
      contentType: "text/plain; charset=utf-8",
      body: "Sample text.",
    });
  });

  it("builds the filename from a fixed alphabet, whatever the seller claims", () => {
    const hostile = [
      toArtifactFile("PACT-7KQ2", { ...illustration, aspectRatio: '1:1"\r\nX: y' }),
      toArtifactFile("PACT-7KQ2", { ...copy, language: "../../e" }),
      toArtifactFile('";evil="', { ...copy, language: "" }),
      toArtifactFile("...", { ...illustration, aspectRatio: "" }),
    ];
    for (const file of hostile) {
      expect(file.filename).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*\.(svg|txt)$/);
      expect(file.filename.length).toBeLessThanOrEqual(84);
    }
  });
});
