import { describe, expect, it } from "vitest";
import {
  AUTO_STATUSES,
  DEAL_STATUSES,
  DEAL_STATUS_LABEL,
  DEAL_TRANSITIONS,
  HUMAN_STATUSES,
  IllegalTransitionError,
  PAYMENT_RAIL,
  PAYMENT_STATUSES,
  PAYMENT_STATUS_LABEL,
  PAYMENT_TRANSITIONS,
  TERMINAL_STATUSES,
  assertPaymentTransition,
  assertTransition,
  canPaymentTransition,
  canTransition,
  isAuto,
  isHumanGate,
  isTerminal,
  type DealStatus,
  type PaymentStatus,
} from "./status";

/** Every status reachable from `start` by following the transition table. */
function reachable<S extends string>(start: S, table: Record<S, readonly S[]>): Set<S> {
  const seen = new Set<S>([start]);
  const queue: S[] = [start];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const target of table[next]) {
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
}

describe("deal state machine", () => {
  it("defines transitions for exactly the known statuses", () => {
    expect(Object.keys(DEAL_TRANSITIONS).sort()).toEqual([...DEAL_STATUSES].sort());
    expect(new Set(DEAL_STATUSES).size).toBe(DEAL_STATUSES.length);
  });

  it("only ever targets known statuses", () => {
    for (const [from, targets] of Object.entries(DEAL_TRANSITIONS)) {
      for (const target of targets) {
        expect(DEAL_STATUSES, `${from} -> ${target}`).toContain(target);
      }
      expect(new Set(targets).size, `duplicate target from ${from}`).toBe(targets.length);
    }
  });

  it("partitions every status into exactly one of auto, human or terminal", () => {
    const groups = [...AUTO_STATUSES, ...HUMAN_STATUSES, ...TERMINAL_STATUSES];
    expect(groups).toHaveLength(DEAL_STATUSES.length);
    expect([...groups].sort()).toEqual([...DEAL_STATUSES].sort());
    for (const status of DEAL_STATUSES) {
      const memberships = [isAuto(status), isHumanGate(status), isTerminal(status)].filter(Boolean);
      expect(memberships, status).toHaveLength(1);
    }
  });

  it("gives terminal statuses no exits and every other status at least one", () => {
    for (const status of DEAL_STATUSES) {
      if (isTerminal(status)) expect(DEAL_TRANSITIONS[status], status).toEqual([]);
      else expect(DEAL_TRANSITIONS[status].length, status).toBeGreaterThan(0);
    }
  });

  it("can reach every status from negotiating, and a terminal status from everywhere", () => {
    expect([...reachable<DealStatus>("negotiating", DEAL_TRANSITIONS)].sort()).toEqual([...DEAL_STATUSES].sort());
    for (const status of DEAL_STATUSES) {
      const ends = [...reachable<DealStatus>(status, DEAL_TRANSITIONS)].filter(isTerminal);
      expect(ends.length, `${status} can never finish`).toBeGreaterThan(0);
    }
  });

  it("never lets a deal reach completed without passing through verified", () => {
    const sources = DEAL_STATUSES.filter((status) => DEAL_TRANSITIONS[status].includes("completed"));
    expect(sources).toEqual(["verified"]);
  });

  it("only reaches verified from verification or a human review", () => {
    const sources = DEAL_STATUSES.filter((status) => DEAL_TRANSITIONS[status].includes("verified"));
    expect(sources.sort()).toEqual(["in_review", "submitted"]);
  });

  it("only reaches authorized after policy has cleared the spend", () => {
    const sources = DEAL_STATUSES.filter((status) => DEAL_TRANSITIONS[status].includes("authorized"));
    expect(sources.sort()).toEqual(["awaiting_payment", "payment_pending"]);
    const cleared = DEAL_STATUSES.filter((status) => DEAL_TRANSITIONS[status].includes("payment_pending"));
    expect(cleared.sort()).toEqual(["awaiting_approval", "contracted"]);
  });

  it("lets the spending policy block a deal at signing and again immediately before the order, nowhere else", () => {
    const sources = DEAL_STATUSES.filter((status) => DEAL_TRANSITIONS[status].includes("blocked"));
    expect(sources.sort()).toEqual(["contracted", "payment_pending"]);
  });

  it("lets a deal expire from exactly the states that count on a hold PayPal can release", () => {
    const sources = DEAL_STATUSES.filter((status) => DEAL_TRANSITIONS[status].includes("expired"));
    expect(sources.sort()).toEqual(["authorized", "awaiting_payment", "in_review", "revision_required", "submitted", "verified"]);
    // A rejection is already releasing the hold: it ends as rejected (or failed), never expired.
    expect(canTransition("rejecting", "expired")).toBe(false);
  });

  it("answers canTransition from the table and throws on illegal moves", () => {
    expect(canTransition("verified", "completed")).toBe(true);
    expect(canTransition("authorized", "completed")).toBe(false);
    expect(canTransition("completed", "negotiating")).toBe(false);
    expect(() => assertTransition("submitted", "verified")).not.toThrow();
    expect(() => assertTransition("authorized", "completed")).toThrow(IllegalTransitionError);
    try {
      assertTransition("rejected", "completed");
      expect.unreachable("a terminal status must not transition");
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      expect((error as IllegalTransitionError).machine).toBe("deal");
      expect((error as Error).message).toContain("rejected");
    }
  });

  it("labels every status", () => {
    for (const status of DEAL_STATUSES) {
      expect(DEAL_STATUS_LABEL[status].length, status).toBeGreaterThan(0);
    }
  });
});

