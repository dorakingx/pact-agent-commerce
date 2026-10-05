import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../domain/canonical";
import { SimulatedProvider, createMemorySimulatedStore, simulatedApprovePath } from "./simulated";
import { PaymentError, type CreateOrderInput, type OrderInfo } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-10-06T12:00:00.000Z");
const CONTRACT_HASH = sha256Hex("simulated-provider-test-contract");

let nowMs: number;
let provider: SimulatedProvider;

function orderInput(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    dealId: "deal_sim",
    contractId: "ctr_simulated001",
    contractHash: CONTRACT_HASH,
    amountMinor: 9000,
    currency: "USD",
    description: "PACT ctr_simulated001 · 3 illustrations · Northwind Studio",
    returnUrl: "https://pact.example/deals/deal_sim/return",
    cancelUrl: "https://pact.example/deals/deal_sim/cancel",
    idempotencyKey: "create-key-1",
    ...overrides,
  };
}

async function issueOf(action: Promise<unknown>): Promise<string> {
  const error: unknown = await action.then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(error instanceof PaymentError)) throw new Error(`expected a PaymentError, got ${String(error)}`);
  expect(error.retryable).toBe(false);
  return error.issue;
}

async function authorizedOrder(overrides: Partial<CreateOrderInput> = {}): Promise<OrderInfo & { authorizationId: string }> {
  const created = await provider.createOrder(orderInput(overrides));
  await provider.approve(created.orderId);
  const order = await provider.authorizeOrder(created.orderId, `authorize:${created.orderId}`);
  if (order.authorization === null) throw new Error("expected an authorization");
  return { ...order, authorizationId: order.authorization.authorizationId };
}

function capture(authorizationId: string, amountMinor: number, idempotencyKey: string) {
  return provider.captureAuthorization({
    authorizationId,
    amountMinor,
    currency: "USD",
    finalCapture: true,
    invoiceId: "ctr_simulated001",
    noteToPayer: "PACT: delivery verified.",
    idempotencyKey,
  });
}

beforeEach(() => {
  nowMs = START;
  provider = new SimulatedProvider(createMemorySimulatedStore(), { now: () => new Date(nowMs) });
});

describe("SimulatedProvider — identity", () => {
  it("is labelled as simulated and supports the vault flow", () => {
    expect(provider.kind).toBe("simulated");
    expect(provider.supportsVault).toBe(true);
  });

  it("never verifies a webhook", async () => {
    await expect(provider.verifyWebhook(new Headers(), "{}")).resolves.toEqual({
      verified: false,
      method: "simulated",
      reason: "simulated_provider",
    });
  });
});

