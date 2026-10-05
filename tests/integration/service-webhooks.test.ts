/**
 * PayPal webhooks through the service: an event that does not verify changes nothing, a
 * verified one is applied exactly once, and what PayPal reports about a hold moves the deal
 * the same way whoever learned it.
 *
 * The simulator never sends (or verifies) webhooks, so the verified path is exercised with a
 * provider whose signature check accepts one test header and nothing else.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgents } from "@/lib/ai";
import type { DealView } from "@/lib/api/dto";
import {
  acquireDealLease,
  closeDb,
  createDbSimulatedStore,
  createTestDb,
  getWebhookEvent,
  listPaymentOperations,
  releaseDealLease,
  type Db,
} from "@/lib/db";
import { toPayPalValue } from "@/lib/domain/money";
import type { ScenarioId } from "@/lib/domain/scenarios";
import type { DealStatus } from "@/lib/domain/status";
import { PaymentError, SimulatedProvider, idempotencyKey, type PaymentProvider } from "@/lib/payments";
import type { ServiceContext } from "@/lib/services/context";
import { advanceDeal, completePayPalApproval, createDeal, decideDeal, getDealView, handlePayPalWebhook } from "@/lib/services/deals";
import { committedSpendToday } from "@/lib/services/policy";
import { newSessionId } from "@/lib/services/session";

const START_MS = Date.parse("2026-10-06T05:00:00.000Z");
const APP_URL = "https://pact.test";
const SIGNATURE_HEADER = "x-test-signature";

let db: Db;
let nowMs = START_MS;
let simulator: SimulatedProvider;
/** The simulator behind a signature check that accepts the test header. */
let ctx: ServiceContext;
const now = (): Date => new Date(nowMs);

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
    verifyWebhook: async (headers) =>
      headers.get(SIGNATURE_HEADER) === "valid"
        ? { verified: true, method: "simulated", reason: null }
        : { verified: false, method: "simulated", reason: "bad_signature" },
  };
  return { ...base, ...overrides };
}

beforeAll(async () => {
  db = await createTestDb();
  simulator = new SimulatedProvider(createDbSimulatedStore(db), { now });
  ctx = { db, agents: createAgents({ mode: "scripted" }), provider: providerWith({}), now };
});

afterAll(async () => {
  await closeDb(db);
});

beforeEach(() => {
  nowMs = START_MS;
});

async function open(scenarioId: ScenarioId): Promise<{ session: string; dealId: string }> {
  const session = newSessionId();
  const deal = await createDeal(ctx, { sessionId: session, clientKey: null }, { intent: "", scenarioId, tzOffsetMinutes: -540 });
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

/* ------------------------------ PayPal payloads ----------------------------- */

let eventCounter = 0;
function eventId(): string {
  eventCounter += 1;
  return `WH-TEST-${eventCounter.toString().padStart(6, "0")}`;
}

function amount(minor: number): { currency_code: string; value: string } {
  return { currency_code: "USD", value: toPayPalValue(minor) };
}

function captureEvent(type: "COMPLETED" | "DENIED", deal: DealView, options: { id?: string; captureId?: string; amountMinor?: number } = {}) {
  return {
    id: options.id ?? eventId(),
    event_type: `PAYMENT.CAPTURE.${type}`,
    resource: {
      id: options.captureId ?? deal.payment?.captureId ?? "SIM-C-UNKNOWN",
      status: type,
      amount: amount(options.amountMinor ?? deal.payment?.amountMinor ?? 0),
      final_capture: true,
      supplementary_data: { related_ids: { order_id: deal.payment?.orderId, authorization_id: deal.payment?.authorizationId } },
    },
  };
}

function authorizationEvent(type: "CREATED" | "VOIDED", orderId: string, authorizationId: string, amountMinor: number, id = eventId()) {
  return {
    id,
    event_type: `PAYMENT.AUTHORIZATION.${type}`,
    resource: { id: authorizationId, status: type, amount: amount(amountMinor), supplementary_data: { related_ids: { order_id: orderId } } },
  };
}

function deliver(payload: unknown, options: { signed?: boolean; on?: ServiceContext } = {}) {
  nowMs += 2_000;
  const headers = new Headers(options.signed === false ? {} : { [SIGNATURE_HEADER]: "valid" });
  return handlePayPalWebhook(options.on ?? ctx, headers, typeof payload === "string" ? payload : JSON.stringify(payload));
}

function types(deal: DealView, from: number): string[] {
  return deal.audit.slice(from).map((event) => event.type);
}

/* -------------------------------------------------------------------------- */

describe("unverified webhooks", () => {
  it("change nothing and write nothing, whatever they claim", async () => {
    const { session, dealId } = await open("happy-path");
    const before = await driveTo(session, dealId, "authorized");
    const forged = captureEvent("COMPLETED", before, { captureId: "SIM-C-FORGED" });

    expect(await deliver(forged, { signed: false })).toEqual({ accepted: false, duplicate: false, reason: "bad_signature" });
    // The simulator itself never accepts a webhook: nothing that claims to be one can be genuine.
    const plain: ServiceContext = { ...ctx, provider: simulator };
    expect(await deliver(forged, { on: plain })).toEqual({ accepted: false, duplicate: false, reason: "simulated_provider" });

    expect(await getWebhookEvent(db, forged.id)).toBeNull();
    const after = await getDealView(ctx, session, dealId);
    expect(after.payment).toEqual(before.payment);
    expect(after.audit).toEqual(before.audit);
    expect(after.status).toBe("authorized");
  });

  it("are rejected when the signature check itself cannot be completed", async () => {
    const failing: ServiceContext = {
      ...ctx,
      provider: providerWith({
        verifyWebhook: async () => {
          throw new PaymentError({ issue: "CERT_FETCH_FAILED", message: "certificate unavailable", retryable: true });
        },
      }),
    };
    expect(await deliver({ id: "WH-NEVER-STORED", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "X" } }, { on: failing })).toEqual({
      accepted: false,
      duplicate: false,
      reason: "verification_unavailable:CERT_FETCH_FAILED",
    });
    expect(await getWebhookEvent(db, "WH-NEVER-STORED")).toBeNull();
  });
});

