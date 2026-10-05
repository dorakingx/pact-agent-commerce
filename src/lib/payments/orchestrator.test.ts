import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashContract, paypalCustomId } from "../domain/contract";
import { AuditEventSchema, type AuditEventInput, type Contract, type SignedContract } from "../domain/schemas";
import { canPaymentTransition } from "../domain/status";
import { idempotencyKey } from "./idempotency";
import { createMemoryLedger, type MemoryLedger } from "./ledger";
import {
  PaymentStepError,
  authorizeApprovedOrder,
  captureVerified,
  newPaymentRecord,
  openOrder,
  reconcile,
  voidHeldFunds,
  type OrchestratorDeps,
  type PaymentStepResult,
} from "./orchestrator";
import { SimulatedProvider, createMemorySimulatedStore } from "./simulated";
import { PaymentError, type CaptureInfo, type PaymentRecord } from "./types";

const DEAL_ID = "deal_orchestrator";
const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-10-06T12:00:00.000Z");
const URLS = { returnUrl: "https://pact.example/return", cancelUrl: "https://pact.example/cancel" };
const PRICE = 9000;

function signedContract(overrides: Partial<Contract> = {}): SignedContract {
  const contract: Contract = {
    contractId: "ctr_orchestrator1",
    schemaVersion: 1,
    dealId: DEAL_ID,
    createdAt: "2026-10-06T10:00:00.000Z",
    title: "3 illustrations · Autumn campaign",
    category: "illustration",
    buyer: { id: "buyer_demo", name: "Demo Buyer" },
    seller: { id: "seller_northwind", name: "Northwind Studio" },
    price: { amountMinor: PRICE, currency: "USD" },
    deadline: "2026-10-09T18:00:00.000Z",
    revisionLimit: 1,
    deliverables: [{ kind: "illustration", count: 3, aspectRatios: ["16:9"], subject: "Autumn campaign", style: null }],
    verificationRules: [
      { id: "R1", kind: "deliverable_count", description: "3 illustrations delivered", required: true, evaluator: "deterministic" },
    ],
    settlement: {
      trigger: "verified_delivery",
      autoCaptureMinConfidence: 0.85,
      humanReviewMinConfidence: 0.5,
      onExhaustedRevisions: "void_authorization",
    },
    ...overrides,
  };
  return { contract, termsHash: hashContract(contract) };
}

const AuditInputSchema = AuditEventSchema.pick({ actor: true, type: true, title: true, detail: true, data: true, at: true });

/** Every record the orchestrator hands back must be a legal move and internally consistent. */
function expectLegal(before: PaymentRecord, after: PaymentRecord, events: AuditEventInput[]): void {
  if (after.status !== before.status) expect(canPaymentTransition(before.status, after.status)).toBe(true);
  expect(after.capturedMinor).toBeLessThanOrEqual(after.authorizedMinor);
  expect(after.authorizedMinor).toBeLessThanOrEqual(after.amountMinor);
  expect(new Date(after.updatedAt).toISOString()).toBe(after.updatedAt);
  if (after.status === "authorized") {
    expect(after.authorizationId).not.toBeNull();
    expect(after.authorizedMinor).toBeGreaterThan(0);
    expect(after.capturedMinor).toBe(0);
  }
  if (after.status === "captured") expect(after.capturedMinor).toBeGreaterThan(0);
  if (after.status === "none") expect(after.orderId).toBeNull();
  for (const event of events) expect(AuditInputSchema.safeParse(event).success).toBe(true);
}

let nowMs: number;
let provider: SimulatedProvider;
let ledger: MemoryLedger;
let deps: OrchestratorDeps;
let signed: SignedContract;

async function step(before: PaymentRecord, action: Promise<PaymentStepResult>): Promise<PaymentStepResult> {
  const result = await action;
  expectLegal(before, result.payment, result.events);
  return result;
}

/** Runs a step that must be refused and returns the PaymentStepError it throws. */
async function refused(before: PaymentRecord, action: Promise<PaymentStepResult>): Promise<PaymentStepError> {
  const error: unknown = await action.then(
    (result) => new Error(`expected a refusal, got status ${result.payment.status}`),
    (reason: unknown) => reason,
  );
  if (!(error instanceof PaymentStepError)) throw error;
  expectLegal(before, error.payment, error.events);
  return error;
}

function types(events: AuditEventInput[]): string[] {
  return events.map((event) => event.type);
}

const NONE = (): PaymentRecord => newPaymentRecord("simulated", "interactive", PRICE, new Date(nowMs));

async function opened(contract = signed): Promise<PaymentRecord> {
  return (await step(NONE(), openOrder(deps, { dealId: DEAL_ID, signed: contract, ...URLS }))).payment;
}

async function authorized(contract = signed): Promise<PaymentRecord> {
  const created = await opened(contract);
  await provider.approve(created.orderId ?? "");
  return (await step(created, authorizeApprovedOrder(deps, { dealId: DEAL_ID, signed: contract, payment: created }))).payment;
}

async function vaultedWallet(): Promise<string> {
  const setup = await provider.createVaultSetup({ ...URLS, idempotencyKey: "vault-setup" });
  return (await provider.exchangeVaultSetup(setup.setupTokenId, "vault-exchange")).vaultId;
}

function captureInput(payment: PaymentRecord, amountMinor = PRICE, contract = signed) {
  return { dealId: DEAL_ID, signed: contract, payment, amountMinor, reportId: "rep_test000001" };
}

function transient(issue = "TIMEOUT"): PaymentError {
  return new PaymentError({ issue, message: "PayPal did not answer", retryable: true });
}

function declined(issue: string): PaymentError {
  return new PaymentError({ issue, message: `PayPal says ${issue}`, httpStatus: 422, debugId: "dbg-42", retryable: false });
}

beforeEach(() => {
  nowMs = START;
  provider = new SimulatedProvider(createMemorySimulatedStore(), { now: () => new Date(nowMs) });
  ledger = createMemoryLedger();
  deps = { provider, ledger, now: () => new Date(nowMs) };
  signed = signedContract();
});

describe("newPaymentRecord", () => {
  it("starts empty, in status none, for the contract price", () => {
    expect(newPaymentRecord("paypal_sandbox", "delegated", 4550, new Date(START))).toEqual({
      provider: "paypal_sandbox",
      mode: "delegated",
      status: "none",
      orderId: null,
      authorizationId: null,
      captureId: null,
      amountMinor: 4550,
      authorizedMinor: 0,
      capturedMinor: 0,
      currency: "USD",
      approveUrl: null,
      authorizationExpiresAt: null,
      payerEmailMasked: null,
      lastError: null,
      webhookConfirmed: { authorized: false, captured: false, voided: false },
      updatedAt: "2026-10-06T12:00:00.000Z",
    });
  });

  it("rejects an amount that is not whole minor units", () => {
    expect(() => newPaymentRecord("simulated", "interactive", 45.5, new Date(START))).toThrow(RangeError);
  });
});

