import { describe, expect, it } from "vitest";
import { GENESIS_HASH, buildAuditEvent, verifyAuditChain } from "./audit";
import { canonicalJson, sha256Hex } from "./canonical";
import { AuditEventSchema, type AuditEvent, type AuditEventInput } from "./schemas";

const DEAL = "deal_abc123def456";
const T0 = Date.parse("2026-10-06T09:00:00.000Z");

const INPUTS: AuditEventInput[] = [
  { actor: "human", type: "intent.received", title: "Request received", detail: "Three landing-page illustrations for under $50." },
  { actor: "seller_agent", type: "negotiation.move", title: "Seller offered $53.00", data: { seq: 1, priceMinor: 5300 } },
  { actor: "contract_engine", type: "contract.created", title: "Contract compiled", data: { contractId: "ctr_k3v9x0q2m7ab", termsHash: "ab".repeat(32) } },
  { actor: "paypal", type: "payment.authorized", title: "PayPal authorized $47.00", data: { authorizationId: "0VF52814937998046", amountMinor: 4700 } },
  { actor: "payment_orchestrator", type: "payment.captured", title: "Captured $47.00", detail: null, data: { captureId: "3C679366HH908993F" } },
];

function chainOf(inputs: AuditEventInput[] = INPUTS, dealId = DEAL): AuditEvent[] {
  const events: AuditEvent[] = [];
  inputs.forEach((input, i) => {
    events.push(buildAuditEvent(events[i - 1] ?? null, dealId, input, { id: `evt_${String(i + 1).padStart(12, "0")}`, now: new Date(T0 + i * 1000) }));
  });
  return events;
}

/** Recompute an event's own hash after tampering, as an attacker with database access would. */
function resealed(event: AuditEvent): AuditEvent {
  const { id, dealId, seq, at, actor, type, title, detail, data, prevHash } = event;
  return { ...event, hash: sha256Hex(prevHash + canonicalJson({ id, dealId, seq, at, actor, type, title, detail, data })) };
}

