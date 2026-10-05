/**
 * The spending policy service: per-session documents, what counts as committed spend, the
 * rate limiter underneath, and the simulated checkout the approval page reads.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createAgents } from "@/lib/ai";
import type { DealView } from "@/lib/api/dto";
import { closeDb, createDbSimulatedStore, createTestDb, getPolicyDoc, type Db } from "@/lib/db";
import { verifyContractHash } from "@/lib/domain/contract";
import type { ScenarioId } from "@/lib/domain/scenarios";
import { DEFAULT_POLICY, type Policy } from "@/lib/domain/schemas";
import type { DealStatus } from "@/lib/domain/status";
import { SimulatedProvider } from "@/lib/payments";
import type { ServiceContext } from "@/lib/services/context";
import { advanceDeal, completePayPalApproval, createDeal, decideDeal, getDealView, getSimulatedCheckout } from "@/lib/services/deals";
import { committedSpendToday, effectivePolicy, getPolicy, startOfUtcDay, updatePolicy } from "@/lib/services/policy";
import { RATE_LIMITS, enforceRateLimit, rateLimitKey } from "@/lib/services/rate-limit";
import { newSessionId } from "@/lib/services/session";

const START_MS = Date.parse("2026-10-06T05:00:00.000Z");
const APP_URL = "https://pact.test";

let db: Db;
let nowMs = START_MS;
let provider: SimulatedProvider;
let ctx: ServiceContext;
const now = (): Date => new Date(nowMs);

beforeAll(async () => {
  db = await createTestDb();
  provider = new SimulatedProvider(createDbSimulatedStore(db), { now });
  ctx = { db, agents: createAgents({ mode: "scripted" }), provider, now };
});

afterAll(async () => {
  await closeDb(db);
});

beforeEach(() => {
  nowMs = START_MS;
});

async function open(scenarioId: ScenarioId, session: string): Promise<string> {
  return (await createDeal(ctx, { sessionId: session, clientKey: null }, { intent: "", scenarioId, tzOffsetMinutes: -540 })).id;
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

describe("getPolicy / updatePolicy", () => {
  it("answers with the default until a session saves its own", async () => {
    const session = newSessionId();
    expect(await getPolicy(ctx, null)).toEqual({ policy: DEFAULT_POLICY, spentTodayMinor: 0, isDefault: true });
    expect(await getPolicy(ctx, session)).toEqual({ policy: DEFAULT_POLICY, spentTodayMinor: 0, isDefault: true });
    expect(await effectivePolicy(db, session)).toEqual(DEFAULT_POLICY);
    expect(await getPolicyDoc(db, session)).toBeNull();
  });

  it("saves a policy for one session and leaves every other session alone", async () => {
    const mine = newSessionId();
    const theirs = newSessionId();
    const custom: Policy = { ...DEFAULT_POLICY, autonomousLimitMinor: 2000, maxTransactionMinor: 50_000, dailyLimitMinor: 80_000, requireApprovalForNewSellers: false };

    expect(await updatePolicy(ctx, mine, custom)).toEqual({ policy: custom, spentTodayMinor: 0, isDefault: false });
    expect(await getPolicy(ctx, mine)).toEqual({ policy: custom, spentTodayMinor: 0, isDefault: false });
    expect(await effectivePolicy(db, mine)).toEqual(custom);
    expect(await getPolicy(ctx, theirs)).toMatchObject({ policy: DEFAULT_POLICY, isDefault: true });

    // A second save replaces the first.
    const stricter = { ...custom, autonomousLimitMinor: 500 };
    expect((await updatePolicy(ctx, mine, stricter)).policy.autonomousLimitMinor).toBe(500);
  });

  it("drops unknown fields and duplicate categories", async () => {
    const session = newSessionId();
    const saved = await updatePolicy(ctx, session, {
      ...DEFAULT_POLICY,
      allowedCategories: ["illustration", "illustration", "copywriting"],
      owner: "system",
      spentTodayMinor: -1,
    });
    expect(saved.policy).toEqual({ ...DEFAULT_POLICY, allowedCategories: ["illustration", "copywriting"] });
    expect(await getPolicyDoc(db, session)).toEqual(saved.policy);
  });

  it("refuses an invalid document and stores nothing", async () => {
    const session = newSessionId();
    const invalid: unknown[] = [
      { ...DEFAULT_POLICY, autonomousLimitMinor: DEFAULT_POLICY.maxTransactionMinor + 1 },
      { ...DEFAULT_POLICY, maxTransactionMinor: 500_001 },
      { ...DEFAULT_POLICY, dailyLimitMinor: 10.5 },
      { ...DEFAULT_POLICY, humanReviewMinConfidence: 0.95, autoCaptureMinConfidence: 0.9 },
      { ...DEFAULT_POLICY, autoCaptureMinConfidence: 0.3 },
      { ...DEFAULT_POLICY, allowedCategories: ["weapons"] },
      { autonomousLimitMinor: 1 },
      null,
      "policy",
    ];
    for (const document of invalid) await expect(updatePolicy(ctx, session, document)).rejects.toBeInstanceOf(ZodError);
    await expect(updatePolicy(ctx, session, { ...DEFAULT_POLICY, allowedCategories: ["illustration", "restricted"] })).rejects.toMatchObject({
      status: 400,
      message: "Restricted work can never be an allowed category.",
    });
    expect(await getPolicyDoc(db, session)).toBeNull();
    // The daily limit may be lower than the per-transaction maximum: that is the user's call.
    const tight = { ...DEFAULT_POLICY, dailyLimitMinor: 5000 };
    expect((await updatePolicy(ctx, session, tight)).policy).toEqual(tight);
  });

  it("limits how often a session may change its policy", async () => {
    const session = newSessionId();
    const { limit, windowSeconds } = RATE_LIMITS.policyUpdatePerSession;
    for (let i = 0; i < limit; i += 1) await updatePolicy(ctx, session, DEFAULT_POLICY);
    await expect(updatePolicy(ctx, session, DEFAULT_POLICY)).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    // Invalid documents were never counted, and the limit lifts when the window ends.
    nowMs += windowSeconds * 1000;
    await expect(updatePolicy(ctx, session, DEFAULT_POLICY)).resolves.toMatchObject({ isDefault: false });
  });
});

describe("policy and deals", () => {
  it("applies the session's limits to its next deal", async () => {
    const session = newSessionId();
    await updatePolicy(ctx, session, { ...DEFAULT_POLICY, autonomousLimitMinor: 2500 });
    const dealId = await open("happy-path", session);
    const gate = await driveTo(session, dealId, "awaiting_approval");
    expect(gate.policy?.checks.filter((check) => check.outcome !== "pass").map((check) => check.id)).toEqual(["autonomous_limit"]);

    // A per-transaction maximum below the price blocks the deal outright.
    const strict = newSessionId();
    await updatePolicy(ctx, strict, { ...DEFAULT_POLICY, autonomousLimitMinor: 1000, maxTransactionMinor: 4000 });
    const blocked = await driveTo(strict, await open("happy-path", strict), "blocked");
    expect(blocked.policy?.checks.filter((check) => check.outcome === "block").map((check) => check.id)).toEqual(["per_transaction_max"]);
    expect(blocked.payment).toBeNull();
  });

  it("copies the confidence thresholds into the contract at signing; a later edit does not reach back", async () => {
    const session = newSessionId();
    await updatePolicy(ctx, session, { ...DEFAULT_POLICY, autoCaptureMinConfidence: 0.95, humanReviewMinConfidence: 0.6 });
    const dealId = await open("happy-path", session);
    const signed = (await driveTo(session, dealId, "contracted")).contract;
    expect(signed?.contract.settlement).toMatchObject({ autoCaptureMinConfidence: 0.95, humanReviewMinConfidence: 0.6 });

    // The policy is relaxed after signing. The contract still demands 0.95, and the verifier's
    // 0.9 on the AI-judged condition is therefore not enough: a human decides, nothing is captured.
    await updatePolicy(ctx, session, { ...DEFAULT_POLICY, autoCaptureMinConfidence: 0.6, humanReviewMinConfidence: 0.5 });
    const later = await driveTo(session, dealId, "in_review");
    expect(later.contract?.contract.settlement).toEqual(signed?.contract.settlement);
    expect(later.contract?.termsHash).toBe(signed?.termsHash);
    expect(later.contract ? verifyContractHash(later.contract) : false).toBe(true);
    expect(later.reports[0]).toMatchObject({ decision: "human_review", failedRuleIds: [], confidence: 0.9 });
    expect(later.payment).toMatchObject({ status: "authorized", capturedMinor: 0 });

    // The next contract is signed under the new policy, and the same confidence now captures.
    const next = await driveTo(session, await open("happy-path", session), "completed");
    expect(next.contract?.contract.settlement).toMatchObject({ autoCaptureMinConfidence: 0.6, humanReviewMinConfidence: 0.5 });
    expect(next.reports[0]).toMatchObject({ decision: "capture_eligible" });
  });

  it("reports what is committed against today's limit: open orders, holds and captures — not released money", async () => {
    const session = newSessionId();
    const spent = async (): Promise<number> => (await getPolicy(ctx, session)).spentTodayMinor;
    const first = await open("happy-path", session);
    await driveTo(session, first, "payment_pending");
    expect(await spent()).toBe(0);

    await driveTo(session, first, "awaiting_payment");
    expect(await spent()).toBe(4700);
    await driveTo(session, first, "completed");
    expect(await spent()).toBe(4700);

    // A second deal adds to it while held, and stops counting once its hold is voided.
    const second = await open("injection", session);
    await driveTo(session, second, "in_review");
    expect(await spent()).toBe(4700 + 1800);
    await decideDeal(ctx, session, second, { kind: "reject_delivery" });
    await driveTo(session, second, "rejected");
    expect(await spent()).toBe(4700);

    expect(await committedSpendToday(db, session, now(), { excludeDealId: first })).toBe(0);
    expect(startOfUtcDay(now())).toBe("2026-10-06T00:00:00.000Z");
    expect(startOfUtcDay(new Date("2026-10-06T23:59:59.999Z"))).toBe("2026-10-06T00:00:00.000Z");
  });
});

describe("enforceRateLimit", () => {
  it("allows the budget, then refuses with the time the window ends", async () => {
    const key = rateLimitKey("test-scope", newSessionId());
    for (let i = 0; i < 3; i += 1) await enforceRateLimit(ctx, key, 3, 60);
    await expect(enforceRateLimit(ctx, key, 3, 60)).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      details: { resetAt: new Date(START_MS + 60_000).toISOString() },
    });
    // Another key has its own budget; this one is free again once the window has passed.
    await expect(enforceRateLimit(ctx, rateLimitKey("test-scope", newSessionId()), 3, 60)).resolves.toBeUndefined();
    nowMs += 60_000;
    await expect(enforceRateLimit(ctx, key, 3, 60)).resolves.toBeUndefined();
  });
});

describe("getSimulatedCheckout", () => {
  it("describes an order awaiting the simulated payer, and stops offering it once it is settled", async () => {
    const session = newSessionId();
    const dealId = await open("happy-path", session);
    const waiting = await driveTo(session, dealId, "awaiting_payment");
    const orderId = waiting.payment?.orderId ?? "";

    const checkout = await getSimulatedCheckout(ctx, orderId);
    expect(checkout).toMatchObject({ orderId, dealId, amountMinor: 4700, awaitingPayer: true });
    expect(checkout?.description).toContain(waiting.contract?.contract.contractId);

    await provider.approve(orderId);
    expect(await getSimulatedCheckout(ctx, orderId)).toMatchObject({ awaitingPayer: false });
  });

  it("knows nothing about unknown or malformed orders, or when real PayPal is the provider", async () => {
    expect(await getSimulatedCheckout(ctx, "SIM-O-0000000000000000")).toBeNull();
    expect(await getSimulatedCheckout(ctx, "5O190127TN364715T")).toBeNull();
    expect(await getSimulatedCheckout(ctx, "../../etc/passwd")).toBeNull();

    const session = newSessionId();
    const waiting = await driveTo(session, await open("happy-path", session), "awaiting_payment");
    const real: ServiceContext = { ...ctx, provider: { ...provider, kind: "paypal_sandbox" } as unknown as ServiceContext["provider"] };
    expect(await getSimulatedCheckout(real, waiting.payment?.orderId ?? "")).toBeNull();
  });
});