describe("openOrder", () => {
  it("creates an interactive order for exactly the contract price, bound to the terms hash", async () => {
    const { payment, events } = await step(NONE(), openOrder(deps, { dealId: DEAL_ID, signed, ...URLS }));
    expect(payment).toMatchObject({
      provider: "simulated",
      mode: "interactive",
      status: "created",
      amountMinor: PRICE,
      authorizedMinor: 0,
      approveUrl: `/pay/simulated/${payment.orderId}`,
      lastError: null,
    });
    expect(types(events)).toEqual(["payment.order_created"]);
    expect(events[0]).toMatchObject({ actor: "payment_orchestrator", title: expect.stringContaining("Simulated PayPal order created for $90.00") as string });
    expect(events[0].data).toMatchObject({
      orderId: payment.orderId,
      amountMinor: PRICE,
      customId: paypalCustomId(signed),
      invoiceId: signed.contract.contractId,
      idempotencyKey: idempotencyKey("create_order", DEAL_ID, signed.termsHash),
      idempotentReplay: false,
    });

    // PayPal's own record carries the binding.
    await expect(provider.getOrder(payment.orderId ?? "")).resolves.toMatchObject({
      amountMinor: PRICE,
      customId: `pact:v1:${signed.termsHash}`,
      invoiceId: signed.contract.contractId,
    });
  });

  it("is idempotent: a second call replays the ledger and never creates a second order", async () => {
    const createOrder = vi.spyOn(provider, "createOrder");
    const first = await opened();
    const second = await step(NONE(), openOrder(deps, { dealId: DEAL_ID, signed, ...URLS }));
    expect(second.payment.orderId).toBe(first.orderId);
    expect(second.events[0].data).toMatchObject({ idempotentReplay: true });
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(ledger.entries().size).toBe(1);
  });

  it("authorizes in one step against a delegated wallet, without recording the vault id anywhere", async () => {
    const vaultId = await vaultedWallet();
    const { payment, events } = await step(NONE(), openOrder(deps, { dealId: DEAL_ID, signed, ...URLS, vaultId }));
    expect(payment).toMatchObject({
      mode: "delegated",
      status: "authorized",
      authorizedMinor: PRICE,
      approveUrl: null,
      authorizationExpiresAt: new Date(START + 29 * DAY_MS).toISOString(),
      payerEmailMasked: "si****@personal.example.com",
    });
    expect(types(events)).toEqual(["payment.order_created", "payment.authorized"]);
    expect(events[1]).toMatchObject({ actor: "paypal", detail: expect.stringContaining("delegated agent wallet") as string });

    const persisted = JSON.stringify([payment, events, [...ledger.entries().values()]]);
    expect(persisted).not.toContain(vaultId);
    expect(ledger.entries().get(idempotencyKey("create_order", DEAL_ID, signed.termsHash))?.request).toMatchObject({ delegated: true });
  });

  it("refuses a contract whose content no longer matches its hash, before anything reaches PayPal", async () => {
    const createOrder = vi.spyOn(provider, "createOrder");
    const tampered: SignedContract = { ...signed, contract: { ...signed.contract, price: { amountMinor: 100, currency: "USD" } } };
    const error = await refused(NONE(), openOrder(deps, { dealId: DEAL_ID, signed: tampered, ...URLS }));
    expect(error).toMatchObject({ issue: "CONTRACT_HASH_INVALID", retryable: false });
    expect(error.payment).toMatchObject({ status: "none", lastError: { issue: "CONTRACT_HASH_INVALID" } });
    expect(types(error.events)).toEqual(["payment.capture_blocked"]);
    expect(createOrder).not.toHaveBeenCalled();
    expect(ledger.entries().size).toBe(0);
  });

  it("refuses a contract that belongs to another deal", async () => {
    const error = await refused(NONE(), openOrder(deps, { dealId: "deal_other", signed, ...URLS }));
    expect(error.issue).toBe("CONTRACT_DEAL_MISMATCH");
  });

  it("surfaces a transient failure as retryable and succeeds on the next attempt with the same key", async () => {
    const createOrder = vi.spyOn(provider, "createOrder").mockRejectedValueOnce(transient());
    const error = await refused(NONE(), openOrder(deps, { dealId: DEAL_ID, signed, ...URLS }));
    expect(error).toMatchObject({ issue: "TIMEOUT", retryable: true });
    expect(error.payment).toMatchObject({ status: "none", lastError: { issue: "TIMEOUT" } });
    const key = idempotencyKey("create_order", DEAL_ID, signed.termsHash);
    expect(ledger.entries().get(key)).toMatchObject({ status: "retryable" });

    const retry = await opened();
    expect(retry.status).toBe("created");
    expect(createOrder).toHaveBeenCalledTimes(2);
    expect(createOrder.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([key, key]);
    expect(ledger.entries().get(key)).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("fails the payment when PayPal refuses the order, and never asks again", async () => {
    const createOrder = vi.spyOn(provider, "createOrder").mockRejectedValueOnce(declined("PAYEE_ACCOUNT_RESTRICTED"));
    const first = await step(NONE(), openOrder(deps, { dealId: DEAL_ID, signed, ...URLS }));
    expect(first.payment).toMatchObject({
      status: "failed",
      orderId: null,
      lastError: { issue: "PAYEE_ACCOUNT_RESTRICTED", debugId: "dbg-42", at: "2026-10-06T12:00:00.000Z" },
    });
    expect(types(first.events)).toEqual(["payment.failed"]);
    expect(first.events[0].data).toMatchObject({ issue: "PAYEE_ACCOUNT_RESTRICTED", debugId: "dbg-42", httpStatus: 422 });

    const again = await step(NONE(), openOrder(deps, { dealId: DEAL_ID, signed, ...URLS }));
    expect(again.payment.status).toBe("failed");
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  it("refuses an order that PayPal echoes back with a different amount, and lets the caller abandon it", async () => {
    const real = provider.createOrder.bind(provider);
    vi.spyOn(provider, "createOrder").mockImplementationOnce(async (input) => ({ ...(await real(input)), amountMinor: PRICE + 1 }));
    const error = await refused(NONE(), openOrder(deps, { dealId: DEAL_ID, signed, ...URLS }));
    expect(error.issue).toBe("ORDER_CONTRACT_MISMATCH");
    expect(error.payment).toMatchObject({ status: "created", lastError: { issue: "ORDER_CONTRACT_MISMATCH" } });
    expect(types(error.events)).toEqual(["payment.order_created", "payment.capture_blocked"]);

    const abandoned = await step(error.payment, voidHeldFunds(deps, { dealId: DEAL_ID, payment: error.payment, reason: "Order mismatch" }));
    expect(abandoned.payment.status).toBe("voided");
  });

  it("falls back to payer approval when PayPal will not authorize the delegated wallet on its own", async () => {
    const vaultId = await vaultedWallet();
    const real = provider.createOrder.bind(provider);
    // PayPal answers a vaulted order with PAYER_ACTION_REQUIRED when the stored consent is no longer enough.
    vi.spyOn(provider, "createOrder").mockImplementationOnce((input) => real({ ...input, vaultId: undefined }));
    const { payment, events } = await step(NONE(), openOrder(deps, { dealId: DEAL_ID, signed, ...URLS, vaultId }));
    expect(payment).toMatchObject({ status: "created", mode: "interactive", approveUrl: `/pay/simulated/${payment.orderId}` });
    expect(types(events)).toEqual(["payment.order_created", "payment.order_created"]);
    expect(events[1].title).toContain("requires the payer's approval");
  });
});

describe("authorizeApprovedOrder", () => {
  it("leaves the payment in created while the payer has not approved (ORDER_NOT_APPROVED)", async () => {
    const authorizeOrder = vi.spyOn(provider, "authorizeOrder");
    const created = await opened();
    const error = await refused(created, authorizeApprovedOrder(deps, { dealId: DEAL_ID, signed, payment: created }));
    expect(error).toMatchObject({ issue: "ORDER_NOT_APPROVED", retryable: false });
    expect(error.payment).toMatchObject({ status: "created", authorizationId: null, lastError: { issue: "ORDER_NOT_APPROVED" } });
    expect(error.events).toEqual([]);
    // Nothing was attempted, so the authorize key is still unused and a later approval can go through.
    expect(authorizeOrder).not.toHaveBeenCalled();
    expect(ledger.entries().has(idempotencyKey("authorize", DEAL_ID, created.orderId ?? ""))).toBe(false);

    await provider.approve(created.orderId ?? "");
    const { payment } = await step(error.payment, authorizeApprovedOrder(deps, { dealId: DEAL_ID, signed, payment: error.payment }));
    expect(payment).toMatchObject({ status: "authorized", lastError: null });
  });

  it("authorizes an approved order: funds held, nothing captured", async () => {
    const created = await opened();
    await provider.approve(created.orderId ?? "");
    const { payment, events } = await step(created, authorizeApprovedOrder(deps, { dealId: DEAL_ID, signed, payment: created }));
    expect(payment).toMatchObject({
      status: "authorized",
      authorizationId: expect.stringMatching(/^SIM-A-/) as string,
      authorizedMinor: PRICE,
      capturedMinor: 0,
      authorizationExpiresAt: new Date(START + 29 * DAY_MS).toISOString(),
      payerEmailMasked: "si****@personal.example.com",
      approveUrl: null,
    });
    expect(types(events)).toEqual(["payment.approved", "payment.authorized"]);
    expect(events[1].title).toBe("Simulated PayPal authorized $90.00 — the funds are held, not captured");
    expect(events[1].data).toMatchObject({
      orderId: payment.orderId,
      authorizationId: payment.authorizationId,
      amountMinor: PRICE,
      idempotencyKey: idempotencyKey("authorize", DEAL_ID, payment.orderId ?? ""),
    });
    await expect(provider.getAuthorization(payment.authorizationId ?? "")).resolves.toMatchObject({ status: "CREATED" });
  });

  it("is a no-op for a payment that is already authorized (double submit of the return redirect)", async () => {
    const payment = await authorized();
    const authorizeOrder = vi.spyOn(provider, "authorizeOrder");
    const again = await authorizeApprovedOrder(deps, { dealId: DEAL_ID, signed, payment });
    expect(again).toEqual({ payment, events: [] });
    expect(authorizeOrder).not.toHaveBeenCalled();
  });

  it("adopts an authorization PayPal already holds instead of authorizing twice (crash after authorize)", async () => {
    const created = await opened();
    await provider.approve(created.orderId ?? "");
    // The first attempt reached PayPal, but its result was never recorded or persisted.
    const lost = await provider.authorizeOrder(created.orderId ?? "", idempotencyKey("authorize", DEAL_ID, created.orderId ?? ""));
    const authorizeOrder = vi.spyOn(provider, "authorizeOrder");

    const { payment, events } = await step(created, authorizeApprovedOrder(deps, { dealId: DEAL_ID, signed, payment: created }));
    expect(payment).toMatchObject({ status: "authorized", authorizationId: lost.authorization?.authorizationId });
    expect(events.at(-1)?.data).toMatchObject({ adoptedFromPayPal: true });
    expect(authorizeOrder).not.toHaveBeenCalled();
  });

  it("blocks an order that is bound to a different contract and never authorizes it", async () => {
    const authorizeOrder = vi.spyOn(provider, "authorizeOrder");
    const created = await opened();
    await provider.approve(created.orderId ?? "");
    // Same deal and price, but different terms: the hash PayPal holds no longer matches.
    const renegotiated = signedContract({ revisionLimit: 3 });
    const error = await refused(created, authorizeApprovedOrder(deps, { dealId: DEAL_ID, signed: renegotiated, payment: created }));
    expect(error).toMatchObject({ issue: "ORDER_CONTRACT_MISMATCH", retryable: false });
    expect(error.payment).toMatchObject({ status: "created", lastError: { issue: "ORDER_CONTRACT_MISMATCH" } });
    expect(types(error.events)).toEqual(["payment.capture_blocked"]);
    expect(error.events[0].data).toMatchObject({
      reason: "ORDER_CONTRACT_MISMATCH",
      expectedCustomId: paypalCustomId(renegotiated),
      actualCustomId: paypalCustomId(signed),
    });
    expect(authorizeOrder).not.toHaveBeenCalled();
  });

  it("blocks an order whose amount differs from the contract price", async () => {
    const created = await opened();
    await provider.approve(created.orderId ?? "");
    const real = provider.getOrder.bind(provider);
    vi.spyOn(provider, "getOrder").mockImplementationOnce(async (id) => ({ ...(await real(id)), amountMinor: PRICE - 1 }));
    const error = await refused(created, authorizeApprovedOrder(deps, { dealId: DEAL_ID, signed, payment: created }));
    expect(error.issue).toBe("ORDER_CONTRACT_MISMATCH");
    expect(error.message).toContain("$89.99");
  });

  it("fails the payment when PayPal declines the authorization", async () => {
    const created = await opened();
    await provider.approve(created.orderId ?? "");
    vi.spyOn(provider, "authorizeOrder").mockRejectedValueOnce(declined("INSTRUMENT_DECLINED"));
    const { payment, events } = await step(created, authorizeApprovedOrder(deps, { dealId: DEAL_ID, signed, payment: created }));
    expect(payment).toMatchObject({ status: "failed", authorizationId: null, lastError: { issue: "INSTRUMENT_DECLINED" } });
    expect(types(events)).toEqual(["payment.approved", "payment.failed"]);
  });

  it("keeps the payment approved on a transient failure so the same key can be retried", async () => {
    const created = await opened();
    await provider.approve(created.orderId ?? "");
    vi.spyOn(provider, "authorizeOrder").mockRejectedValueOnce(transient("NETWORK_ERROR"));
    const error = await refused(created, authorizeApprovedOrder(deps, { dealId: DEAL_ID, signed, payment: created }));
    expect(error).toMatchObject({ issue: "NETWORK_ERROR", retryable: true });
    expect(error.payment.status).toBe("approved");
    expect(types(error.events)).toEqual(["payment.approved"]);

    const retry = await step(error.payment, authorizeApprovedOrder(deps, { dealId: DEAL_ID, signed, payment: error.payment }));
    expect(retry.payment.status).toBe("authorized");
    // The approval was already recorded with the failed attempt; it is not reported twice.
    expect(types(retry.events)).toEqual(["payment.authorized"]);
  });

  it("marks the payment voided when the payer cancelled the order at PayPal", async () => {
    const created = await opened();
    await provider.cancel(created.orderId ?? "");
    const { payment, events } = await step(created, authorizeApprovedOrder(deps, { dealId: DEAL_ID, signed, payment: created }));
    expect(payment.status).toBe("voided");
    expect(types(events)).toEqual(["payment.voided"]);
  });

  it("rejects a payment with no order to authorize", async () => {
    const error = await refused(NONE(), authorizeApprovedOrder(deps, { dealId: DEAL_ID, signed, payment: NONE() }));
    expect(error.issue).toBe("INVALID_PAYMENT_STATE");
  });
});

describe("captureVerified", () => {
  it("captures the full contract price exactly once", async () => {
    const payment = await authorized();
    const { payment: captured, events } = await step(payment, captureVerified(deps, captureInput(payment)));
    expect(captured).toMatchObject({
      status: "captured",
      capturedMinor: PRICE,
      captureId: expect.stringMatching(/^SIM-C-/) as string,
      lastError: null,
    });
    expect(types(events)).toEqual(["payment.captured"]);
    expect(events[0]).toMatchObject({ actor: "paypal", title: "Simulated PayPal captured $90.00 — the seller is paid" });
    expect(events[0].data).toMatchObject({
      authorizationId: payment.authorizationId,
      captureId: captured.captureId,
      amountMinor: PRICE,
      releasedMinor: 0,
      reportId: "rep_test000001",
      idempotencyKey: idempotencyKey("capture", DEAL_ID, payment.authorizationId ?? ""),
    });
    await expect(provider.getAuthorization(payment.authorizationId ?? "")).resolves.toMatchObject({ status: "CAPTURED" });
  });

  it("sends a final capture with the contract id as invoice id", async () => {
    const payment = await authorized();
    const captureAuthorization = vi.spyOn(provider, "captureAuthorization");
    await captureVerified(deps, captureInput(payment, 4500));
    expect(captureAuthorization).toHaveBeenCalledExactlyOnceWith({
      authorizationId: payment.authorizationId,
      amountMinor: 4500,
      currency: "USD",
      finalCapture: true,
      invoiceId: signed.contract.contractId,
      noteToPayer: expect.stringContaining(signed.contract.contractId) as string,
      idempotencyKey: idempotencyKey("capture", DEAL_ID, payment.authorizationId ?? ""),
    });
  });

  it("records exactly one capture when capture is attempted twice", async () => {
    const payment = await authorized();
    const captureAuthorization = vi.spyOn(provider, "captureAuthorization");
    const first = await step(payment, captureVerified(deps, captureInput(payment)));
    // A double submit: the caller still holds the authorized record.
    const second = await step(payment, captureVerified(deps, captureInput(payment)));
    expect(second.payment.captureId).toBe(first.payment.captureId);
    expect(second.payment.capturedMinor).toBe(PRICE);
    expect(second.events[0].data).toMatchObject({ idempotentReplay: true });
    expect(captureAuthorization).toHaveBeenCalledTimes(1);
    expect([...ledger.entries().values()].filter((entry) => entry.kind === "capture")).toHaveLength(1);
  });

  it("records exactly one capture when two captures race", async () => {
    const payment = await authorized();
    const [a, b] = await Promise.all([captureVerified(deps, captureInput(payment)), captureVerified(deps, captureInput(payment))]);
    expect(a.payment.captureId).toBe(b.payment.captureId);
    expect([...ledger.entries().values()].filter((entry) => entry.kind === "capture")).toHaveLength(1);
    // The provider would have refused a genuine second capture with AUTHORIZATION_ALREADY_CAPTURED.
    await expect(provider.getAuthorization(payment.authorizationId ?? "")).resolves.toMatchObject({ status: "CAPTURED" });
  });

  it("recovers from a crash after a successful capture by replaying the same key", async () => {
    const payment = await authorized();
    const key = idempotencyKey("capture", DEAL_ID, payment.authorizationId ?? "");
    // The capture reached PayPal, then the process died before any outcome was recorded.
    await ledger.begin({ key, dealId: DEAL_ID, kind: "capture", request: {} });
    const lost = await provider.captureAuthorization({
      authorizationId: payment.authorizationId ?? "",
      amountMinor: PRICE,
      currency: "USD",
      finalCapture: true,
      invoiceId: signed.contract.contractId,
      noteToPayer: "lost",
      idempotencyKey: key,
    });

    const { payment: captured } = await step(payment, captureVerified(deps, captureInput(payment)));
    expect(captured).toMatchObject({ status: "captured", captureId: lost.captureId, capturedMinor: PRICE });
    expect(ledger.entries().get(key)).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("adopts the existing capture when PayPal answers AUTHORIZATION_ALREADY_CAPTURED — never captures again", async () => {
    const payment = await authorized();
    const key = idempotencyKey("capture", DEAL_ID, payment.authorizationId ?? "");
    await ledger.begin({ key, dealId: DEAL_ID, kind: "capture", request: {} });
    // The earlier capture is no longer replayable under our key (PayPal only keeps keys for a while).
    await provider.captureAuthorization({
      authorizationId: payment.authorizationId ?? "",
      amountMinor: PRICE,
      currency: "USD",
      finalCapture: true,
      invoiceId: signed.contract.contractId,
      noteToPayer: "earlier",
      idempotencyKey: "a-key-paypal-has-forgotten",
    });
    const captureAuthorization = vi.spyOn(provider, "captureAuthorization");

    const { payment: captured, events } = await step(payment, captureVerified(deps, captureInput(payment)));
    expect(captured).toMatchObject({ status: "captured", capturedMinor: PRICE, captureId: null, lastError: null });
    expect(types(events)).toEqual(["payment.captured"]);
    expect(events[0].data).toMatchObject({ adoptedFromPayPal: true, paypalAuthorizationStatus: "CAPTURED", issue: "AUTHORIZATION_ALREADY_CAPTURED" });
    expect(captureAuthorization).toHaveBeenCalledTimes(1);

    // Still adopted, still no second capture, when the step runs again before the record was saved.
    const again = await step(payment, captureVerified(deps, captureInput(payment)));
    expect(again.payment).toMatchObject({ status: "captured", capturedMinor: PRICE });
    expect(captureAuthorization).toHaveBeenCalledTimes(1);
  });

  it("adopts a partial capture for the amount being retried and flags the amount as inferred", async () => {
    const payment = await authorized();
    await provider.captureAuthorization({
      authorizationId: payment.authorizationId ?? "",
      amountMinor: 4500,
      currency: "USD",
      finalCapture: true,
      invoiceId: signed.contract.contractId,
      noteToPayer: "earlier",
      idempotencyKey: "a-key-paypal-has-forgotten",
    });
    const { payment: captured, events } = await step(payment, captureVerified(deps, captureInput(payment, 4500)));
    expect(captured).toMatchObject({ status: "captured", capturedMinor: 4500 });
    expect(events[0].data).toMatchObject({ adoptedFromPayPal: true, amountInferred: true, paypalAuthorizationStatus: "PARTIALLY_CAPTURED" });
  });

  it("refuses to guess when PayPal's capture state contradicts the request", async () => {
    const payment = await authorized();
    await provider.captureAuthorization({
      authorizationId: payment.authorizationId ?? "",
      amountMinor: 4500,
      currency: "USD",
      finalCapture: true,
      invoiceId: signed.contract.contractId,
      noteToPayer: "earlier",
      idempotencyKey: "a-key-paypal-has-forgotten",
    });
    // A full capture is requested, but PayPal only shows a partial one.
    const error = await refused(payment, captureVerified(deps, captureInput(payment, PRICE)));
    expect(error.issue).toBe("CAPTURE_STATE_UNKNOWN");
    expect(error.payment).toMatchObject({ status: "authorized", capturedMinor: 0 });
  });

  it("blocks the capture when PayPal's authorization is bound to a different contract hash", async () => {
    const payment = await authorized();
    const captureAuthorization = vi.spyOn(provider, "captureAuthorization");
    const otherTerms = signedContract({ deadline: "2026-10-12T18:00:00.000Z" });
    const error = await refused(payment, captureVerified(deps, captureInput(payment, PRICE, otherTerms)));
    expect(error).toMatchObject({ issue: "ORDER_CONTRACT_MISMATCH", retryable: false });
    expect(error.payment).toMatchObject({ status: "authorized", capturedMinor: 0, lastError: { issue: "ORDER_CONTRACT_MISMATCH" } });
    expect(types(error.events)).toEqual(["payment.capture_blocked"]);
    expect(error.events[0]).toMatchObject({
      actor: "payment_orchestrator",
      title: "Capture blocked: PayPal's authorization is not bound to this contract's terms hash",
    });
    expect(error.events[0].data).toMatchObject({ expectedCustomId: paypalCustomId(otherTerms), actualCustomId: paypalCustomId(signed) });
    expect(captureAuthorization).not.toHaveBeenCalled();
    expect([...ledger.entries().values()].some((entry) => entry.kind === "capture")).toBe(false);
  });

  it("blocks the capture when the contract was altered after signing", async () => {
    const payment = await authorized();
    const tampered: SignedContract = { ...signed, contract: { ...signed.contract, revisionLimit: 0 } };
    const error = await refused(payment, captureVerified(deps, captureInput(payment, PRICE, tampered)));
    expect(error.issue).toBe("CONTRACT_HASH_INVALID");
  });

  it("rejects an amount above the authorization before calling the provider at all", async () => {
    const payment = await authorized();
    const getAuthorization = vi.spyOn(provider, "getAuthorization");
    const captureAuthorization = vi.spyOn(provider, "captureAuthorization");
    const error = await refused(payment, captureVerified(deps, captureInput(payment, PRICE + 1)));
    expect(error).toMatchObject({ issue: "CAPTURE_EXCEEDS_AUTHORIZATION", retryable: false });
    expect(error.payment.status).toBe("authorized");
    expect(types(error.events)).toEqual(["payment.capture_blocked"]);
    expect(error.events[0].data).toMatchObject({ amountMinor: PRICE + 1, authorizedMinor: PRICE, reportId: "rep_test000001" });
    expect(getAuthorization).not.toHaveBeenCalled();
    expect(captureAuthorization).not.toHaveBeenCalled();
  });

  it.each([0, -1, 45.5, Number.NaN])("rejects the invalid capture amount %s", async (amountMinor) => {
    const payment = await authorized();
    const error = await refused(payment, captureVerified(deps, captureInput(payment, amountMinor)));
    expect(error.issue).toBe("INVALID_CAPTURE_AMOUNT");
  });

  it("rejects an amount above the contract price even if more was authorized", async () => {
    const payment = await authorized();
    const inflated: PaymentRecord = { ...payment, amountMinor: PRICE + 500, authorizedMinor: PRICE + 500 };
    const error = await refused(inflated, captureVerified(deps, captureInput(inflated, PRICE + 500)));
    expect(error.issue).toBe("CAPTURE_EXCEEDS_CONTRACT");
  });

  it("rejects a capture when PayPal holds less than the amount to capture", async () => {
    const payment = await authorized();
    const real = provider.getAuthorization.bind(provider);
    vi.spyOn(provider, "getAuthorization").mockImplementationOnce(async (id) => ({ ...(await real(id)), amountMinor: 4000 }));
    const error = await refused(payment, captureVerified(deps, captureInput(payment, PRICE)));
    expect(error.issue).toBe("CAPTURE_EXCEEDS_AUTHORIZATION");
    expect(error.message).toContain("PayPal holds $40.00");
  });

  it("captures part of the amount and releases the rest (human-approved partial release)", async () => {
    const payment = await authorized();
    const { payment: captured, events } = await step(payment, captureVerified(deps, captureInput(payment, 4500)));
    expect(captured).toMatchObject({ status: "captured", capturedMinor: 4500, authorizedMinor: PRICE });
    expect(events[0].title).toBe("Simulated PayPal captured $45.00 of the $90.00 authorized — $45.00 is released back to the payer");
    expect(events[0].data).toMatchObject({ amountMinor: 4500, releasedMinor: 4500, finalCapture: true });
    // Final capture: nothing more can be captured, and nothing is left to void.
    await expect(provider.getAuthorization(payment.authorizationId ?? "")).resolves.toMatchObject({ status: "PARTIALLY_CAPTURED" });
  });

  it("refuses to capture a payment that was voided, without touching the settled record", async () => {
    const payment = await authorized();
    const { payment: voided } = await step(payment, voidHeldFunds(deps, { dealId: DEAL_ID, payment, reason: "Delivery rejected" }));
    const captureAuthorization = vi.spyOn(provider, "captureAuthorization");
    const error = await refused(voided, captureVerified(deps, captureInput(voided)));
    expect(error).toMatchObject({ issue: "INVALID_PAYMENT_STATE", retryable: false });
    expect(error.payment).toBe(voided);
    expect(types(error.events)).toEqual(["payment.capture_blocked"]);
    expect(captureAuthorization).not.toHaveBeenCalled();
  });

  it("refuses to capture a payment that was already captured", async () => {
    const payment = await authorized();
    const { payment: captured } = await captureVerified(deps, captureInput(payment));
    const error = await refused(captured, captureVerified(deps, captureInput(captured)));
    expect(error.issue).toBe("INVALID_PAYMENT_STATE");
    expect(error.payment).toBe(captured);
  });

  it("marks the payment expired when PayPal has voided the authorization behind PACT's back", async () => {
    const payment = await authorized();
    await provider.voidAuthorization(payment.authorizationId ?? "", "voided-in-the-paypal-dashboard");
    const captureAuthorization = vi.spyOn(provider, "captureAuthorization");
    const { payment: expired, events } = await step(payment, captureVerified(deps, captureInput(payment)));
    expect(expired).toMatchObject({ status: "expired", capturedMinor: 0, lastError: { issue: "AUTHORIZATION_VOIDED" } });
    expect(types(events)).toEqual(["payment.expired"]);
    expect(captureAuthorization).not.toHaveBeenCalled();
  });

  it("marks the payment expired when the authorization ran out of time", async () => {
    const payment = await authorized();
    nowMs = START + 30 * DAY_MS;
    const { payment: expired } = await step(payment, captureVerified(deps, captureInput(payment)));
    expect(expired).toMatchObject({ status: "expired", lastError: { issue: "AUTHORIZATION_EXPIRED" } });
  });

  it("stays authorized while the capture is PENDING, then completes with the same key", async () => {
    const payment = await authorized();
    const key = idempotencyKey("capture", DEAL_ID, payment.authorizationId ?? "");
    const pendingCapture: CaptureInfo = { captureId: "SIM-C-PENDING", status: "PENDING", amountMinor: PRICE, currency: "USD", finalCapture: true };
    const captureAuthorization = vi.spyOn(provider, "captureAuthorization").mockResolvedValueOnce(pendingCapture);

    const pending = await step(payment, captureVerified(deps, captureInput(payment)));
    expect(pending.payment).toMatchObject({
      status: "authorized",
      capturedMinor: 0,
      captureId: "SIM-C-PENDING",
      lastError: { issue: "CAPTURE_PENDING", debugId: null },
    });
    expect(types(pending.events)).toEqual(["payment.capture_pending"]);
    expect(pending.events[0].title).toContain("pending");
    // Not recorded as a success: the next attempt must ask PayPal again rather than replay "pending".
    expect(ledger.entries().get(key)).toMatchObject({ status: "retryable" });

    const done = await step(pending.payment, captureVerified(deps, captureInput(pending.payment)));
    expect(done.payment).toMatchObject({ status: "captured", capturedMinor: PRICE, lastError: null });
    expect(captureAuthorization.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([key, key]);
  });

  it.each(["DECLINED", "FAILED"] as const)("fails the payment when the capture comes back %s", async (status) => {
    const payment = await authorized();
    vi.spyOn(provider, "captureAuthorization").mockResolvedValueOnce({
      captureId: "SIM-C-REFUSED",
      status,
      amountMinor: PRICE,
      currency: "USD",
      finalCapture: true,
    });
    const { payment: failed, events } = await step(payment, captureVerified(deps, captureInput(payment)));
    expect(failed).toMatchObject({ status: "failed", capturedMinor: 0, lastError: { issue: `CAPTURE_${status}` } });
    expect(types(events)).toEqual(["payment.failed"]);
  });

  it("keeps the funds authorized when PayPal refuses the capture, so the caller can still void", async () => {
    const payment = await authorized();
    vi.spyOn(provider, "captureAuthorization").mockRejectedValueOnce(declined("TRANSACTION_REFUSED"));
    const error = await refused(payment, captureVerified(deps, captureInput(payment)));
    expect(error).toMatchObject({ issue: "TRANSACTION_REFUSED", debugId: "dbg-42", retryable: false });
    expect(error.payment).toMatchObject({ status: "authorized", lastError: { issue: "TRANSACTION_REFUSED", debugId: "dbg-42" } });
    expect(types(error.events)).toEqual(["payment.failed"]);
    expect(error.events[0].title).toContain("the funds remain authorized");

    const released = await step(error.payment, voidHeldFunds(deps, { dealId: DEAL_ID, payment: error.payment, reason: "Capture refused" }));
    expect(released.payment.status).toBe("voided");
  });

  it("surfaces a transient capture failure as retryable and captures once on retry", async () => {
    const payment = await authorized();
    const captureAuthorization = vi.spyOn(provider, "captureAuthorization").mockRejectedValueOnce(transient());
    const error = await refused(payment, captureVerified(deps, captureInput(payment)));
    expect(error).toMatchObject({ issue: "TIMEOUT", retryable: true });
    expect(error.payment.status).toBe("authorized");
    expect(error.events).toEqual([]);

    const { payment: captured } = await step(error.payment, captureVerified(deps, captureInput(error.payment)));
    expect(captured).toMatchObject({ status: "captured", capturedMinor: PRICE, lastError: null });
    expect(captureAuthorization).toHaveBeenCalledTimes(2);
  });

  it("surfaces a failed read of the authorization without touching the ledger", async () => {
    const payment = await authorized();
    vi.spyOn(provider, "getAuthorization").mockRejectedValueOnce(transient("NETWORK_ERROR"));
    const error = await refused(payment, captureVerified(deps, captureInput(payment)));
    expect(error).toMatchObject({ issue: "NETWORK_ERROR", retryable: true });
    expect([...ledger.entries().values()].some((entry) => entry.kind === "capture")).toBe(false);
  });
});

describe("voidHeldFunds", () => {
  it("voids an authorization and releases the held amount", async () => {
    const payment = await authorized();
    const { payment: voided, events } = await step(payment, voidHeldFunds(deps, { dealId: DEAL_ID, payment, reason: "Delivery rejected: no revisions left" }));
    expect(voided).toMatchObject({ status: "voided", capturedMinor: 0, lastError: null });
    expect(types(events)).toEqual(["payment.voided"]);
    expect(events[0]).toMatchObject({
      actor: "payment_orchestrator",
      title: "Authorization voided — $90.00 released back to the payer, nothing was captured",
      detail: "Delivery rejected: no revisions left",
    });
    expect(events[0].data).toMatchObject({
      authorizationId: payment.authorizationId,
      amountMinor: PRICE,
      idempotencyKey: idempotencyKey("void", DEAL_ID, payment.authorizationId ?? ""),
      alreadyVoidedAtPayPal: false,
    });
    await expect(provider.getAuthorization(payment.authorizationId ?? "")).resolves.toMatchObject({ status: "VOIDED" });
  });

  it("is idempotent: a voided record is returned unchanged, and a replayed void calls PayPal once", async () => {
    const payment = await authorized();
    const voidAuthorization = vi.spyOn(provider, "voidAuthorization");
    const { payment: voided } = await voidHeldFunds(deps, { dealId: DEAL_ID, payment, reason: "Rejected" });
    await expect(voidHeldFunds(deps, { dealId: DEAL_ID, payment: voided, reason: "Rejected" })).resolves.toEqual({ payment: voided, events: [] });
    // Double submit with the stale authorized record: replayed from the ledger.
    const replay = await step(payment, voidHeldFunds(deps, { dealId: DEAL_ID, payment, reason: "Rejected" }));
    expect(replay.payment.status).toBe("voided");
    expect(voidAuthorization).toHaveBeenCalledTimes(1);
  });

  it("treats PREVIOUSLY_VOIDED as the outcome that was asked for", async () => {
    const payment = await authorized();
    await provider.voidAuthorization(payment.authorizationId ?? "", "voided-elsewhere");
    const { payment: voided, events } = await step(payment, voidHeldFunds(deps, { dealId: DEAL_ID, payment, reason: "Rejected" }));
    expect(voided.status).toBe("voided");
    expect(events[0].data).toMatchObject({ alreadyVoidedAtPayPal: true });
  });

  it("refuses to pretend captured funds were voided (PREVIOUSLY_CAPTURED)", async () => {
    const payment = await authorized();
    await captureVerified(deps, captureInput(payment));
    // The caller still holds the stale authorized record.
    const error = await refused(payment, voidHeldFunds(deps, { dealId: DEAL_ID, payment, reason: "Rejected" }));
    expect(error).toMatchObject({ issue: "PREVIOUSLY_CAPTURED", retryable: false });
    expect(error.payment).toMatchObject({ status: "authorized", lastError: { issue: "PREVIOUSLY_CAPTURED" } });
    expect(types(error.events)).toEqual(["payment.failed"]);
  });

  it("refuses to void a captured record outright", async () => {
    const payment = await authorized();
    const { payment: captured } = await captureVerified(deps, captureInput(payment));
    const voidAuthorization = vi.spyOn(provider, "voidAuthorization");
    const error = await refused(captured, voidHeldFunds(deps, { dealId: DEAL_ID, payment: captured, reason: "Rejected" }));
    expect(error.issue).toBe("INVALID_PAYMENT_STATE");
    expect(error.payment).toBe(captured);
    expect(voidAuthorization).not.toHaveBeenCalled();
  });

  it("abandons an order that was never authorized without voiding anything at PayPal", async () => {
    const created = await opened();
    const voidAuthorization = vi.spyOn(provider, "voidAuthorization");
    const { payment, events } = await step(created, voidHeldFunds(deps, { dealId: DEAL_ID, payment: created, reason: "Payer cancelled" }));
    expect(payment).toMatchObject({ status: "voided", approveUrl: null, authorizationId: null });
    expect(events[0].title).toBe("Order abandoned before authorization — no funds were ever held");
    expect(voidAuthorization).not.toHaveBeenCalled();
  });

  it("releases a hold PACT never recorded when an authorize was interrupted", async () => {
    const created = await opened();
    await provider.approve(created.orderId ?? "");
    const lost = await provider.authorizeOrder(created.orderId ?? "", "lost-authorize");
    const { payment, events } = await step(created, voidHeldFunds(deps, { dealId: DEAL_ID, payment: created, reason: "Payer cancelled" }));
    expect(payment).toMatchObject({ status: "voided", authorizationId: lost.authorization?.authorizationId });
    expect(events[0].data).toMatchObject({ amountMinor: PRICE });
    await expect(provider.getAuthorization(lost.authorization?.authorizationId ?? "")).resolves.toMatchObject({ status: "VOIDED" });
  });

  it("abandons an order PayPal no longer knows", async () => {
    const created = await opened();
    const forgotten: PaymentRecord = { ...created, orderId: "SIM-O-FORGOTTEN" };
    const { payment } = await step(forgotten, voidHeldFunds(deps, { dealId: DEAL_ID, payment: forgotten, reason: "Timed out" }));
    expect(payment.status).toBe("voided");
  });

  it("keeps the payment authorized on a transient failure and voids on retry", async () => {
    const payment = await authorized();
    vi.spyOn(provider, "voidAuthorization").mockRejectedValueOnce(transient());
    const error = await refused(payment, voidHeldFunds(deps, { dealId: DEAL_ID, payment, reason: "Rejected" }));
    expect(error).toMatchObject({ issue: "TIMEOUT", retryable: true });
    expect(error.payment.status).toBe("authorized");
    const retry = await step(error.payment, voidHeldFunds(deps, { dealId: DEAL_ID, payment: error.payment, reason: "Rejected" }));
    expect(retry.payment.status).toBe("voided");
  });

  it("has nothing to void before an order exists", async () => {
    const error = await refused(NONE(), voidHeldFunds(deps, { dealId: DEAL_ID, payment: NONE(), reason: "Declined" }));
    expect(error.issue).toBe("INVALID_PAYMENT_STATE");
  });
});

describe("reconcile", () => {
  it("reports no drift and no events when PACT and PayPal agree", async () => {
    const created = await opened();
    await expect(reconcile(deps, { dealId: DEAL_ID, payment: created })).resolves.toEqual({ payment: created, events: [], drift: [] });

    const payment = await authorized();
    await expect(reconcile(deps, { dealId: DEAL_ID, payment })).resolves.toEqual({ payment, events: [], drift: [] });

    const { payment: captured } = await captureVerified(deps, captureInput(payment));
    await expect(reconcile(deps, { dealId: DEAL_ID, payment: captured })).resolves.toEqual({ payment: captured, events: [], drift: [] });

    await expect(reconcile(deps, { dealId: DEAL_ID, payment: NONE() })).resolves.toMatchObject({ drift: [], events: [] });
  });

  it("marks an authorized payment expired when PayPal voided the authorization", async () => {
    const payment = await authorized();
    await provider.voidAuthorization(payment.authorizationId ?? "", "voided-by-paypal");
    const result = await reconcile(deps, { dealId: DEAL_ID, payment });
    expectLegal(payment, result.payment, result.events);
    expect(result.payment.status).toBe("expired");
    expect(result.drift).toEqual(["PACT records the payment as authorized, but Simulated PayPal reports the authorization as VOIDED."]);
    expect(types(result.events)).toEqual(["payment.reconciled", "payment.expired"]);
    expect(result.events[0].data).toMatchObject({ drift: result.drift, statusBefore: "authorized", statusAfter: "expired" });
  });

  it("marks an authorized payment expired once the authorization's expiry has passed", async () => {
    const payment = await authorized();
    nowMs = START + 29 * DAY_MS;
    const result = await reconcile(deps, { dealId: DEAL_ID, payment });
    expect(result.payment.status).toBe("expired");
    expect(result.drift).toEqual([`The authorization expired at ${payment.authorizationExpiresAt}.`]);
    // Reconciling the expired record again is quiet.
    await expect(reconcile(deps, { dealId: DEAL_ID, payment: result.payment })).resolves.toMatchObject({ drift: [], events: [] });
  });

  it("reports, but does not act on, a capture PACT has not recorded", async () => {
    const payment = await authorized();
    await provider.captureAuthorization({
      authorizationId: payment.authorizationId ?? "",
      amountMinor: PRICE,
      currency: "USD",
      finalCapture: true,
      invoiceId: signed.contract.contractId,
      noteToPayer: "out of band",
      idempotencyKey: "out-of-band",
    });
    const result = await reconcile(deps, { dealId: DEAL_ID, payment });
    expect(result.payment).toBe(payment);
    expect(result.drift).toEqual(["PACT records the payment as authorized, but Simulated PayPal reports the authorization as CAPTURED."]);
    expect(types(result.events)).toEqual(["payment.reconciled"]);
  });

  it("reports an approval and an unrecorded authorization on an order PACT still shows as created", async () => {
    const created = await opened();
    await provider.approve(created.orderId ?? "");
    const approved = await reconcile(deps, { dealId: DEAL_ID, payment: created });
    expect(approved.payment).toBe(created);
    expect(approved.drift).toEqual(["The payer has approved the order in Simulated PayPal; it has not been authorized yet."]);

    const lost = await provider.authorizeOrder(created.orderId ?? "", "lost-authorize");
    const held = await reconcile(deps, { dealId: DEAL_ID, payment: created });
    expect(held.payment).toBe(created);
    expect(held.drift).toEqual([
      `Simulated PayPal holds authorization ${lost.authorization?.authorizationId} for this order, which PACT has not recorded.`,
    ]);
  });

  it("marks an unapproved order expired when PayPal no longer has it or reports it voided", async () => {
    const created = await opened();
    const forgotten: PaymentRecord = { ...created, orderId: "SIM-O-FORGOTTEN" };
    const gone = await reconcile(deps, { dealId: DEAL_ID, payment: forgotten });
    expectLegal(forgotten, gone.payment, gone.events);
    expect(gone.payment).toMatchObject({ status: "expired", approveUrl: null });
    expect(types(gone.events)).toEqual(["payment.reconciled", "payment.expired"]);

    await provider.cancel(created.orderId ?? "");
    const cancelled = await reconcile(deps, { dealId: DEAL_ID, payment: created });
    expect(cancelled.payment.status).toBe("expired");
    expect(cancelled.drift).toEqual(["Simulated PayPal reports the order as voided."]);
  });

  it("flags funds that are still held for a payment PACT considers voided", async () => {
    const payment = await authorized();
    const claimedVoided: PaymentRecord = { ...payment, status: "voided" };
    const result = await reconcile(deps, { dealId: DEAL_ID, payment: claimedVoided });
    expect(result.payment).toBe(claimedVoided);
    expect(result.drift).toEqual(["PACT records the payment as voided, but Simulated PayPal reports the authorization as CREATED."]);
  });

  it("leaves the record untouched when PayPal cannot be read", async () => {
    const payment = await authorized();
    vi.spyOn(provider, "getAuthorization").mockRejectedValueOnce(transient());
    const error = await refused(payment, reconcile(deps, { dealId: DEAL_ID, payment }));
    expect(error).toMatchObject({ issue: "TIMEOUT", retryable: true });
    expect(error.payment).toBe(payment);
  });
});

describe("ledger discipline", () => {
  it("runs a whole deal with one ledger entry per money-moving call and deterministic keys", async () => {
    const payment = await authorized();
    await captureVerified(deps, captureInput(payment));
    const entries = [...ledger.entries().values()];
    expect(entries.map((entry) => [entry.kind, entry.status, entry.attempts])).toEqual([
      ["create_order", "succeeded", 1],
      ["authorize", "succeeded", 1],
      ["capture", "succeeded", 1],
    ]);
    expect(entries.map((entry) => entry.key)).toEqual([
      idempotencyKey("create_order", DEAL_ID, signed.termsHash),
      idempotencyKey("authorize", DEAL_ID, payment.orderId ?? ""),
      idempotencyKey("capture", DEAL_ID, payment.authorizationId ?? ""),
    ]);
    expect(entries.every((entry) => entry.dealId === DEAL_ID)).toBe(true);
  });

  it("still reports the outcome when the ledger cannot record it, and the next attempt replays safely", async () => {
    const payment = await authorized();
    const succeed = vi.spyOn(ledger, "succeed").mockRejectedValueOnce(new Error("database unavailable"));
    const first = await step(payment, captureVerified(deps, captureInput(payment)));
    expect(first.payment.status).toBe("captured");
    expect(succeed).toHaveBeenCalledTimes(1);

    const second = await step(payment, captureVerified(deps, captureInput(payment)));
    expect(second.payment.captureId).toBe(first.payment.captureId);
  });

  it("does not mutate the records it is given", async () => {
    const created = await opened();
    const snapshot = structuredClone(created);
    await provider.approve(created.orderId ?? "");
    const { payment } = await authorizeApprovedOrder(deps, { dealId: DEAL_ID, signed, payment: created });
    expect(created).toEqual(snapshot);
    const authorizedSnapshot = structuredClone(payment);
    await captureVerified(deps, captureInput(payment));
    expect(payment).toEqual(authorizedSnapshot);
  });
});
