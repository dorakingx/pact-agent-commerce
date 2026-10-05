/**
 * Live PayPal Sandbox smoke tests — real HTTPS calls to api-m.sandbox.paypal.com.
 *
 * Skipped unless PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are set, e.g.
 *
 *   set -a; source .env.local; set +a; npm run test:sandbox
 *
 * The first group needs nothing but credentials: no payer ever approves, so no funds are held.
 * The delegated group additionally needs PAYPAL_TEST_VAULT_ID (a vaulted sandbox buyer wallet,
 * created once through the wallet-connect flow); it authorizes, captures and voids small
 * sandbox amounts without any browser interaction.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/domain/canonical";
import { idempotencyKey } from "@/lib/payments/idempotency";
import { PayPalSandboxProvider } from "@/lib/payments/paypal-client";
import { PaymentError, type CreateOrderInput } from "@/lib/payments/types";

const clientId = process.env.PAYPAL_CLIENT_ID ?? "";
const clientSecret = process.env.PAYPAL_CLIENT_SECRET ?? "";
const vaultId = process.env.PAYPAL_TEST_VAULT_ID ?? "";
const apiBase = process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";

/** Unique per run: PayPal rejects a reused invoice_id, and idempotency keys must not collide with earlier runs. */
const RUN = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

function orderInput(label: string, overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
  const dealId = `deal_live${RUN}${label}`;
  const contractHash = sha256Hex(`pact-live-sandbox:${RUN}:${label}`);
  return {
    dealId,
    contractId: `ctr_live${RUN}${label}`,
    contractHash,
    amountMinor: 1234,
    currency: "USD",
    description: `PACT live sandbox test ${RUN} ${label}`,
    returnUrl: "https://example.com/pact/return",
    cancelUrl: "https://example.com/pact/cancel",
    idempotencyKey: idempotencyKey("create_order", dealId, contractHash),
    ...overrides,
  };
}

async function failure(action: Promise<unknown>): Promise<PaymentError> {
  const error: unknown = await action.then(
    () => new Error("expected PayPal to refuse the call"),
    (reason: unknown) => reason,
  );
  if (!(error instanceof PaymentError)) throw error;
  return error;
}

describe.skipIf(!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET)("PayPal Sandbox (live)", () => {
  const provider = () => new PayPalSandboxProvider({ clientId, clientSecret, apiBase });

  it("obtains a token and creates an AUTHORIZE order that waits for the payer, bound to the contract hash", async () => {
    const paypal = provider();
    const input = orderInput("a");
    const order = await paypal.createOrder(input);

    expect(order.status).toBe("PAYER_ACTION_REQUIRED");
    expect(order.authorization).toBeNull();
    expect(order.amountMinor).toBe(1234);
    expect(order.approveUrl).not.toBeNull();
    const approveUrl = new URL(order.approveUrl ?? "");
    expect(approveUrl.protocol).toBe("https:");
    expect(approveUrl.hostname).toMatch(/(^|\.)sandbox\.paypal\.com$/);

    // The binding must survive a round trip through PayPal's own record.
    const read = await paypal.getOrder(order.orderId);
    expect(read).toMatchObject({
      orderId: order.orderId,
      status: "PAYER_ACTION_REQUIRED",
      amountMinor: 1234,
      currency: "USD",
      customId: `pact:v1:${input.contractHash}`,
      invoiceId: input.contractId,
      authorization: null,
    });
  });

  it("returns the same order when the create is replayed with the same PayPal-Request-Id", async () => {
    const paypal = provider();
    const input = orderInput("b");
    const first = await paypal.createOrder(input);
    const replay = await paypal.createOrder(input);
    expect(replay.orderId).toBe(first.orderId);
    expect(replay.customId).toBe(first.customId);
  });

  it("refuses to authorize an order the payer has not approved (ORDER_NOT_APPROVED, with a debug id)", async () => {
    const paypal = provider();
    const input = orderInput("c");
    const order = await paypal.createOrder(input);
    const error = await failure(paypal.authorizeOrder(order.orderId, idempotencyKey("authorize", input.dealId, order.orderId)));
    expect(error.issue).toBe("ORDER_NOT_APPROVED");
    expect(error.httpStatus).toBe(422);
    expect(error.retryable).toBe(false);
    expect(error.debugId).toEqual(expect.any(String));
    // Nothing was authorized.
    await expect(paypal.getOrder(order.orderId)).resolves.toMatchObject({ status: "PAYER_ACTION_REQUIRED", authorization: null });
  });

  it("reports an unknown order as INVALID_RESOURCE_ID", async () => {
    const error = await failure(provider().getOrder("0PACT0UNKNOWN0000"));
    expect(error.issue).toBe("INVALID_RESOURCE_ID");
    expect(error.httpStatus).toBe(404);
  });

  describe.skipIf(!process.env.PAYPAL_TEST_VAULT_ID)("delegated agent wallet", () => {
    it("authorizes in a single step, captures once, and PayPal shows the authorization as CAPTURED", async () => {
      const paypal = provider();
      const input = orderInput("d", { vaultId });
      const order = await paypal.createOrder(input);
      expect(order.approveUrl).toBeNull();
      expect(order.authorization).toMatchObject({
        status: "CREATED",
        amountMinor: 1234,
        customId: `pact:v1:${input.contractHash}`,
      });
      const authorizationId = order.authorization?.authorizationId ?? "";
      expect(order.authorization?.expiresAt).not.toBeNull();

      const captureKey = idempotencyKey("capture", input.dealId, authorizationId);
      const capture = await paypal.captureAuthorization({
        authorizationId,
        amountMinor: 1234,
        currency: "USD",
        finalCapture: true,
        invoiceId: input.contractId,
        noteToPayer: "PACT live sandbox test capture.",
        idempotencyKey: captureKey,
      });
      expect(capture.amountMinor).toBe(1234);
      expect(["COMPLETED", "PENDING"]).toContain(capture.status);

      // Replaying the capture with the same key must not capture again.
      const replay = await paypal.captureAuthorization({
        authorizationId,
        amountMinor: 1234,
        currency: "USD",
        finalCapture: true,
        invoiceId: input.contractId,
        noteToPayer: "PACT live sandbox test capture.",
        idempotencyKey: captureKey,
      });
      expect(replay.captureId).toBe(capture.captureId);

      await expect(paypal.getAuthorization(authorizationId)).resolves.toMatchObject({ status: "CAPTURED" });
    });

    it("authorizes a second order and voids it, and PayPal shows the authorization as VOIDED", async () => {
      const paypal = provider();
      const input = orderInput("e", { vaultId });
      const order = await paypal.createOrder(input);
      const authorizationId = order.authorization?.authorizationId ?? "";
      expect(order.authorization?.status).toBe("CREATED");

      await paypal.voidAuthorization(authorizationId, idempotencyKey("void", input.dealId, authorizationId));
      await expect(paypal.getAuthorization(authorizationId)).resolves.toMatchObject({ status: "VOIDED" });

      const error = await failure(
        paypal.captureAuthorization({
          authorizationId,
          amountMinor: 1234,
          currency: "USD",
          finalCapture: true,
          invoiceId: input.contractId,
          noteToPayer: "PACT live sandbox test capture after void.",
          idempotencyKey: idempotencyKey("capture", input.dealId, authorizationId),
        }),
      );
      expect(error.retryable).toBe(false);
      expect(error.httpStatus).toBe(422);
    });
  });
});
