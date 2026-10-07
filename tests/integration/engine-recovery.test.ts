/**
 * Recovery paths of the step engine that a review found wrong: a step that gives up while money
 * may still be held, a terminal status written without an audit line, a delegated wallet PayPal
 * rejects, the shared demo wallet's own cap, and settlement when the payer's browser is gone.
 *
 * Each test asks the same two questions as service-failures.test.ts: did money move that should
 * not have, and is any money left on hold that nothing can find or release?
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgents } from "@/lib/ai";
import type { DealView } from "@/lib/api/dto";
import {
  acquireDealLease,
  closeDb,
  createDbSimulatedStore,
  createTestDb,
  deleteWallet,
  getPayment,
  getWallet,
  getWebhookEvent,
  listPaymentOperations,
  releaseDealLease,
  upsertWallet,
  type Db,
} from "@/lib/db";
import { paymentOperations, payments } from "@/lib/db/schema";
import { MAX_AMOUNT_MINOR, toPayPalValue } from "@/lib/domain/money";
import type { ScenarioId } from "@/lib/domain/scenarios";
import { DEFAULT_POLICY } from "@/lib/domain/schemas";
import type { DealStatus } from "@/lib/domain/status";
import { PaymentError, SimulatedProvider, idempotencyKey, type PaymentProvider } from "@/lib/payments";
import type { ServiceContext } from "@/lib/services/context";
import {
  DEMO_WALLET_OWNER,
  advanceAsSystem,
  advanceDeal,
  completePayPalApproval,
  createDeal,
  decideDeal,
  getDealView,
  handlePayPalWebhook,
} from "@/lib/services/deals";
import { DEMO_WALLET_LIMITS, committedSpendToday, demoWalletRefusal, updatePolicy, walletCommittedToday } from "@/lib/services/policy";
import { SYSTEM_OWNER, newSessionId } from "@/lib/services/session";
import { SWEEP_STALE_SECONDS, sweepStalledDeals } from "@/lib/services/sweep";

const START_MS = Date.parse("2026-10-06T05:00:00.000Z");
const APP_URL = "https://pact.test";
const HOUR_MS = 60 * 60 * 1000;

let db: Db;
let nowMs = START_MS;
let simulator: SimulatedProvider;
let ctx: ServiceContext;
const scripted = createAgents({ mode: "scripted" });
const now = (): Date => new Date(nowMs);

beforeAll(async () => {
  db = await createTestDb();
  simulator = new SimulatedProvider(createDbSimulatedStore(db), { now });
  ctx = { db, agents: scripted, provider: simulator, now };
});

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  nowMs = START_MS;
  // Each test starts with no shared wallet and nothing counted against one.
  await deleteWallet(db, DEMO_WALLET_OWNER);
  await db.update(payments).set({ walletOwner: null });
});

async function open(scenarioId: ScenarioId, session = newSessionId(), on: ServiceContext = ctx): Promise<{ session: string; dealId: string }> {
  const deal = await createDeal(on, { sessionId: session, clientKey: null }, { intent: "", scenarioId, tzOffsetMinutes: -540 });
  return { session, dealId: deal.id };
}

async function driveTo(session: string, dealId: string, target: DealStatus, on: ServiceContext = ctx): Promise<DealView> {
  for (let guard = 0; guard < 40; guard += 1) {
    const deal = await getDealView(on, session, dealId);
    if (deal.status === target) return deal;
    if (deal.status === "awaiting_approval") {
      await decideDeal(on, session, dealId, { kind: "approve_spend" });
    } else if (deal.status === "awaiting_payment") {
      await simulator.approve(deal.payment?.orderId ?? "");
      await completePayPalApproval(on, { dealId, orderId: deal.payment?.orderId ?? null });
    } else if (deal.next.kind === "auto") {
      await advanceDeal(on, session, dealId, APP_URL);
    } else {
      throw new Error(`deal stopped at ${deal.status} before reaching ${target}`);
    }
  }
  throw new Error(`deal did not reach ${target}`);
}

function providerWith(overrides: Partial<PaymentProvider>): PaymentProvider {
  const base: PaymentProvider = {
    kind: simulator.kind,
    supportsVault: simulator.supportsVault,
    createOrder: (input) => simulator.createOrder(input),
    getOrder: (orderId) => simulator.getOrder(orderId),
    authorizeOrder: (orderId, key) => simulator.authorizeOrder(orderId, key),
    getAuthorization: (authorizationId) => simulator.getAuthorization(authorizationId),
    captureAuthorization: (input) => simulator.captureAuthorization(input),
    voidAuthorization: (authorizationId, key) => simulator.voidAuthorization(authorizationId, key),
    reauthorize: (authorizationId, amountMinor, key) => simulator.reauthorize(authorizationId, amountMinor, key),
    createVaultSetup: (input) => simulator.createVaultSetup(input),
    exchangeVaultSetup: (setupTokenId, key) => simulator.exchangeVaultSetup(setupTokenId, key),
    verifyWebhook: (headers, rawBody) => simulator.verifyWebhook(headers, rawBody),
  };
  return { ...base, ...overrides };
}

const unreachable = (): never => {
  throw new PaymentError({ issue: "NETWORK_ERROR", message: "PayPal could not be reached", retryable: true });
};
const timedOut = (): never => {
  throw new PaymentError({ issue: "TIMEOUT", message: "PayPal did not answer in time", retryable: true });
};
const refused = (issue: string) => (): never => {
  throw new PaymentError({ issue, message: `PayPal refused: ${issue}`, httpStatus: 422, debugId: "dbg-test-1", retryable: false });
};

function events(deal: DealView, type: string): DealView["audit"] {
  return deal.audit.filter((event) => event.type === type);
}

async function ledger(dealId: string): Promise<string[]> {
  return (await listPaymentOperations(db, dealId)).map((operation) => `${operation.kind}:${operation.status}:${operation.attempts}`);
}

/** Connect a simulated vault wallet for `owner` and return its vault id. */
async function connectWallet(owner: string): Promise<string> {
  const setup = await simulator.createVaultSetup({
    returnUrl: `${APP_URL}/api/paypal/vault-return`,
    cancelUrl: `${APP_URL}/policies`,
    idempotencyKey: idempotencyKey("vault_setup", owner, String(Math.random())),
  });
  const token = await simulator.exchangeVaultSetup(setup.setupTokenId, idempotencyKey("vault_exchange", setup.setupTokenId));
  await upsertWallet(db, { owner, provider: simulator.kind, status: "active", setupTokenId: null, vaultId: token.vaultId, payerEmailMasked: null });
  return token.vaultId;
}

