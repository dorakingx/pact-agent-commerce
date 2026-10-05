/**
 * Concurrency: the properties the security document promises about replays and races.
 *
 *  - one step per deal at a time (the lease), however many requests arrive together;
 *  - one capture per authorization, whatever the number of "capture now" requests;
 *  - the daily limit holds across deals of one owner that reach the order step together;
 *  - a step whose deal changed underneath it writes nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgents } from "@/lib/ai";
import type { Agents } from "@/lib/ai/types";
import type { DealView } from "@/lib/api/dto";
import {
  acquireDealLease,
  closeDb,
  createDbSimulatedStore,
  createTestDb,
  getDeal,
  listMoves,
  listPaymentOperations,
  releaseDealLease,
  updateDeal,
  upsertPolicyDoc,
  type Db,
} from "@/lib/db";
import type { ScenarioId } from "@/lib/domain/scenarios";
import { DEFAULT_POLICY } from "@/lib/domain/schemas";
import type { DealStatus } from "@/lib/domain/status";
import { SimulatedProvider } from "@/lib/payments";
import type { ServiceContext } from "@/lib/services/context";
import { advanceDeal, completePayPalApproval, createDeal, decideDeal, getDealView } from "@/lib/services/deals";
import { committedSpendToday } from "@/lib/services/policy";
import { newSessionId } from "@/lib/services/session";

const START_MS = Date.parse("2026-10-06T05:00:00.000Z");
const APP_URL = "https://pact.test";
const LEASE_TTL_MS = 120_000;

let db: Db;
let nowMs = START_MS;
let provider: SimulatedProvider;
let ctx: ServiceContext;
const scripted = createAgents({ mode: "scripted" });
const now = (): Date => new Date(nowMs);

beforeAll(async () => {
  db = await createTestDb();
  provider = new SimulatedProvider(createDbSimulatedStore(db), { now });
  ctx = { db, agents: scripted, provider, now };
});

afterAll(async () => {
  await closeDb(db);
});

beforeEach(() => {
  nowMs = START_MS;
});

async function open(scenarioId: ScenarioId, session = newSessionId()): Promise<{ session: string; dealId: string }> {
  const deal = await createDeal(ctx, { sessionId: session, clientKey: null }, { intent: "", scenarioId, tzOffsetMinutes: -540 });
  return { session, dealId: deal.id };
}

/** Play the deal forward — approving and paying where a human would — until it reaches `target`. */
async function driveTo(session: string, dealId: string, target: DealStatus): Promise<DealView> {
  for (let guard = 0; guard < 40; guard += 1) {
    const deal = await getDealView(ctx, session, dealId);
    if (deal.status === target) return deal;
    if (deal.status === "awaiting_approval") {
      await decideDeal(ctx, session, dealId, { kind: "approve_spend" });
    } else if (deal.status === "awaiting_payment") {
      await provider.approve(deal.payment?.orderId ?? "");
      await completePayPalApproval(ctx, { dealId, orderId: deal.payment?.orderId ?? null });
    } else if (deal.next.kind === "auto") {
      await advanceDeal(ctx, session, dealId, APP_URL);
    } else {
      throw new Error(`deal stopped at ${deal.status} before reaching ${target}`);
    }
  }
  throw new Error(`deal did not reach ${target}`);
}

/** A promise the test resolves by hand, to hold a step open at a known point. */
function gate(): { entered: Promise<void>; enter: () => void; opened: Promise<void>; open: () => void } {
  let enter = (): void => {};
  let open = (): void => {};
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { entered, enter, opened, open };
}