describe("buildAuditEvent", () => {
  it("starts the chain at seq 1 from the genesis hash", () => {
    expect(GENESIS_HASH).toBe("0000000000000000000000000000000000000000000000000000000000000000");
    const [first] = chainOf();
    expect(first).toMatchObject({
      id: "evt_000000000001",
      dealId: DEAL,
      seq: 1,
      at: "2026-10-06T09:00:00.000Z",
      actor: "human",
      type: "intent.received",
      title: "Request received",
      detail: "Three landing-page illustrations for under $50.",
      data: null,
      prevHash: GENESIS_HASH,
    });
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(AuditEventSchema.safeParse(first).success).toBe(true);
  });

  it("hashes the previous hash plus the canonical JSON of the event body", () => {
    const [first, second] = chainOf();
    const body = { id: second.id, dealId: second.dealId, seq: 2, at: second.at, actor: second.actor, type: second.type, title: second.title, detail: null, data: { seq: 1, priceMinor: 5300 } };
    expect(second.prevHash).toBe(first.hash);
    expect(second.hash).toBe(sha256Hex(first.hash + canonicalJson(body)));
  });

  it("links every event to its predecessor with gapless sequence numbers", () => {
    const events = chainOf();
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    for (let i = 1; i < events.length; i += 1) expect(events[i].prevHash).toBe(events[i - 1].hash);
    expect(new Set(events.map((event) => event.hash)).size).toBe(5);
    for (const event of events) expect(AuditEventSchema.safeParse(event).success).toBe(true);
  });

  it("only needs the previous event's seq and hash", () => {
    const events = chainOf();
    const next = buildAuditEvent({ seq: 5, hash: events[4].hash }, DEAL, { actor: "system", type: "deal.completed", title: "Deal completed" }, { id: "evt_000000000006", now: new Date(T0 + 9000) });
    expect(next.seq).toBe(6);
    expect(verifyAuditChain([...events, next])).toEqual({ valid: true, brokenAtSeq: null });
  });

  it("uses the caller's timestamp when given, normalised to UTC", () => {
    const event = buildAuditEvent(null, DEAL, { actor: "paypal", type: "payment.webhook", title: "Webhook", at: "2026-10-06T18:30:00+09:00" }, { id: "evt_a", now: new Date(T0) });
    expect(event.at).toBe("2026-10-06T09:30:00.000Z");
    expect(() => buildAuditEvent(null, DEAL, { actor: "paypal", type: "payment.webhook", title: "Webhook", at: "yesterday" }, { id: "evt_a", now: new Date(T0) })).toThrow(RangeError);
  });

  it("defaults detail and data to null", () => {
    const event = buildAuditEvent(null, DEAL, { actor: "system", type: "system.error", title: "Oops" }, { id: "evt_a", now: new Date(T0) });
    expect(event.detail).toBeNull();
    expect(event.data).toBeNull();
    const explicit = buildAuditEvent(null, DEAL, { actor: "system", type: "system.error", title: "Oops", detail: null, data: null }, { id: "evt_a", now: new Date(T0) });
    expect(explicit.hash).toBe(event.hash);
  });

  it("is deterministic and independent of the key order of data", () => {
    const make = (data: Record<string, unknown>) => buildAuditEvent(null, DEAL, { actor: "policy_engine", type: "policy.evaluated", title: "Policy", data }, { id: "evt_a", now: new Date(T0) });
    expect(make({ outcome: "allow", amountMinor: 4700, nested: { a: 1, b: 2 } }).hash).toBe(make({ nested: { b: 2, a: 1 }, amountMinor: 4700, outcome: "allow" }).hash);
    expect(make({ outcome: "allow" }).hash).not.toBe(make({ outcome: "block" }).hash);
  });

  it("makes data JSON-safe before hashing, so what is stored is what was hashed", () => {
    const data = {
      kept: "yes",
      dropped: undefined,
      when: new Date("2026-10-06T09:00:00.000Z"),
      invalidDate: new Date("nope"),
      notANumber: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
      big: BigInt("9007199254740993"),
      fn: () => 1,
      sym: Symbol("s"),
      nul: "a\u0000b",
      list: [1, undefined, "x", { deep: undefined, ok: true }],
      nested: { also: undefined, value: 0, empty: null },
    };
    const event = buildAuditEvent(null, DEAL, { actor: "system", type: "system.degraded", title: "Degraded", data }, { id: "evt_a", now: new Date(T0) });
    expect(event.data).toEqual({
      kept: "yes",
      when: "2026-10-06T09:00:00.000Z",
      invalidDate: null,
      notANumber: null,
      infinite: null,
      big: "9007199254740993",
      nul: "ab",
      list: [1, null, "x", { ok: true }],
      nested: { value: 0, empty: null },
    });
    // A database round trip returns exactly the same document, so the chain still verifies.
    const stored = JSON.parse(JSON.stringify(event)) as AuditEvent;
    expect(stored).toEqual(event);
    expect(verifyAuditChain([stored])).toEqual({ valid: true, brokenAtSeq: null });
  });

  it("cuts off pathological nesting and cycles instead of failing the write", () => {
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    const event = buildAuditEvent(null, DEAL, { actor: "system", type: "system.error", title: "Loop", data: loop }, { id: "evt_a", now: new Date(T0) });
    expect(() => canonicalJson(event.data)).not.toThrow();
    expect(JSON.stringify(event.data).length).toBeLessThan(500);
    expect(verifyAuditChain([event]).valid).toBe(true);
  });

  it("keeps title and detail inside the schema limits and free of NUL characters", () => {
    const event = buildAuditEvent(null, DEAL, { actor: "verifier", type: "verification.completed", title: `a\u0000${"t".repeat(400)}`, detail: "d".repeat(2000) }, { id: "evt_a", now: new Date(T0) });
    expect(event.title).toHaveLength(200);
    expect(event.title).not.toContain("\u0000");
    expect(event.detail).toHaveLength(800);
    expect(AuditEventSchema.safeParse(event).success).toBe(true);
    expect(verifyAuditChain([event]).valid).toBe(true);
  });

  it("does not mutate the caller's data", () => {
    const data = { a: undefined, when: new Date(T0), list: [undefined] };
    buildAuditEvent(null, DEAL, { actor: "system", type: "system.error", title: "x", data }, { id: "evt_a", now: new Date(T0) });
    expect(Object.keys(data)).toEqual(["a", "when", "list"]);
    expect(data.when).toBeInstanceOf(Date);
    expect(data.list).toEqual([undefined]);
  });
});