describe("SimulatedProvider — orders", () => {
  it("creates an interactive order that waits for the payer, with SIM- ids and a relative approval path", async () => {
    const order = await provider.createOrder(orderInput());
    expect(order).toEqual({
      orderId: expect.stringMatching(/^SIM-O-[0-9A-F]{16}$/) as string,
      status: "PAYER_ACTION_REQUIRED",
      amountMinor: 9000,
      currency: "USD",
      customId: `pact:v1:${CONTRACT_HASH}`,
      invoiceId: "ctr_simulated001",
      approveUrl: simulatedApprovePath(order.orderId),
      authorization: null,
      payerEmailMasked: null,
      vaultId: null,
    });
    expect(order.approveUrl).toBe(`/pay/simulated/${order.orderId}`);
    await expect(provider.getOrder(order.orderId)).resolves.toEqual(order);
  });

  it("is idempotent on the idempotency key and returns the order's current state on replay", async () => {
    const first = await provider.createOrder(orderInput());
    await provider.approve(first.orderId);
    const replay = await provider.createOrder(orderInput());
    expect(replay.orderId).toBe(first.orderId);
    expect(replay.status).toBe("APPROVED");

    const other = await provider.createOrder(orderInput({ idempotencyKey: "create-key-2" }));
    expect(other.orderId).not.toBe(first.orderId);
  });

  it("rejects a malformed contract hash and a zero amount", async () => {
    await expect(provider.createOrder(orderInput({ contractHash: "abc" }))).rejects.toThrow(RangeError);
    await expect(issueOf(provider.createOrder(orderInput({ amountMinor: 0 })))).resolves.toBe("INVALID_PARAMETER_VALUE");
  });

  it("refuses to authorize before the payer approved", async () => {
    const order = await provider.createOrder(orderInput());
    await expect(issueOf(provider.authorizeOrder(order.orderId, "authorize-1"))).resolves.toBe("ORDER_NOT_APPROVED");
    await expect(provider.getOrder(order.orderId)).resolves.toMatchObject({ status: "PAYER_ACTION_REQUIRED", authorization: null });
  });

  it("authorizes an approved order: COMPLETED, authorization CREATED, expiry in 29 days, masked payer", async () => {
    const created = await provider.createOrder(orderInput());
    const approved = await provider.approve(created.orderId);
    expect(approved).toMatchObject({ status: "APPROVED", approveUrl: null, payerEmailMasked: "si****@personal.example.com" });

    const order = await provider.authorizeOrder(created.orderId, "authorize-1");
    expect(order.status).toBe("COMPLETED");
    expect(order.authorization).toEqual({
      authorizationId: expect.stringMatching(/^SIM-A-[0-9A-F]{16}$/) as string,
      status: "CREATED",
      amountMinor: 9000,
      currency: "USD",
      expiresAt: new Date(START + 29 * DAY_MS).toISOString(),
      customId: `pact:v1:${CONTRACT_HASH}`,
      invoiceId: "ctr_simulated001",
    });
    await expect(provider.getAuthorization(order.authorization?.authorizationId ?? "")).resolves.toEqual(order.authorization);
  });

  it("replays an authorize with the same key and rejects a second authorize with another key", async () => {
    const order = await authorizedOrder();
    const replay = await provider.authorizeOrder(order.orderId, `authorize:${order.orderId}`);
    expect(replay.authorization?.authorizationId).toBe(order.authorizationId);
    await expect(issueOf(provider.authorizeOrder(order.orderId, "another-key"))).resolves.toBe("ORDER_ALREADY_AUTHORIZED");
  });

  it("approve is safe to repeat; cancel voids the order so it can no longer be approved or authorized", async () => {
    const order = await provider.createOrder(orderInput());
    await provider.approve(order.orderId);
    await expect(provider.approve(order.orderId)).resolves.toMatchObject({ status: "APPROVED" });

    await expect(provider.cancel(order.orderId)).resolves.toMatchObject({ status: "VOIDED", approveUrl: null });
    await expect(provider.cancel(order.orderId)).resolves.toMatchObject({ status: "VOIDED" });
    await expect(issueOf(provider.approve(order.orderId))).resolves.toBe("ORDER_COMPLETED_OR_VOIDED");
    await expect(issueOf(provider.authorizeOrder(order.orderId, "authorize-1"))).resolves.toBe("ORDER_COMPLETED_OR_VOIDED");
  });

  it("cannot cancel an order that is already authorized", async () => {
    const order = await authorizedOrder();
    await expect(issueOf(provider.cancel(order.orderId))).resolves.toBe("ORDER_COMPLETED_OR_VOIDED");
  });

  it("exposes what the simulated approval page needs", async () => {
    const order = await provider.createOrder(orderInput());
    await expect(provider.checkout(order.orderId)).resolves.toEqual({
      order,
      description: "PACT ctr_simulated001 · 3 illustrations · Northwind Studio",
      returnUrl: "https://pact.example/deals/deal_sim/return",
      cancelUrl: "https://pact.example/deals/deal_sim/cancel",
    });
  });

  it("answers INVALID_RESOURCE_ID for unknown ids, including an id of the wrong kind", async () => {
    const order = await authorizedOrder();
    await expect(issueOf(provider.getOrder("SIM-O-UNKNOWN"))).resolves.toBe("INVALID_RESOURCE_ID");
    await expect(issueOf(provider.approve("SIM-O-UNKNOWN"))).resolves.toBe("INVALID_RESOURCE_ID");
    await expect(issueOf(provider.authorizeOrder("SIM-O-UNKNOWN", "k"))).resolves.toBe("INVALID_RESOURCE_ID");
    await expect(issueOf(provider.getAuthorization("SIM-A-UNKNOWN"))).resolves.toBe("INVALID_RESOURCE_ID");
    await expect(issueOf(provider.getAuthorization(order.orderId))).resolves.toBe("INVALID_RESOURCE_ID");
    await expect(issueOf(capture("SIM-A-UNKNOWN", 100, "k"))).resolves.toBe("INVALID_RESOURCE_ID");
    await expect(issueOf(provider.voidAuthorization("SIM-A-UNKNOWN", "k"))).resolves.toBe("INVALID_RESOURCE_ID");
  });
});