describe("one step per deal at a time", () => {
  it("a second request while a step runs is told the deal is busy, and nothing runs twice", async () => {
    const { session, dealId } = await open("happy-path");
    const hold = gate();
    const slow: Agents = {
      ...scripted,
      async sellerMove(context) {
        hold.enter();
        await hold.opened;
        return scripted.sellerMove(context);
      },
    };
    const slowCtx: ServiceContext = { ...ctx, agents: slow };

    const first = advanceDeal(slowCtx, session, dealId, APP_URL);
    await hold.entered;
    // The first request is inside its model call and holds the lease.
    const second = await advanceDeal(ctx, session, dealId, APP_URL);
    expect(second).toMatchObject({ executed: null, busy: true, deal: { status: "negotiating" } });
    expect(await listMoves(db, dealId)).toHaveLength(0);

    hold.open();
    expect(await first).toMatchObject({ executed: "negotiate", busy: false });
    expect(await listMoves(db, dealId)).toHaveLength(1);
    // The lease was released: the next request runs the next step.
    expect(await advanceDeal(ctx, session, dealId, APP_URL)).toMatchObject({ executed: "negotiate", busy: false });
    expect(await listMoves(db, dealId)).toHaveLength(2);
  });

  it("two requests fired together execute exactly one step", async () => {
    const { session, dealId } = await open("happy-path");
    const results = await Promise.all([advanceDeal(ctx, session, dealId, APP_URL), advanceDeal(ctx, session, dealId, APP_URL)]);
    expect(results.filter((result) => result.executed === "negotiate")).toHaveLength(1);
    expect(results.filter((result) => result.busy)).toHaveLength(1);
    expect(await listMoves(db, dealId)).toHaveLength(1);
  });

  it("a human decision cannot interleave with a running step", async () => {
    const { session, dealId } = await open("approval");
    await driveTo(session, dealId, "awaiting_approval");
    // Another request holds the lease (as a step in flight would).
    await acquireDealLease(db, dealId, "step_held-by-another-request", 120, now());
    await expect(decideDeal(ctx, session, dealId, { kind: "approve_spend" })).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect((await getDeal(db, dealId))?.status).toBe("awaiting_approval");
    await releaseDealLease(db, dealId, "step_held-by-another-request");
    expect((await decideDeal(ctx, session, dealId, { kind: "approve_spend" })).status).toBe("payment_pending");
  });

  it("a lease abandoned by a crashed request expires and the deal moves again", async () => {
    const { session, dealId } = await open("happy-path");
    await acquireDealLease(db, dealId, "step_crashed-request", 120, now());
    expect(await advanceDeal(ctx, session, dealId, APP_URL)).toMatchObject({ executed: null, busy: true });
    nowMs += LEASE_TTL_MS - 1_000;
    expect((await advanceDeal(ctx, session, dealId, APP_URL)).busy).toBe(true);
    nowMs += 2_000;
    expect(await advanceDeal(ctx, session, dealId, APP_URL)).toMatchObject({ executed: "negotiate", busy: false });
  });
});

describe("one capture per authorization", () => {
  it("50 parallel requests at 'verified' capture exactly once, for exactly the contract price", async () => {
    const { session, dealId } = await open("happy-path");
    const verified = await driveTo(session, dealId, "verified");
    expect(verified.payment).toMatchObject({ status: "authorized", authorizedMinor: 4700, capturedMinor: 0 });

    const results = await Promise.all(Array.from({ length: 50 }, () => advanceDeal(ctx, session, dealId, APP_URL)));

    expect(results.filter((result) => result.executed === "capture")).toHaveLength(1);
    expect(results.filter((result) => result.executed !== null && result.executed !== "capture")).toEqual([]);
    const done = await getDealView(ctx, session, dealId);
    expect(done).toMatchObject({ status: "completed", payment: { status: "captured", capturedMinor: 4700, authorizedMinor: 4700 } });
    expect(done.contract?.contract.price.amountMinor).toBe(done.payment?.capturedMinor);
    expect(done.audit.filter((event) => event.type === "payment.captured")).toHaveLength(1);
    expect(done.audit.filter((event) => event.type === "deal.completed")).toHaveLength(1);
    expect(done.flags.auditChainValid).toBe(true);

    const captures = (await listPaymentOperations(db, dealId)).filter((operation) => operation.kind === "capture");
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ status: "succeeded", attempts: 1, request: { amountMinor: 4700, finalCapture: true } });
    expect((await provider.getAuthorization(done.payment?.authorizationId ?? "")).status).toBe("CAPTURED");
  });

  it("100 sequential repeats after the capture change nothing", async () => {
    const { session, dealId } = await open("revision");
    const done = await driveTo(session, dealId, "completed");
    const before = JSON.stringify([done.payment, done.audit.length, await listPaymentOperations(db, dealId)]);
    for (let i = 0; i < 100; i += 1) {
      const again = await advanceDeal(ctx, session, dealId, APP_URL);
      expect(again).toMatchObject({ executed: null, busy: false });
    }
    const after = await getDealView(ctx, session, dealId);
    expect(JSON.stringify([after.payment, after.audit.length, await listPaymentOperations(db, dealId)])).toBe(before);
  });
});

