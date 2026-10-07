import { describe, expect, it } from "vitest";
import { AUDIT_ACTORS, AUDIT_EVENT_TYPES } from "@/lib/domain/schemas";
import { auditActorLabel, auditEventTone, auditFacts, auditHeadHash, auditTitle } from "./deal-derive-audit";
import { auditEvent } from "./deal-derive.fixtures";

describe("auditActorLabel", () => {
  const owner = { isOwner: true, simulatedPayment: false };

  it("has a label for every actor", () => {
    for (const actor of AUDIT_ACTORS) expect(auditActorLabel(actor, owner)).not.toBe("");
  });
  it("calls the human 'You' only for the owner", () => {
    expect(auditActorLabel("human", owner)).toBe("You");
    expect(auditActorLabel("human", { isOwner: false, simulatedPayment: false })).toBe("Deal owner");
  });
  it("never passes a simulated provider off as PayPal", () => {
    expect(auditActorLabel("paypal", owner)).toBe("PayPal");
    expect(auditActorLabel("paypal", { isOwner: true, simulatedPayment: true })).toBe("PayPal (simulated)");
  });
});

describe("auditTitle", () => {
  it("keeps the engine's wording for the owner", () => {
    const event = { actor: "human" as const, title: "You approved this spend" };
    expect(auditTitle(event, { isOwner: true })).toBe("You approved this spend");
  });
  it("does not tell a visitor that they acted", () => {
    expect(auditTitle({ actor: "human", title: "You rejected the delivery — the hold will be released" }, { isOwner: false })).toBe(
      "The deal's owner rejected the delivery — the hold will be released",
    );
  });
  it("leaves other actors and other sentences alone", () => {
    expect(auditTitle({ actor: "system", title: "You are here" }, { isOwner: false })).toBe("You are here");
    expect(auditTitle({ actor: "human", title: "Request received" }, { isOwner: false })).toBe("Request received");
    expect(auditTitle({ actor: "human", title: "Your request was received" }, { isOwner: false })).toBe("Your request was received");
  });
});

describe("auditFacts", () => {
  it("is empty without data", () => {
    expect(auditFacts(null)).toEqual([]);
    expect(auditFacts({})).toEqual([]);
  });

  it("formats money from minor units and drops the suffix from the label", () => {
    expect(auditFacts({ amountMinor: 2800, spentTodayMinor: 0 })).toEqual([
      { key: "amountMinor", label: "Amount", value: "$28.00", kind: "money" },
      { key: "spentTodayMinor", label: "Spent today", value: "$0.00", kind: "money" },
    ]);
  });

  it("treats ids, hashes and keys as copyable identifiers, with PayPal's own field names", () => {
    const facts = auditFacts({
      orderId: "SIM-O-59E4991AB5B4FA03",
      customId: "pact:v1:18a8ced6",
      termsHash: "18a8ced61cbdb77a",
      idempotencyKey: "796047d1-84e8-89d6-8781-0067b15d0109",
    });
    expect(facts.map((fact) => [fact.label, fact.kind])).toEqual([
      ["Order ID", "id"],
      ["PayPal custom_id", "id"],
      ["Terms hash", "id"],
      ["Idempotency key", "id"],
    ]);
  });

  it("shows names, not identifiers, for the seller and the scenario", () => {
    expect(auditFacts({ sellerId: "quickdraw", scenarioId: "revision" }).map((fact) => fact.kind)).toEqual(["text", "text"]);
  });

  it("recognises timestamps, booleans, numbers and lists", () => {
    expect(
      auditFacts({
        expiresAt: "2026-11-03T21:51:35.951Z",
        pinnedByScenario: true,
        idempotentReplay: false,
        moves: 7,
        failedRuleIds: ["R2", "R6"],
        flagged: [],
      }),
    ).toEqual([
      { key: "expiresAt", label: "Expires at", value: "2026-11-03T21:51:35.951Z", kind: "time" },
      { key: "pinnedByScenario", label: "Pinned by scenario", value: "Yes", kind: "text" },
      { key: "idempotentReplay", label: "Idempotent replay", value: "No", kind: "text" },
      { key: "moves", label: "Moves", value: "7", kind: "text" },
      { key: "failedRuleIds", label: "Failed rules", value: "R2, R6", kind: "text" },
      { key: "flagged", label: "Flagged", value: "None", kind: "text" },
    ]);
  });

  it("skips empty values and keeps the engine's order", () => {
    expect(auditFacts({ captureId: null, note: "", reason: "rate_limited", step: "verify" }).map((fact) => fact.key)).toEqual(["reason", "step"]);
  });

  it("never formats a non-integer as money", () => {
    expect(auditFacts({ confidenceMinor: 0.95 })).toEqual([{ key: "confidenceMinor", label: "Confidence", value: "0.95", kind: "text" }]);
  });

  it("shows a nested value compactly and bounded", () => {
    const [short] = auditFacts({ detail: { a: 1 } });
    expect(short).toMatchObject({ value: '{"a":1}', kind: "text" });
    const [long] = auditFacts({ detail: { text: "x".repeat(500) } });
    expect(long.value.length).toBeLessThanOrEqual(160);
    expect(long.value.endsWith("…")).toBe(true);
  });
});

describe("auditEventTone", () => {
  it("has a tone for every event type", () => {
    for (const type of AUDIT_EVENT_TYPES) {
      expect(["neutral", "info", "hold", "success", "review", "danger"]).toContain(auditEventTone({ type, data: null }));
    }
  });
  it("follows the money: amber for a hold, emerald for a capture, slate for a void", () => {
    expect(auditEventTone({ type: "payment.authorized", data: null })).toBe("hold");
    expect(auditEventTone({ type: "payment.captured", data: null })).toBe("success");
    expect(auditEventTone({ type: "payment.voided", data: null })).toBe("neutral");
    expect(auditEventTone({ type: "payment.failed", data: null })).toBe("danger");
  });
  it("is violet wherever a human acts or is asked to", () => {
    expect(auditEventTone({ type: "human.approved_spend", data: null })).toBe("review");
    expect(auditEventTone({ type: "policy.approval_requested", data: null })).toBe("review");
    expect(auditEventTone({ type: "verification.review_requested", data: null })).toBe("review");
  });
  it("colours a verification by its decision", () => {
    expect(auditEventTone({ type: "verification.completed", data: { decision: "capture_eligible" } })).toBe("success");
    expect(auditEventTone({ type: "verification.completed", data: { decision: "revision_required" } })).toBe("danger");
    expect(auditEventTone({ type: "verification.completed", data: { decision: "reject" } })).toBe("danger");
    expect(auditEventTone({ type: "verification.completed", data: { decision: "human_review" } })).toBe("review");
    expect(auditEventTone({ type: "verification.completed", data: null })).toBe("info");
  });
});

describe("auditHeadHash", () => {
  it("is the hash of the newest entry", () => {
    expect(auditHeadHash([])).toBeNull();
    expect(auditHeadHash([auditEvent(1, "intent.received"), auditEvent(2, "mandate.derived", { hash: "f".repeat(64) })])).toBe("f".repeat(64));
  });
});