describe("verified webhooks", () => {
  it("confirm a capture once: a redelivery is recognised and does no further work", async () => {
    const { session, dealId } = await open("happy-path");
    const done = await driveTo(session, dealId, "completed");
    expect(done.payment?.webhookConfirmed).toEqual({ authorized: false, captured: false, voided: false });
    const event = captureEvent("COMPLETED", done);

    expect(await deliver(event)).toEqual({ accepted: true, duplicate: false, reason: null });
    const confirmed = await getDealView(ctx, session, dealId);
    expect(confirmed.payment).toMatchObject({ status: "captured", capturedMinor: 4700, webhookConfirmed: { authorized: false, captured: true, voided: false } });
    expect(types(confirmed, done.audit.length)).toEqual(["payment.webhook"]);
    expect(confirmed.audit[confirmed.audit.length - 1].data).toMatchObject({ eventId: event.id, confirmed: "captured" });
    expect(await getWebhookEvent(db, event.id)).toMatchObject({ processed: true, dealId, verified: true, eventType: "PAYMENT.CAPTURE.COMPLETED" });

    // PayPal redelivers until it gets a 2xx; the second delivery must be a no-op.
    expect(await deliver(event)).toEqual({ accepted: true, duplicate: true, reason: null });
    expect(await deliver(event)).toEqual({ accepted: true, duplicate: true, reason: null });
    const after = await getDealView(ctx, session, dealId);
    expect(after.audit).toEqual(confirmed.audit);
    expect(after.payment).toEqual(confirmed.payment);
    expect(after.flags.auditChainValid).toBe(true);
  });

  it("leave a trace and apply nothing when the event contradicts the record", async () => {
    const { session, dealId } = await open("happy-path");
    const done = await driveTo(session, dealId, "completed");

    expect(await deliver(captureEvent("COMPLETED", done, { amountMinor: 9900 }))).toEqual({ accepted: true, duplicate: false, reason: null });
    const after = await getDealView(ctx, session, dealId);
    expect(after.payment).toEqual(done.payment);
    expect(after.audit[after.audit.length - 1]).toMatchObject({ type: "payment.webhook", data: { mismatch: true, amountMinor: 9900 } });
  });

  it("acknowledge events that are not about any deal, or not acted on, without touching anything", async () => {
    const unknown = authorizationEvent("VOIDED", "5O190127TN364715T", "0VF52814937998046", 1000);
    expect(await deliver(unknown)).toEqual({ accepted: true, duplicate: false, reason: "no_matching_deal" });
    expect(await getWebhookEvent(db, unknown.id)).toMatchObject({ processed: true, dealId: null });

    const other = { id: eventId(), event_type: "BILLING.SUBSCRIPTION.CREATED", resource: { id: "I-BW452GLLEP1G" } };
    expect(await deliver(other)).toEqual({ accepted: true, duplicate: false, reason: "ignored" });
    expect(await deliver(other)).toEqual({ accepted: true, duplicate: true, reason: null });
  });

  it("reject a verified body that is not a usable event", async () => {
    expect(await deliver("{ not json")).toMatchObject({ accepted: false, reason: "invalid_json" });
    expect(await deliver(JSON.stringify(["an", "array"]))).toMatchObject({ accepted: false, reason: "invalid_json" });
    expect(await deliver({ event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "X" } })).toMatchObject({ accepted: false, reason: "missing_event_id" });
  });

  it("are not acknowledged while the deal is in the middle of a step, and are applied on redelivery", async () => {
    const { session, dealId } = await open("happy-path");
    const done = await driveTo(session, dealId, "completed");
    const event = captureEvent("COMPLETED", done);
    await acquireDealLease(db, dealId, "step_in-flight", 120, now());

    // Not acknowledged, so PayPal delivers it again; recorded, but not marked processed.
    expect(await deliver(event)).toEqual({ accepted: false, duplicate: false, reason: "busy" });
    expect(await getWebhookEvent(db, event.id)).toMatchObject({ processed: false });
    expect((await getDealView(ctx, session, dealId)).payment?.webhookConfirmed.captured).toBe(false);

    await releaseDealLease(db, dealId, "step_in-flight");
    expect(await deliver(event)).toEqual({ accepted: true, duplicate: false, reason: null });
    expect((await getDealView(ctx, session, dealId)).payment?.webhookConfirmed.captured).toBe(true);
    expect(await getWebhookEvent(db, event.id)).toMatchObject({ processed: true, dealId });
  });
});