describe("SimulatedProvider — capture and void", () => {
  it("captures the full amount once; the same key replays, another key is AUTHORIZATION_ALREADY_CAPTURED", async () => {
    const order = await authorizedOrder();
    const first = await capture(order.authorizationId, 9000, "capture-1");
    expect(first).toEqual({
      captureId: expect.stringMatching(/^SIM-C-[0-9A-F]{16}$/) as string,
      status: "COMPLETED",
      amountMinor: 9000,
      currency: "USD",
      finalCapture: true,
    });
    await expect(capture(order.authorizationId, 9000, "capture-1")).resolves.toEqual(first);
    await expect(issueOf(capture(order.authorizationId, 9000, "capture-2"))).resolves.toBe("AUTHORIZATION_ALREADY_CAPTURED");
    await expect(provider.getAuthorization(order.authorizationId)).resolves.toMatchObject({ status: "CAPTURED" });
  });

  it("rejects a capture above the authorized amount and leaves the authorization open", async () => {
    const order = await authorizedOrder();
    await expect(issueOf(capture(order.authorizationId, 9001, "capture-1"))).resolves.toBe("MAX_CAPTURE_AMOUNT_EXCEEDED");
    await expect(issueOf(capture(order.authorizationId, 0, "capture-1"))).resolves.toBe("INVALID_PARAMETER_VALUE");
    await expect(provider.getAuthorization(order.authorizationId)).resolves.toMatchObject({ status: "CREATED" });
  });

  it("treats a partial final capture as final: PARTIALLY_CAPTURED, no further capture, no void", async () => {
    const order = await authorizedOrder();
    await expect(capture(order.authorizationId, 4500, "capture-1")).resolves.toMatchObject({ amountMinor: 4500, finalCapture: true });
    await expect(provider.getAuthorization(order.authorizationId)).resolves.toMatchObject({ status: "PARTIALLY_CAPTURED" });
    await expect(issueOf(capture(order.authorizationId, 4500, "capture-2"))).resolves.toBe("AUTHORIZATION_ALREADY_CAPTURED");
    await expect(issueOf(provider.voidAuthorization(order.authorizationId, "void-1"))).resolves.toBe("PREVIOUSLY_CAPTURED");
  });

  it("voids once; the same key replays, another key is PREVIOUSLY_VOIDED, and capture is AUTHORIZATION_VOIDED", async () => {
    const order = await authorizedOrder();
    await expect(provider.voidAuthorization(order.authorizationId, "void-1")).resolves.toBeUndefined();
    await expect(provider.getAuthorization(order.authorizationId)).resolves.toMatchObject({ status: "VOIDED" });
    await expect(provider.voidAuthorization(order.authorizationId, "void-1")).resolves.toBeUndefined();
    await expect(issueOf(provider.voidAuthorization(order.authorizationId, "void-2"))).resolves.toBe("PREVIOUSLY_VOIDED");
    await expect(issueOf(capture(order.authorizationId, 9000, "capture-1"))).resolves.toBe("AUTHORIZATION_VOIDED");
  });

  it("refuses to void after a capture", async () => {
    const order = await authorizedOrder();
    await capture(order.authorizationId, 9000, "capture-1");
    await expect(issueOf(provider.voidAuthorization(order.authorizationId, "void-1"))).resolves.toBe("PREVIOUSLY_CAPTURED");
  });

  it("refuses to capture an expired authorization", async () => {
    const order = await authorizedOrder();
    nowMs = START + 29 * DAY_MS;
    await expect(issueOf(capture(order.authorizationId, 9000, "capture-1"))).resolves.toBe("AUTHORIZATION_EXPIRED");
  });

  it("reauthorizes only after the honor period, issuing a new authorization and retiring the old one", async () => {
    const order = await authorizedOrder();
    await expect(issueOf(provider.reauthorize(order.authorizationId, 9000, "reauth-1"))).resolves.toBe("REAUTHORIZATION_TOO_SOON");

    nowMs = START + 4 * DAY_MS;
    const renewed = await provider.reauthorize(order.authorizationId, 9000, "reauth-1");
    expect(renewed.authorizationId).not.toBe(order.authorizationId);
    expect(renewed).toMatchObject({ status: "CREATED", amountMinor: 9000, expiresAt: new Date(nowMs + 29 * DAY_MS).toISOString() });
    await expect(provider.reauthorize(order.authorizationId, 9000, "reauth-1")).resolves.toEqual(renewed);
    await expect(provider.getAuthorization(order.authorizationId)).resolves.toMatchObject({ status: "VOIDED" });
    await expect(provider.getOrder(order.orderId)).resolves.toMatchObject({ authorization: { authorizationId: renewed.authorizationId } });
  });
});