const MAXIMAL_POLICY = {
  ...DEFAULT_POLICY,
  autonomousLimitMinor: MAX_AMOUNT_MINOR,
  maxTransactionMinor: MAX_AMOUNT_MINOR,
  dailyLimitMinor: MAX_AMOUNT_MINOR,
  requireApprovalForNewSellers: false,
};

/* -------------------------------------------------------------------------- */
/*  Void                                                                       */
/* -------------------------------------------------------------------------- */

describe("releasing a rejected delivery's hold", () => {
  it("never gives up on a transient error: the deal stays 'rejecting' until PayPal answers", async () => {
    const { session, dealId } = await open("injection");
    await driveTo(session, dealId, "in_review");
    await decideDeal(ctx, session, dealId, { kind: "reject_delivery" });
    const offline: ServiceContext = { ...ctx, provider: providerWith({ voidAuthorization: timedOut }) };

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const stuck = await advanceDeal(offline, session, dealId, APP_URL);
      expect(stuck, `attempt ${attempt}`).toMatchObject({ executed: null, deal: { status: "rejecting", payment: { status: "authorized" } } });
    }
    expect(await ledger(dealId)).toContain("void:failed_retryable:6");

    const done = await advanceDeal(ctx, session, dealId, APP_URL);
    expect(done).toMatchObject({ executed: "void", deal: { status: "rejected", lastError: null, payment: { status: "voided", capturedMinor: 0 } } });
    expect(await committedSpendToday(db, session, now())).toBe(0);
  });

  it("a void PayPal refuses for good closes the deal with an audit line that names the hold", async () => {
    const { session, dealId } = await open("injection");
    await driveTo(session, dealId, "in_review");
    await decideDeal(ctx, session, dealId, { kind: "reject_delivery" });
    const before = await getDealView(ctx, session, dealId);
    const refusing: ServiceContext = { ...ctx, provider: providerWith({ voidAuthorization: refused("PERMISSION_DENIED") }) };

    const result = await advanceDeal(refusing, session, dealId, APP_URL);
    expect(result).toMatchObject({ executed: "void", deal: { status: "failed", payment: { status: "authorized" } } });
    const closing = result.deal.audit[result.deal.audit.length - 1];
    expect(closing).toMatchObject({
      type: "deal.failed",
      data: { issue: "PERMISSION_DENIED", holdRemains: true, authorizationId: before.payment?.authorizationId, authorizedMinor: 1800 },
    });
    expect(closing.title).toContain("still held");
    expect(result.deal.flags.auditChainValid).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Order                                                                      */
/* -------------------------------------------------------------------------- */

describe("giving up on an interactive order", () => {
  it("writes a deal-level audit event when the deal is closed", async () => {
    const { session, dealId } = await open("happy-path");
    const pending = await driveTo(session, dealId, "payment_pending");
    const offline: ServiceContext = { ...ctx, provider: providerWith({ createOrder: unreachable }) };

    for (let attempt = 1; attempt <= 3; attempt += 1) await advanceDeal(offline, session, dealId, APP_URL);
    const last = await advanceDeal(offline, session, dealId, APP_URL);
    expect(last).toMatchObject({ executed: "order", deal: { status: "failed", payment: { status: "none" } } });
    // One line for the stalled step, one for the deal being closed.
    expect(last.deal.audit).toHaveLength(pending.audit.length + 2);
    expect(last.deal.audit[last.deal.audit.length - 1]).toMatchObject({
      type: "deal.failed",
      data: { issue: "NETWORK_ERROR", holdRemains: false },
    });
  });
});

describe("a delegated order whose outcome is unknown", () => {
  /** PayPal creates and authorizes the order, and the answer never arrives. */
  function answerLost(): PaymentProvider {
    return providerWith({
      createOrder: async (input) => {
        await simulator.createOrder(input);
        return timedOut();
      },
    });
  }

  it("is never written off: the deal waits, the amount stays reserved, and the next answer adopts the hold", async () => {
    const session = newSessionId();
    await connectWallet(session);
    const { dealId } = await open("happy-path", session);
    await driveTo(session, dealId, "payment_pending");
    const lost: ServiceContext = { ...ctx, provider: answerLost() };

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const result = await advanceDeal(lost, session, dealId, APP_URL);
      expect(result, `attempt ${attempt}`).toMatchObject({ executed: null, busy: false, deal: { status: "payment_pending", payment: { status: "none", orderId: null } } });
    }
    const waiting = await getDealView(ctx, session, dealId);
    expect(waiting.lastError).toContain("not known yet");
    expect(waiting.next).toMatchObject({ kind: "auto", step: "order" });
    expect(await committedSpendToday(db, session, now())).toBe(4700);

    const adopted = await advanceDeal(ctx, session, dealId, APP_URL);
    expect(adopted).toMatchObject({ executed: "order", deal: { status: "authorized", lastError: null, payment: { status: "authorized", mode: "delegated", authorizedMinor: 4700 } } });
    expect(await ledger(dealId)).toEqual(["create_order:succeeded:7"]);
  });

  it("is closed with an explicit warning once PayPal no longer remembers the request id", async () => {
    const session = newSessionId();
    await connectWallet(session);
    const { dealId } = await open("happy-path", session);
    await driveTo(session, dealId, "payment_pending");
    const lost: ServiceContext = { ...ctx, provider: answerLost() };
    for (let attempt = 1; attempt <= 4; attempt += 1) await advanceDeal(lost, session, dealId, APP_URL);

    // The ledger stamps rows with the wall clock; five hours later a resend could open a second order.
    const longAgo = new Date(Date.now() - 6 * HOUR_MS).toISOString();
    await db.update(paymentOperations).set({ createdAt: longAgo }).where(eq(paymentOperations.dealId, dealId));
    let calls = 0;
    const counting: ServiceContext = {
      ...ctx,
      provider: providerWith({
        createOrder: async (input) => {
          calls += 1;
          return simulator.createOrder(input);
        },
      }),
    };

    const closed = await advanceDeal(counting, session, dealId, APP_URL);
    expect(calls).toBe(0);
    expect(closed).toMatchObject({ executed: "order", deal: { status: "failed", payment: { status: "none" } } });
    const closing = closed.deal.audit[closed.deal.audit.length - 1];
    expect(closing).toMatchObject({ type: "deal.failed", data: { holdUnknown: true, invoiceId: closed.deal.contract?.contract.contractId } });
    expect(closing.title).toContain("may exist");
    expect(closed.deal.flags.auditChainValid).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Capture                                                                    */
/* -------------------------------------------------------------------------- */

describe("a capture that executed but raised a terminal error", () => {
  it("is adopted from PayPal's authorization instead of closing the deal as 'nothing was captured'", async () => {
    const { session, dealId } = await open("happy-path");
    const verified = await driveTo(session, dealId, "verified");
    const garbled: ServiceContext = {
      ...ctx,
      provider: providerWith({
        captureAuthorization: async (input) => {
          await simulator.captureAuthorization(input);
          throw new PaymentError({ issue: "UNEXPECTED_RESPONSE", message: "PayPal's answer could not be read", httpStatus: 201, retryable: false });
        },
      }),
    };

    const result = await advanceDeal(garbled, session, dealId, APP_URL);
    expect(result).toMatchObject({ executed: "capture", deal: { status: "completed", payment: { status: "captured", capturedMinor: 4700 } } });
    expect(events(result.deal, "payment.voided")).toEqual([]);
    expect(result.deal.audit.map((event) => event.title).join("\n")).not.toContain("nothing was captured");
    expect((await simulator.getAuthorization(verified.payment?.authorizationId ?? "")).status).toBe("CAPTURED");
  });

  it("is adopted just the same when the unreadable answer is reported as 'outcome unknown'", async () => {
    const { session, dealId } = await open("happy-path");
    await driveTo(session, dealId, "verified");
    const garbled: ServiceContext = {
      ...ctx,
      provider: providerWith({
        captureAuthorization: async (input) => {
          await simulator.captureAuthorization(input);
          throw new PaymentError({ issue: "UNEXPECTED_RESPONSE", message: "PayPal's capture response did not have the expected shape", httpStatus: 201, retryable: true });
        },
      }),
    };

    const result = await advanceDeal(garbled, session, dealId, APP_URL);
    expect(result).toMatchObject({ executed: "capture", deal: { status: "completed", payment: { status: "captured", capturedMinor: 4700 } } });
  });

  it("captures when PayPal's authorization does not echo custom_id but its order vouches for it", async () => {
    const { session, dealId } = await open("happy-path");
    await driveTo(session, dealId, "verified");
    const silent: ServiceContext = {
      ...ctx,
      provider: providerWith({ getAuthorization: async (id) => ({ ...(await simulator.getAuthorization(id)), customId: null }) }),
    };

    const result = await advanceDeal(silent, session, dealId, APP_URL);
    expect(result).toMatchObject({ executed: "capture", deal: { status: "completed", payment: { status: "captured", capturedMinor: 4700 } } });
  });

  it("still blocks the capture when neither the authorization nor its order carries this contract's hash", async () => {
    const { session, dealId } = await open("happy-path");
    const verified = await driveTo(session, dealId, "verified");
    const unbound: ServiceContext = {
      ...ctx,
      provider: providerWith({
        getAuthorization: async (id) => ({ ...(await simulator.getAuthorization(id)), customId: null }),
        getOrder: async (id) => {
          const order = await simulator.getOrder(id);
          return { ...order, customId: null, authorization: order.authorization === null ? null : { ...order.authorization, customId: null } };
        },
      }),
    };

    const result = await advanceDeal(unbound, session, dealId, APP_URL);
    expect(result.deal).toMatchObject({ status: "failed", payment: { capturedMinor: 0 } });
    expect(events(result.deal, "payment.capture_blocked")).toHaveLength(1);
    expect((await simulator.getAuthorization(verified.payment?.authorizationId ?? "")).status).not.toBe("CAPTURED");
  });

  it("still fails the deal and releases the hold when PayPal really refused", async () => {
    const { session, dealId } = await open("happy-path");
    const verified = await driveTo(session, dealId, "verified");
    const refusing: ServiceContext = { ...ctx, provider: providerWith({ captureAuthorization: refused("PAYER_CANNOT_PAY") }) };

    const result = await advanceDeal(refusing, session, dealId, APP_URL);
    expect(result).toMatchObject({ executed: "capture", deal: { status: "failed", payment: { status: "voided", capturedMinor: 0 } } });
    expect((await simulator.getAuthorization(verified.payment?.authorizationId ?? "")).status).toBe("VOIDED");
    expect(result.deal.audit[result.deal.audit.length - 1]).toMatchObject({ type: "deal.failed", data: { holdRemains: false } });
  });
});

/* -------------------------------------------------------------------------- */
/*  Delegated wallet PayPal rejects                                            */
/* -------------------------------------------------------------------------- */

describe("a delegated wallet PayPal will not charge", () => {
  function rejectingVault(issue: string, calls: { interactive: number }): PaymentProvider {
    return providerWith({
      createOrder: async (input) => {
        if (input.vaultId !== undefined) return refused(issue)();
        calls.interactive += 1;
        return simulator.createOrder(input);
      },
    });
  }

  it("falls back to the payer's own approval, and retires a wallet whose token is dead", async () => {
    await connectWallet(DEMO_WALLET_OWNER);
    const calls = { interactive: 0 };
    const rejecting: ServiceContext = { ...ctx, provider: rejectingVault("INVALID_VAULT_ID", calls) };

    for (const round of [1, 2]) {
      const { session, dealId } = await open("happy-path", newSessionId(), rejecting);
      await driveTo(session, dealId, "payment_pending", rejecting);
      const result = await advanceDeal(rejecting, session, dealId, APP_URL);
      expect(result, `deal ${round}`).toMatchObject({
        executed: "order",
        deal: { status: "awaiting_payment", lastError: null, payment: { status: "created", mode: "interactive" }, next: { kind: "human" } },
      });
      expect(result.deal.payment?.approveUrl).toEqual(expect.any(String));
      expect(events(result.deal, "payment.failed")).toEqual([]);
      // The payer can finish the deal on their own account.
      const done = await driveTo(session, dealId, "completed", rejecting);
      expect(done.payment).toMatchObject({ status: "captured", capturedMinor: 4700 });
    }
    expect(calls.interactive).toBe(2);
    // The dead token is not offered to the next deal.
    expect(await getWallet(db, DEMO_WALLET_OWNER)).toBeNull();
  });

  it("keeps the shared wallet when the refusal is about this payment only", async () => {
    await connectWallet(DEMO_WALLET_OWNER);
    const calls = { interactive: 0 };
    const rejecting: ServiceContext = { ...ctx, provider: rejectingVault("INSTRUMENT_DECLINED", calls) };
    const { session, dealId } = await open("happy-path", newSessionId(), rejecting);
    await driveTo(session, dealId, "payment_pending", rejecting);

    const result = await advanceDeal(rejecting, session, dealId, APP_URL);
    expect(result).toMatchObject({ executed: "order", deal: { status: "awaiting_payment", payment: { mode: "interactive" } } });
    expect(events(result.deal, "system.degraded").map((event) => event.data)).toContainEqual(
      expect.objectContaining({ step: "order", reason: "INSTRUMENT_DECLINED" }),
    );
    expect((await getWallet(db, DEMO_WALLET_OWNER))?.status).toBe("active");
    // The fallback does not count against the shared wallet: the payer's own account pays.
    expect(await walletCommittedToday(db, DEMO_WALLET_OWNER, now())).toBe(0);
  });

  it("still fails a deal whose refusal has nothing to do with the wallet", async () => {
    await connectWallet(DEMO_WALLET_OWNER);
    const refusing: ServiceContext = { ...ctx, provider: providerWith({ createOrder: refused("PAYEE_ACCOUNT_RESTRICTED") }) };
    const { session, dealId } = await open("happy-path", newSessionId(), refusing);
    await driveTo(session, dealId, "payment_pending", refusing);

    const result = await advanceDeal(refusing, session, dealId, APP_URL);
    expect(result).toMatchObject({ executed: "order", deal: { status: "failed", payment: { status: "failed", mode: "delegated" } } });
    expect((await getWallet(db, DEMO_WALLET_OWNER))?.status).toBe("active");
  });
});

/* -------------------------------------------------------------------------- */
/*  Shared demo wallet                                                         */
/* -------------------------------------------------------------------------- */

describe("the shared demo wallet's own cap", () => {
  it("pays the scripted $180 scenario, whatever policy the visitor wrote", async () => {
    await connectWallet(DEMO_WALLET_OWNER);
    const session = newSessionId();
    await updatePolicy(ctx, session, MAXIMAL_POLICY);
    const { dealId } = await open("approval", session);

    const held = await driveTo(session, dealId, "authorized");
    expect(held.payment).toMatchObject({ mode: "delegated", authorizedMinor: 18_000 });
    expect(await walletCommittedToday(db, DEMO_WALLET_OWNER, now())).toBe(18_000);
  });

  it("refuses an order above its per-order cap and a total above its daily cap, whatever else is true", () => {
    const { perOrderMinor, dailyMinor } = DEMO_WALLET_LIMITS;
    // Room for the scripted $180 scenario, and far below what a visitor's policy may allow.
    expect(perOrderMinor).toBeGreaterThanOrEqual(18_000);
    expect(perOrderMinor).toBeLessThan(MAX_AMOUNT_MINOR);
    expect(demoWalletRefusal(perOrderMinor, 0)).toBeNull();
    expect(demoWalletRefusal(perOrderMinor + 1, 0)).toBe("demo_wallet_order_limit");
    expect(demoWalletRefusal(4700, dailyMinor - 4700)).toBeNull();
    expect(demoWalletRefusal(4700, dailyMinor - 4699)).toBe("demo_wallet_daily_limit");
  });

  it("stops paying once the wallet-wide daily total is committed, across sessions", async () => {
    await connectWallet(DEMO_WALLET_OWNER);
    const first = newSessionId();
    await updatePolicy(ctx, first, MAXIMAL_POLICY);
    const one = await open("approval", first);
    await driveTo(first, one.dealId, "authorized");
    // Stand in for a day of visitors: the first hold is counted as nearly the whole daily budget.
    const nearlyAll = DEMO_WALLET_LIMITS.dailyMinor - 10_000;
    await db.update(payments).set({ authorizedMinor: nearlyAll }).where(eq(payments.dealId, one.dealId));
    expect(await walletCommittedToday(db, DEMO_WALLET_OWNER, now())).toBe(nearlyAll);

    // A fresh cookie has a fresh per-session total, but the wallet's own total is shared.
    const second = newSessionId();
    await updatePolicy(ctx, second, MAXIMAL_POLICY);
    const two = await open("approval", second);
    const gate = await driveTo(second, two.dealId, "awaiting_payment");
    expect(gate.payment).toMatchObject({ mode: "interactive", status: "created", authorizedMinor: 0 });
    expect(events(gate, "system.degraded").map((event) => event.data)).toContainEqual(
      expect.objectContaining({ step: "order", reason: "demo_wallet_daily_limit" }),
    );
    expect(await walletCommittedToday(db, DEMO_WALLET_OWNER, now())).toBe(nearlyAll);

    // A small order still fits.
    const third = newSessionId();
    const three = await open("happy-path", third);
    const held = await driveTo(third, three.dealId, "authorized");
    expect(held.payment).toMatchObject({ mode: "delegated", authorizedMinor: 4700 });
  });

  it("does not limit a session's own wallet", async () => {
    await connectWallet(DEMO_WALLET_OWNER);
    const session = newSessionId();
    await connectWallet(session);
    await updatePolicy(ctx, session, MAXIMAL_POLICY);
    const { dealId } = await open("approval", session);
    const held = await driveTo(session, dealId, "authorized");
    expect(held.payment).toMatchObject({ mode: "delegated", authorizedMinor: 18_000 });
    expect(await walletCommittedToday(db, DEMO_WALLET_OWNER, now())).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Settlement without the payer's browser                                     */
/* -------------------------------------------------------------------------- */

describe("the system driver", () => {
  it("settles a delivered deal nobody is advancing, one step per run", async () => {
    // Deals other tests left behind in this database are swept along; the limit makes room for them.
    const all = { limit: 50 };
    const { session, dealId } = await open("happy-path");
    await driveTo(session, dealId, "submitted");
    // Fresh deals belong to the tab that is driving them.
    expect((await sweepStalledDeals(ctx, APP_URL, all)).advanced.map((entry) => entry.dealId)).not.toContain(dealId);

    nowMs += (SWEEP_STALE_SECONDS + 1) * 1000;
    const verify = await sweepStalledDeals(ctx, APP_URL, all);
    expect(verify.advanced).toContainEqual({ dealId, executed: "verify", status: "verified" });
    // The step it just ran makes the deal fresh again; the next run comes later.
    expect((await sweepStalledDeals(ctx, APP_URL, all)).advanced.map((entry) => entry.dealId)).not.toContain(dealId);

    nowMs += (SWEEP_STALE_SECONDS + 1) * 1000;
    const capture = await sweepStalledDeals(ctx, APP_URL, all);
    expect(capture.advanced).toContainEqual({ dealId, executed: "capture", status: "completed" });
    const done = await getDealView(ctx, session, dealId);
    expect(done).toMatchObject({ status: "completed", payment: { status: "captured", capturedMinor: 4700 } });
    expect(done.flags.auditChainValid).toBe(true);
  });

  it("releases a rejected delivery's hold, and never touches a deal that waits for a human or has not been paid for", async () => {
    const rejecting = await open("injection");
    await driveTo(rejecting.session, rejecting.dealId, "in_review");
    const reviewing = await open("injection");
    await driveTo(reviewing.session, reviewing.dealId, "in_review");
    const unpaid = await open("happy-path");
    await driveTo(unpaid.session, unpaid.dealId, "payment_pending");
    const negotiating = await open("happy-path");
    await decideDeal(ctx, rejecting.session, rejecting.dealId, { kind: "reject_delivery" });

    nowMs += (SWEEP_STALE_SECONDS + 1) * 1000;
    const run = await sweepStalledDeals(ctx, APP_URL, { limit: 50 });
    const touched = run.advanced.map((entry) => entry.dealId);
    expect(run.advanced).toContainEqual({ dealId: rejecting.dealId, executed: "void", status: "rejected" });
    expect(touched).not.toContain(reviewing.dealId);
    expect(touched).not.toContain(unpaid.dealId);
    expect(touched).not.toContain(negotiating.dealId);
    expect((await getDealView(ctx, null, unpaid.dealId)).status).toBe("payment_pending");
  });

  it("is bounded per run and yields to a step that is already running", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const { session, dealId } = await open("happy-path");
      await driveTo(session, dealId, "submitted");
      ids.push(dealId);
    }
    nowMs += (SWEEP_STALE_SECONDS + 1) * 1000;
    // Another request is in the middle of the first deal's step.
    await acquireDealLease(db, ids[0], "step_in_flight", 120, now());

    const one = await sweepStalledDeals(ctx, APP_URL, { limit: 1 });
    expect(one.examined).toBe(1);
    expect(one.advanced).toHaveLength(1);
    const rest = await sweepStalledDeals(ctx, APP_URL, { limit: 50 });
    expect([...one.advanced, ...rest.advanced].map((entry) => entry.dealId)).not.toContain(ids[0]);
    expect((await getDealView(ctx, null, ids[0])).status).toBe("submitted");
    await releaseDealLease(db, ids[0], "step_in_flight");
  });

  it("advanceAsSystem needs no session, and changes nothing at a human gate", async () => {
    const { session, dealId } = await open("happy-path");
    const waiting = await driveTo(session, dealId, "awaiting_payment");
    expect(await advanceAsSystem(ctx, dealId, APP_URL)).toMatchObject({ executed: null, busy: false, deal: { status: "awaiting_payment" } });
    expect((await getDealView(ctx, session, dealId)).audit).toEqual(waiting.audit);
    // The owner-only rule of the public entry point is untouched.
    await expect(advanceDeal(ctx, newSessionId(), dealId, APP_URL)).rejects.toMatchObject({ status: 403 });
    await expect(advanceDeal(ctx, SYSTEM_OWNER, dealId, APP_URL)).rejects.toMatchObject({ status: 403 });
    expect((await getPayment(db, dealId))?.status).toBe("created");
  });
});

/* -------------------------------------------------------------------------- */
/*  Returns and webhooks                                                       */
/* -------------------------------------------------------------------------- */

describe("an authorization PayPal granted but answered unreadably", () => {
  it("is not booked as a refusal: the deal keeps waiting and the next return adopts the hold", async () => {
    const { session, dealId } = await open("happy-path");
    const waiting = await driveTo(session, dealId, "awaiting_payment");
    const orderId = waiting.payment?.orderId ?? "";
    await simulator.approve(orderId);
    const garbled: ServiceContext = {
      ...ctx,
      provider: providerWith({
        authorizeOrder: async (id, key) => {
          await simulator.authorizeOrder(id, key);
          throw new PaymentError({ issue: "UNEXPECTED_RESPONSE", message: "PayPal's authorize order response did not have the expected shape", httpStatus: 201, retryable: true });
        },
      }),
    };

    expect((await completePayPalApproval(garbled, { dealId, orderId })).outcome).toBe("pending");
    const between = await getDealView(ctx, session, dealId);
    expect(between).toMatchObject({ status: "awaiting_payment", payment: { status: "approved" } });
    expect(events(between, "payment.failed")).toEqual([]);

    expect((await completePayPalApproval(ctx, { dealId, orderId })).outcome).toBe("authorized");
    expect(await getDealView(ctx, session, dealId)).toMatchObject({ status: "authorized", payment: { status: "authorized", authorizedMinor: 4700 } });
  });
});

describe("a return that names another order", () => {
  it("leaves no trace on a finished deal or on a showcase deal", async () => {
    const { session, dealId } = await open("happy-path");
    const done = await driveTo(session, dealId, "completed");
    const showcase = await open("happy-path", SYSTEM_OWNER);
    const waiting = await driveTo(SYSTEM_OWNER, showcase.dealId, "awaiting_payment");

    expect(await completePayPalApproval(ctx, { dealId, orderId: "NOT-THIS-ORDER" })).toEqual({ dealId, outcome: "failed" });
    expect(await completePayPalApproval(ctx, { dealId: showcase.dealId, orderId: "NOT-THIS-ORDER" })).toEqual({ dealId: showcase.dealId, outcome: "failed" });
    expect((await getDealView(ctx, session, dealId)).audit).toEqual(done.audit);
    expect((await getDealView(ctx, null, showcase.dealId)).audit).toEqual(waiting.audit);
  });

  it("is noted once on a waiting deal, however many arrive at the same moment", async () => {
    const { session, dealId } = await open("happy-path");
    const waiting = await driveTo(session, dealId, "awaiting_payment");

    const outcomes = await Promise.all(Array.from({ length: 8 }, () => completePayPalApproval(ctx, { dealId, orderId: "NOT-THIS-ORDER" })));
    expect(outcomes.every((entry) => entry.outcome === "failed")).toBe(true);
    await completePayPalApproval(ctx, { dealId, orderId: "NOT-THIS-ORDER" });
    const after = await getDealView(ctx, session, dealId);
    expect(after.audit).toHaveLength(waiting.audit.length + 1);
    expect(after.audit[after.audit.length - 1]).toMatchObject({ type: "system.error", title: expect.stringContaining("named a different order") });
    expect(after.flags.auditChainValid).toBe(true);
  });
});

describe("verified webhooks", () => {
  const SIGNATURE_HEADER = "x-test-signature";
  let eventCounter = 0;
  const eventId = (): string => `WH-RECOVERY-${(eventCounter += 1).toString().padStart(6, "0")}`;
  const amount = (minor: number) => ({ currency_code: "USD", value: toPayPalValue(minor) });

  /** The simulator behind a signature check that accepts one test header. */
  function verifying(overrides: Partial<PaymentProvider> = {}): ServiceContext {
    return {
      ...ctx,
      provider: providerWith({
        verifyWebhook: async (headers) =>
          headers.get(SIGNATURE_HEADER) === "valid"
            ? { verified: true, method: "simulated", reason: null }
            : { verified: false, method: "simulated", reason: "bad_signature" },
        ...overrides,
      }),
    };
  }

  function deliver(payload: unknown, on: ServiceContext) {
    nowMs += 2_000;
    return handlePayPalWebhook(on, new Headers({ [SIGNATURE_HEADER]: "valid" }), JSON.stringify(payload));
  }

  it("are stored without the payer's name, e-mail address or payer id", async () => {
    const event = {
      id: eventId(),
      event_type: "CHECKOUT.ORDER.APPROVED",
      resource_type: "checkout-order",
      create_time: "2026-10-06T05:00:00Z",
      resource: {
        id: "5O190127TN364715T",
        status: "APPROVED",
        intent: "AUTHORIZE",
        payer: { name: { given_name: "Jane", surname: "Buyer" }, email_address: "jane.buyer@personal.example.com", payer_id: "QYR5Z8XDVJNXQ" },
        payment_source: { paypal: { email_address: "jane.buyer@personal.example.com", account_id: "QYR5Z8XDVJNXQ" } },
        purchase_units: [{ reference_id: "deal_x", amount: amount(4700), custom_id: `pact:v1:${"a".repeat(64)}`, invoice_id: "ctr_unknown", payee: { email_address: "seller@business.example.com" } }],
        links: [{ rel: "self", href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/5O190127TN364715T", method: "GET" }],
      },
    };
    expect(await deliver(event, verifying())).toEqual({ accepted: true, duplicate: false, reason: "no_matching_deal" });

    const stored = await getWebhookEvent(db, event.id);
    const text = JSON.stringify(stored?.payload);
    expect(text).not.toContain("@");
    expect(text).not.toMatch(/payer|Jane|Buyer|QYR5Z8XDVJNXQ|email_address/);
    // What interpretation reads is still there for whoever investigates the row.
    expect(stored?.payload).toMatchObject({
      id: event.id,
      event_type: "CHECKOUT.ORDER.APPROVED",
      resource: { id: "5O190127TN364715T", status: "APPROVED", purchase_units: [{ amount: amount(4700), invoice_id: "ctr_unknown" }] },
    });
  });

  it("do not record a hold for an authorization PayPal is still reviewing", async () => {
    const { session, dealId } = await open("happy-path");
    const waiting = await driveTo(session, dealId, "awaiting_payment");
    const pending = {
      id: eventId(),
      event_type: "PAYMENT.AUTHORIZATION.CREATED",
      resource: {
        id: "AUTH-PENDING-1",
        status: "PENDING",
        status_details: { reason: "PENDING_REVIEW" },
        amount: amount(4700),
        supplementary_data: { related_ids: { order_id: waiting.payment?.orderId } },
      },
    };

    expect(await deliver(pending, verifying())).toEqual({ accepted: true, duplicate: false, reason: null });
    const after = await getDealView(ctx, session, dealId);
    expect(after).toMatchObject({ status: "awaiting_payment", payment: { status: "created", authorizationId: null, authorizedMinor: 0 } });
    expect(events(after, "payment.authorized")).toEqual([]);
    expect(after.audit[after.audit.length - 1]).toMatchObject({ type: "payment.webhook", title: expect.stringContaining("no funds are held yet") });
    expect(after.next).toMatchObject({ kind: "human" });
  });

  it("record when a webhook-adopted authorization expires", async () => {
    const { session, dealId } = await open("happy-path");
    const waiting = await driveTo(session, dealId, "awaiting_payment");
    const orderId = waiting.payment?.orderId ?? "";
    await simulator.approve(orderId);
    const authorized = await simulator.authorizeOrder(orderId, idempotencyKey("authorize", dealId, orderId));
    const created = {
      id: eventId(),
      event_type: "PAYMENT.AUTHORIZATION.CREATED",
      resource: {
        id: authorized.authorization?.authorizationId,
        status: "CREATED",
        amount: amount(4700),
        expiration_time: "2026-11-04T05:00:00Z",
        supplementary_data: { related_ids: { order_id: orderId } },
      },
    };

    expect(await deliver(created, verifying())).toEqual({ accepted: true, duplicate: false, reason: null });
    expect(await getDealView(ctx, session, dealId)).toMatchObject({
      status: "authorized",
      payment: { status: "authorized", authorizedMinor: 4700, authorizationExpiresAt: "2026-11-04T05:00:00.000Z" },
    });
  });

  describe("for a delegated order PACT never heard back about", () => {
    async function orphan(): Promise<{ session: string; dealId: string; event: Record<string, unknown>; authorizationId: string }> {
      const session = newSessionId();
      await connectWallet(session);
      const { dealId } = await open("happy-path", session);
      const pending = await driveTo(session, dealId, "payment_pending");
      let orderId = "";
      let authorizationId = "";
      const lost: ServiceContext = {
        ...ctx,
        provider: providerWith({
          createOrder: async (input) => {
            const order = await simulator.createOrder(input);
            orderId = order.orderId;
            authorizationId = order.authorization?.authorizationId ?? "";
            return timedOut();
          },
        }),
      };
      await advanceDeal(lost, session, dealId, APP_URL);
      const signed = pending.contract;
      const event = {
        id: eventId(),
        event_type: "PAYMENT.AUTHORIZATION.CREATED",
        resource: {
          id: authorizationId,
          status: "CREATED",
          amount: amount(4700),
          custom_id: `pact:v1:${signed?.termsHash}`,
          invoice_id: signed?.contract.contractId,
          supplementary_data: { related_ids: { order_id: orderId } },
        },
      };
      return { session, dealId, event, authorizationId };
    }

    it("find the deal through the contract binding and adopt the hold", async () => {
      const { session, dealId, event, authorizationId } = await orphan();

      expect(await deliver(event, verifying())).toEqual({ accepted: true, duplicate: false, reason: null });
      const after = await getDealView(ctx, session, dealId);
      expect(after).toMatchObject({
        status: "authorized",
        lastError: null,
        payment: { status: "authorized", authorizationId, authorizedMinor: 4700, webhookConfirmed: { authorized: true } },
      });
      expect(await getWebhookEvent(db, String(event.id))).toMatchObject({ processed: true, dealId });
      // The deal carries on from the hold like any other.
      expect((await driveTo(session, dealId, "completed")).payment).toMatchObject({ status: "captured", capturedMinor: 4700 });
    });

    it("ignore an event that quotes the contract id with someone else's terms hash", async () => {
      const { session, dealId, event } = await orphan();
      const resource = event.resource as Record<string, unknown>;
      const forged = { ...event, resource: { ...resource, custom_id: `pact:v1:${"0".repeat(64)}` } };

      expect(await deliver(forged, verifying())).toEqual({ accepted: true, duplicate: false, reason: "no_matching_deal" });
      expect(await getDealView(ctx, session, dealId)).toMatchObject({ status: "payment_pending", payment: { status: "none" } });
    });

    it("release the hold when the deal had already been closed", async () => {
      const { session, dealId, event, authorizationId } = await orphan();
      // The replay window passed without an answer, so the deal was closed with a warning.
      const longAgo = new Date(Date.now() - 6 * HOUR_MS).toISOString();
      await db.update(paymentOperations).set({ createdAt: longAgo }).where(eq(paymentOperations.dealId, dealId));
      expect(await advanceDeal(ctx, session, dealId, APP_URL)).toMatchObject({ deal: { status: "failed", payment: { status: "none" } } });

      expect(await deliver(event, verifying())).toEqual({ accepted: true, duplicate: false, reason: null });
      const after = await getDealView(ctx, session, dealId);
      expect(after).toMatchObject({ status: "failed", payment: { status: "voided", authorizationId, capturedMinor: 0 } });
      expect((await simulator.getAuthorization(authorizationId)).status).toBe("VOIDED");
      expect(events(after, "payment.voided")).toHaveLength(1);
      expect(after.flags.auditChainValid).toBe(true);
    });
  });
});