describe("verifyAuditChain", () => {
  it("accepts an untouched chain, a single event and an empty log", () => {
    expect(verifyAuditChain(chainOf())).toEqual({ valid: true, brokenAtSeq: null });
    expect(verifyAuditChain(chainOf().slice(0, 1))).toEqual({ valid: true, brokenAtSeq: null });
    expect(verifyAuditChain([])).toEqual({ valid: true, brokenAtSeq: null });
  });

  it("accepts a chain after a JSON round trip with shuffled keys", () => {
    const stored = chainOf().map((event) => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(event).reverse()))) as AuditEvent);
    expect(verifyAuditChain(stored)).toEqual({ valid: true, brokenAtSeq: null });
  });

  it("detects an edited title", () => {
    const events = chainOf();
    events[1] = { ...events[1], title: "Seller offered $35.00" };
    expect(verifyAuditChain(events)).toEqual({ valid: false, brokenAtSeq: 2 });
  });

  it("detects an edit to any hashed field", () => {
    const edits: Array<[string, (event: AuditEvent) => AuditEvent]> = [
      ["id", (e) => ({ ...e, id: "evt_forged000001" })],
      ["dealId", (e) => ({ ...e, dealId: "deal_other0000001" })],
      ["at", (e) => ({ ...e, at: "2026-10-06T09:00:03.001Z" })],
      ["actor", (e) => ({ ...e, actor: "human" })],
      ["type", (e) => ({ ...e, type: "payment.voided" })],
      ["detail", (e) => ({ ...e, detail: "added later" })],
      ["data value", (e) => ({ ...e, data: { ...e.data, amountMinor: 470 } })],
      ["data key added", (e) => ({ ...e, data: { ...e.data, note: "x" } })],
      ["data removed", (e) => ({ ...e, data: null })],
      ["prevHash", (e) => ({ ...e, prevHash: GENESIS_HASH })],
      ["hash", (e) => ({ ...e, hash: "f".repeat(64) })],
    ];
    for (const [label, edit] of edits) {
      const events = chainOf();
      events[3] = edit(events[3]);
      expect(verifyAuditChain(events), label).toEqual({ valid: false, brokenAtSeq: 4 });
    }
  });

  it("detects an edit even when the attacker recomputes that event's hash", () => {
    const events = chainOf();
    events[1] = resealed({ ...events[1], title: "Seller offered $35.00" });
    // Event 2 is now self-consistent, but event 3 still commits to the original hash.
    expect(verifyAuditChain(events)).toEqual({ valid: false, brokenAtSeq: 3 });
  });

  it("detects reordering", () => {
    const events = chainOf();
    [events[1], events[2]] = [events[2], events[1]];
    expect(verifyAuditChain(events)).toEqual({ valid: false, brokenAtSeq: 2 });
    expect(verifyAuditChain([...chainOf()].reverse())).toEqual({ valid: false, brokenAtSeq: 1 });
  });

  it("detects a deleted event, wherever it was", () => {
    const without = (index: number) => chainOf().filter((_, i) => i !== index);
    expect(verifyAuditChain(without(0))).toEqual({ valid: false, brokenAtSeq: 1 });
    expect(verifyAuditChain(without(2))).toEqual({ valid: false, brokenAtSeq: 3 });
    expect(verifyAuditChain(without(3))).toEqual({ valid: false, brokenAtSeq: 4 });
  });

  it("detects a deletion disguised by renumbering", () => {
    const events = chainOf().filter((_, i) => i !== 2);
    events[2] = { ...events[2], seq: 3 };
    events[3] = { ...events[3], seq: 4 };
    expect(verifyAuditChain(events)).toEqual({ valid: false, brokenAtSeq: 3 });
  });

  it("detects a duplicated or inserted event", () => {
    const events = chainOf();
    expect(verifyAuditChain([events[0], events[1], events[1], events[2]])).toEqual({ valid: false, brokenAtSeq: 3 });
    const forged = buildAuditEvent(events[1], DEAL, { actor: "human", type: "human.released_payment", title: "Released" }, { id: "evt_forged000001", now: new Date(T0 + 1500) });
    expect(verifyAuditChain([events[0], events[1], forged, ...events.slice(2)])).toEqual({ valid: false, brokenAtSeq: 4 });
  });

  it("detects events spliced in from another deal", () => {
    const other = chainOf(INPUTS, "deal_other0000001");
    expect(verifyAuditChain(other).valid).toBe(true);
    const mixed = [...chainOf().slice(0, 2), ...other.slice(2)];
    expect(verifyAuditChain(mixed)).toEqual({ valid: false, brokenAtSeq: 3 });
  });

  it("rejects a chain that does not start at the genesis hash", () => {
    const tail = chainOf().slice(2);
    expect(verifyAuditChain(tail)).toEqual({ valid: false, brokenAtSeq: 1 });
    const rebased = buildAuditEvent({ seq: 0, hash: "a".repeat(64) }, DEAL, INPUTS[0], { id: "evt_000000000001", now: new Date(T0) });
    expect(rebased.seq).toBe(1);
    expect(verifyAuditChain([rebased])).toEqual({ valid: false, brokenAtSeq: 1 });
  });

  it("returns invalid, without throwing, for an event that cannot be canonicalised", () => {
    const events = chainOf();
    events[2] = { ...events[2], data: { broken: undefined } };
    expect(verifyAuditChain(events)).toEqual({ valid: false, brokenAtSeq: 3 });
  });

  it("cannot see a truncated tail: the head hash must be anchored elsewhere to detect that", () => {
    // Documented limit of any hash chain without an external anchor.
    expect(verifyAuditChain(chainOf().slice(0, 3))).toEqual({ valid: true, brokenAtSeq: null });
  });
});