describe("SimulatedProvider — delegated wallet", () => {
  it("vaults a wallet through the setup-token exchange without exposing the payer's address", async () => {
    const setup = await provider.createVaultSetup({
      returnUrl: "https://pact.example/wallet/return?owner=demo",
      cancelUrl: "https://pact.example/wallet/cancel",
      idempotencyKey: "vault-setup-1",
    });
    expect(setup.setupTokenId).toMatch(/^SIM-S-[0-9A-F]{16}$/);
    expect(setup.approveUrl).toBe(`https://pact.example/wallet/return?owner=demo&approval_token_id=${setup.setupTokenId}`);

    const wallet = await provider.exchangeVaultSetup(setup.setupTokenId, "vault-exchange-1");
    expect(wallet.vaultId).toMatch(/^SIM-V-[0-9A-F]{16}$/);
    expect(wallet.payerEmailMasked).toBe("si****@personal.example.com");
    await expect(provider.exchangeVaultSetup(setup.setupTokenId, "vault-exchange-2")).resolves.toEqual(wallet);
    await expect(issueOf(provider.exchangeVaultSetup("SIM-S-UNKNOWN", "k"))).resolves.toBe("INVALID_RESOURCE_ID");
  });

  it("authorizes an order against a vaulted wallet in a single step", async () => {
    const setup = await provider.createVaultSetup({
      returnUrl: "https://pact.example/wallet/return",
      cancelUrl: "https://pact.example/wallet/cancel",
      idempotencyKey: "vault-setup-1",
    });
    const { vaultId } = await provider.exchangeVaultSetup(setup.setupTokenId, "vault-exchange-1");

    const order = await provider.createOrder(orderInput({ vaultId }));
    expect(order).toMatchObject({
      status: "COMPLETED",
      approveUrl: null,
      payerEmailMasked: "si****@personal.example.com",
      vaultId: null,
      authorization: { status: "CREATED", amountMinor: 9000, customId: `pact:v1:${CONTRACT_HASH}` },
    });
    // Replaying the create returns the same order and the same single authorization.
    const replay = await provider.createOrder(orderInput({ vaultId }));
    expect(replay).toEqual(order);
  });

  it("rejects an unknown vault id", async () => {
    await expect(issueOf(provider.createOrder(orderInput({ vaultId: "SIM-V-UNKNOWN" })))).resolves.toBe("INVALID_RESOURCE_ID");
  });
});

describe("SimulatedProvider — storage", () => {
  it("keeps state in the store, so another provider instance on the same store sees it", async () => {
    const store = createMemorySimulatedStore();
    const first = new SimulatedProvider(store);
    const order = await first.createOrder(orderInput());
    const second = new SimulatedProvider(store);
    await expect(second.getOrder(order.orderId)).resolves.toEqual(order);
  });

  it("defaults to a process-wide store that survives module reloads", async () => {
    const order = await new SimulatedProvider().createOrder(orderInput({ idempotencyKey: `global-${START}` }));
    await expect(new SimulatedProvider().getOrder(order.orderId)).resolves.toEqual(order);
  });
});