describe("payment state machine", () => {
  const terminal: PaymentStatus[] = ["captured", "voided", "expired", "failed"];

  it("defines transitions for exactly the known statuses and only targets known ones", () => {
    expect(Object.keys(PAYMENT_TRANSITIONS).sort()).toEqual([...PAYMENT_STATUSES].sort());
    for (const [from, targets] of Object.entries(PAYMENT_TRANSITIONS)) {
      for (const target of targets) {
        expect(PAYMENT_STATUSES, `${from} -> ${target}`).toContain(target);
      }
    }
  });

  it("gives terminal payment statuses no exits", () => {
    for (const status of PAYMENT_STATUSES) {
      if (terminal.includes(status)) expect(PAYMENT_TRANSITIONS[status], status).toEqual([]);
      else expect(PAYMENT_TRANSITIONS[status].length, status).toBeGreaterThan(0);
    }
  });

  it("can only capture from an authorization, and never un-capture", () => {
    const sources = PAYMENT_STATUSES.filter((status) => PAYMENT_TRANSITIONS[status].includes("captured"));
    expect(sources).toEqual(["authorized"]);
    expect(canPaymentTransition("captured", "voided")).toBe(false);
    expect(canPaymentTransition("voided", "captured")).toBe(false);
    expect(() => assertPaymentTransition("created", "captured")).toThrow(IllegalTransitionError);
    expect(() => assertPaymentTransition("authorized", "captured")).not.toThrow();
  });

  it("reaches every status from none", () => {
    expect([...reachable<PaymentStatus>("none", PAYMENT_TRANSITIONS)].sort()).toEqual([...PAYMENT_STATUSES].sort());
  });

  it("has a happy-path rail made of legal consecutive transitions", () => {
    expect(canPaymentTransition("none", PAYMENT_RAIL[0])).toBe(true);
    for (let i = 1; i < PAYMENT_RAIL.length; i += 1) {
      expect(canPaymentTransition(PAYMENT_RAIL[i - 1], PAYMENT_RAIL[i]), `${PAYMENT_RAIL[i - 1]} -> ${PAYMENT_RAIL[i]}`).toBe(true);
    }
  });

  it("labels every status", () => {
    for (const status of PAYMENT_STATUSES) {
      expect(PAYMENT_STATUS_LABEL[status].length, status).toBeGreaterThan(0);
    }
  });
});