describe("what PayPal reports about the hold moves the deal", () => {
  it("a hold voided at PayPal while the seller is working ends the deal as expired", async () => {
    const { session, dealId } = await open("happy-path");
    const authorized = await driveTo(session, dealId, "authorized");
    const { orderId, authorizationId } = authorized.payment ?? {};
    expect(await committedSpendToday(db, session, now())).toBe(4700);

    const event = authorizationEvent("VOIDED", orderId ?? "", authorizationId ?? "", 4700);
    expect(await deliver(event)).toEqual({ accepted: true, duplicate: false, reason: null });

    const after = await getDealView(ctx, session, dealId);
    expect(after).toMatchObject({
      status: "expired",
      next: { kind: "done", label: "Expired" },
      payment: { status: "voided", capturedMinor: 0, webhookConfirmed: { voided: true } },
    });
    expect(types(after, authorized.audit.length)).toEqual(["payment.webhook", "payment.voided", "deal.expired"]);
    expect(after.audit[after.audit.length - 1]).toMatchObject({
      actor: "system",
      title: "Deal expired: Simulated PayPal no longer holds the funds, so nothing can be captured",
    });
    expect(after.flags.auditChainValid).toBe(true);
    expect(await committedSpendToday(db, session, now())).toBe(0);
    // Nothing is left to run, and the redelivery changes nothing.
    expect(await advanceDeal(ctx, session, dealId, APP_URL)).toMatchObject({ executed: null, busy: false, deal: { status: "expired" } });
    expect(await deliver(event)).toMatchObject({ duplicate: true });
    expect((await getDealView(ctx, session, dealId)).audit).toEqual(after.audit);
  });

  it("reports an authorization that ran out of time as expired, with the same deal outcome", async () => {
    const { session, dealId } = await open("happy-path");
    const authorized = await driveTo(session, dealId, "authorized");
    nowMs = START_MS + 30 * 24 * 60 * 60 * 1000;

    await deliver(authorizationEvent("VOIDED", authorized.payment?.orderId ?? "", authorized.payment?.authorizationId ?? "", 4700));
    const after = await getDealView(ctx, session, dealId);
    expect(after).toMatchObject({ status: "expired", payment: { status: "expired" } });
    expect(types(after, authorized.audit.length)).toEqual(["payment.webhook", "payment.expired", "deal.expired"]);
  });

  it("a hold voided while a human is reviewing closes the gate at once: the deal expires and no release can capture", async () => {
    const { session, dealId } = await open("injection");
    const review = await driveTo(session, dealId, "in_review");
    await deliver(authorizationEvent("VOIDED", review.payment?.orderId ?? "", review.payment?.authorizationId ?? "", 1800));

    const after = await getDealView(ctx, session, dealId);
    expect(after).toMatchObject({ status: "expired", next: { kind: "done" }, payment: { status: "voided", capturedMinor: 0 } });
    expect(types(after, review.audit.length)).toEqual(["payment.webhook", "payment.voided", "deal.expired"]);

    // The gate is gone with the hold: a release is refused, and nothing is ever sent for a capture.
    await expect(decideDeal(ctx, session, dealId, { kind: "release_payment" })).rejects.toMatchObject({ status: 409 });
    expect(await advanceDeal(ctx, session, dealId, APP_URL)).toMatchObject({ executed: null, busy: false, deal: { status: "expired" } });
    expect((await listPaymentOperations(db, dealId)).some((operation) => operation.kind === "capture")).toBe(false);
  });

  it("a hold voided while the delivery waits for verification ends the deal before a verifier is asked", async () => {
    const { session, dealId } = await open("happy-path");
    const submitted = await driveTo(session, dealId, "submitted");
    await deliver(authorizationEvent("VOIDED", submitted.payment?.orderId ?? "", submitted.payment?.authorizationId ?? "", 4700));

    const after = await getDealView(ctx, session, dealId);
    expect(after).toMatchObject({ status: "expired", reports: [], payment: { status: "voided", capturedMinor: 0 } });
    expect(await advanceDeal(ctx, session, dealId, APP_URL)).toMatchObject({ executed: null, busy: false, deal: { status: "expired", reports: [] } });
  });

  it("a rejected delivery whose hold PayPal already released is closed without another PayPal call", async () => {
    const { session, dealId } = await open("injection");
    const review = await driveTo(session, dealId, "in_review");
    // The rejection is decided first; PayPal's own release arrives before PACT's void step runs.
    await decideDeal(ctx, session, dealId, { kind: "reject_delivery" });
    await deliver(authorizationEvent("VOIDED", review.payment?.orderId ?? "", review.payment?.authorizationId ?? "", 1800));
    expect(await getDealView(ctx, session, dealId)).toMatchObject({ status: "rejecting", payment: { status: "voided" } });

    const result = await advanceDeal(ctx, session, dealId, APP_URL);
    expect(result).toMatchObject({ executed: "void", deal: { status: "rejected", payment: { status: "voided" } } });
    expect((await listPaymentOperations(db, dealId)).some((operation) => operation.kind === "void")).toBe(false);
  });

  it("completes the deal when PayPal settles a capture that was pending", async () => {
    const { session, dealId } = await open("happy-path");
    await driveTo(session, dealId, "verified");
    const pendingFirst: ServiceContext = {
      ...ctx,
      provider: providerWith({
        captureAuthorization: async (input) => ({ ...(await simulator.captureAuthorization(input)), status: "PENDING" }),
      }),
    };
    const pending = (await advanceDeal(pendingFirst, session, dealId, APP_URL)).deal;
    expect(pending).toMatchObject({ status: "verified", payment: { status: "authorized", capturedMinor: 0 } });
    expect(pending.payment?.captureId).toMatch(/^SIM-C-/);

    expect(await deliver(captureEvent("COMPLETED", pending))).toEqual({ accepted: true, duplicate: false, reason: null });
    const done = await getDealView(ctx, session, dealId);
    expect(done).toMatchObject({
      status: "completed",
      lastError: null,
      payment: { status: "captured", capturedMinor: 4700, lastError: null, webhookConfirmed: { captured: true } },
    });
    expect(types(done, pending.audit.length)).toEqual(["payment.webhook", "payment.captured", "deal.completed"]);
    expect(await advanceDeal(ctx, session, dealId, APP_URL)).toMatchObject({ executed: null, deal: { status: "completed" } });
  });

  it("fails the deal when PayPal denies a capture that was pending", async () => {
    const { session, dealId } = await open("happy-path");
    await driveTo(session, dealId, "verified");
    const pendingFirst: ServiceContext = {
      ...ctx,
      provider: providerWith({
        captureAuthorization: async (input) => ({ ...(await simulator.captureAuthorization(input)), status: "PENDING" }),
      }),
    };
    const pending = (await advanceDeal(pendingFirst, session, dealId, APP_URL)).deal;

    await deliver(captureEvent("DENIED", pending));
    const after = await getDealView(ctx, session, dealId);
    expect(after).toMatchObject({ status: "failed", payment: { status: "failed", capturedMinor: 0, lastError: { issue: "CAPTURE_DENIED" } } });
    expect(types(after, pending.audit.length)).toEqual(["payment.webhook", "payment.failed", "deal.failed"]);
  });

  it("adopts an authorization PACT never got to record, and the deal carries on", async () => {
    const { session, dealId } = await open("happy-path");
    const waiting = await driveTo(session, dealId, "awaiting_payment");
    const orderId = waiting.payment?.orderId ?? "";
    // The payer approved and PayPal authorized, but PACT's request died before the answer was stored.
    await simulator.approve(orderId);
    const order = await simulator.authorizeOrder(orderId, idempotencyKey("authorize", dealId, orderId));
    const authorizationId = order.authorization?.authorizationId ?? "";

    expect(await deliver(authorizationEvent("CREATED", orderId, authorizationId, 4700))).toEqual({ accepted: true, duplicate: false, reason: null });
    const authorized = await getDealView(ctx, session, dealId);
    expect(authorized).toMatchObject({
      status: "authorized",
      payment: { status: "authorized", authorizationId, authorizedMinor: 4700, webhookConfirmed: { authorized: true } },
    });

    const done = await driveTo(session, dealId, "completed");
    expect(done.payment).toMatchObject({ status: "captured", capturedMinor: 4700 });
  });
});