describe("the daily limit across concurrent deals", () => {
  /** Where the engine puts a deal the limit refuses at the order step (see SPEND_REFUSED_STATUS in deals.ts). */
  const refusedStatus: DealStatus = "blocked";

  it("two deals that each fit but together exceed the limit: exactly one gets an order", async () => {
    const session = newSessionId();
    // Each happy-path deal is $47.00; $60.00 a day has room for one of them.
    await upsertPolicyDoc(db, session, { ...DEFAULT_POLICY, dailyLimitMinor: 6000 });
    const a = await open("happy-path", session);
    const b = await open("happy-path", session);
    // Policy is evaluated for each while nothing is committed yet, so both are cleared.
    for (const deal of [a, b]) {
      const cleared = await driveTo(session, deal.dealId, "payment_pending");
      expect(cleared.policy).toMatchObject({ outcome: "allow", spentTodayMinor: 0 });
    }

    const results = await Promise.all([a, b].map((deal) => advanceDeal(ctx, session, deal.dealId, APP_URL)));
    expect(results.map((result) => result.executed)).toEqual(["order", "order"]);

    const statuses = results.map((result) => result.deal.status).sort();
    expect(statuses).toEqual(["awaiting_payment", refusedStatus].sort());
    const refused = results.find((result) => result.deal.status === refusedStatus)?.deal;
    const ordered = results.find((result) => result.deal.status === "awaiting_payment")?.deal;
    if (!refused || !ordered) throw new Error("expected one refused and one ordered deal");

    // The refused deal never reached PayPal, and says why.
    expect(await listPaymentOperations(db, refused.id)).toEqual([]);
    expect(refused.payment).toBeNull();
    expect(refused.policy).toMatchObject({ outcome: "block", spentTodayMinor: 4700 });
    expect(refused.policy?.checks.filter((check) => check.outcome === "block").map((check) => check.id)).toEqual(["daily_limit"]);
    expect(refused.audit[refused.audit.length - 1]).toMatchObject({
      type: "policy.evaluated",
      title: "Spending policy: blocked by the daily limit before the order",
      data: { outcome: "block", flagged: ["daily_limit"] },
    });
    expect(refused.lastError).toContain("daily spending limit");
    expect(refused).toMatchObject({ statusLabel: "Blocked by policy", next: { kind: "done" } });
    expect(refused.flags.auditChainValid).toBe(true);

    expect((await listPaymentOperations(db, ordered.id)).map((operation) => operation.kind)).toEqual(["create_order"]);
    expect(await committedSpendToday(db, session, now())).toBe(4700);
  });

  it("an open order already counts when the next deal's policy is evaluated", async () => {
    const session = newSessionId();
    await upsertPolicyDoc(db, session, { ...DEFAULT_POLICY, dailyLimitMinor: 6000 });
    const first = await open("happy-path", session);
    await driveTo(session, first.dealId, "awaiting_payment");

    const second = await open("happy-path", session);
    const blocked = await driveTo(session, second.dealId, "blocked");
    expect(blocked.policy).toMatchObject({ outcome: "block", spentTodayMinor: 4700 });
    expect(blocked.payment).toBeNull();

    // Cancelling the first order frees the budget for a new deal.
    await decideDeal(ctx, session, first.dealId, { kind: "cancel_payment" });
    expect(await committedSpendToday(db, session, now())).toBe(0);
    const third = await open("happy-path", session);
    expect((await driveTo(session, third.dealId, "awaiting_payment")).policy?.outcome).toBe("allow");
  });

  it("limits are per owner: another session's spend does not count", async () => {
    const spender = newSessionId();
    const other = newSessionId();
    await upsertPolicyDoc(db, spender, { ...DEFAULT_POLICY, dailyLimitMinor: 6000 });
    await upsertPolicyDoc(db, other, { ...DEFAULT_POLICY, dailyLimitMinor: 6000 });
    const mine = await open("happy-path", spender);
    await driveTo(spender, mine.dealId, "authorized");
    const theirs = await open("happy-path", other);
    expect((await driveTo(other, theirs.dealId, "awaiting_payment")).policy).toMatchObject({ outcome: "allow", spentTodayMinor: 0 });
  });

  it("yesterday's authorizations do not count against today", async () => {
    const session = newSessionId();
    await upsertPolicyDoc(db, session, { ...DEFAULT_POLICY, dailyLimitMinor: 6000 });
    const first = await open("happy-path", session);
    await driveTo(session, first.dealId, "authorized");
    expect(await committedSpendToday(db, session, now())).toBe(4700);
    nowMs += 24 * 60 * 60 * 1000;
    expect(await committedSpendToday(db, session, now())).toBe(0);
  });
});

describe("optimistic versioning", () => {
  it("a step whose deal changed underneath it is refused and writes nothing", async () => {
    const { session, dealId } = await open("happy-path");
    const meddling: Agents = {
      ...scripted,
      async sellerMove(context) {
        // Something else writes the deal while the agent is thinking (as after an expired lease).
        const deal = await getDeal(db, dealId);
        if (!deal) throw new Error("deal vanished");
        await updateDeal(db, dealId, deal.version, { lastError: "written by someone else" });
        return scripted.sellerMove(context);
      },
    };
    const before = await getDealView(ctx, session, dealId);

    await expect(advanceDeal({ ...ctx, agents: meddling }, session, dealId, APP_URL)).rejects.toMatchObject({ status: 409, code: "conflict" });

    const after = await getDealView(ctx, session, dealId);
    // The whole step was rolled back: no move, no audit event, and the lease is free again.
    expect(after.negotiation.moves).toEqual([]);
    expect(after.audit).toEqual(before.audit);
    expect(after.status).toBe("negotiating");
    expect(await getDeal(db, dealId)).toMatchObject({ lockId: null, version: 1 });
    expect(await advanceDeal(ctx, session, dealId, APP_URL)).toMatchObject({ executed: "negotiate", busy: false });
  });
});
