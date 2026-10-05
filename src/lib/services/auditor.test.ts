/**
 * The deterministic half of a reconciliation: which facts are compared and when they agree.
 * The service around it (PayPal reads, the auditor agent, the audit entry, the rate limit) is
 * exercised against a database in tests/integration/ops-reconcile.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { ReconciliationFact } from "@/lib/api/dto";
import { paymentFixture } from "@/lib/db/test-fixtures";
import { paypalCustomId } from "@/lib/domain/contract";
import { signedContractFor } from "@/lib/domain/test-support";
import type { AuthorizationInfo, OrderInfo, PaymentRecord } from "@/lib/payments";
import { buildReconciliationFacts } from "./auditor";

const NOW = new Date("2026-10-06T05:00:00.000Z");
const EXPIRES_AT = "2026-11-04T05:00:00.000Z";
const SIGNED = signedContractFor("happy-path"); // $47.00
const CUSTOM_ID = paypalCustomId(SIGNED);
const INVOICE_ID = SIGNED.contract.contractId;

function payment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return paymentFixture({
    provider: "paypal_sandbox",
    status: "authorized",
    orderId: "ORDER-1",
    authorizationId: "AUTH-1",
    amountMinor: 4_700,
    authorizedMinor: 4_700,
    capturedMinor: 0,
    authorizationExpiresAt: EXPIRES_AT,
    ...overrides,
  });
}

function order(overrides: Partial<OrderInfo> = {}): OrderInfo {
  return {
    orderId: "ORDER-1",
    status: "COMPLETED",
    amountMinor: 4_700,
    currency: "USD",
    customId: CUSTOM_ID,
    invoiceId: INVOICE_ID,
    approveUrl: null,
    authorization: null,
    payerEmailMasked: "sb****@personal.example.com",
    vaultId: null,
    ...overrides,
  };
}

function authorization(overrides: Partial<AuthorizationInfo> = {}): AuthorizationInfo {
  return {
    authorizationId: "AUTH-1",
    status: "CREATED",
    amountMinor: 4_700,
    currency: "USD",
    expiresAt: EXPIRES_AT,
    customId: CUSTOM_ID,
    invoiceId: INVOICE_ID,
    ...overrides,
  };
}

interface Case {
  payment?: Partial<PaymentRecord>;
  order?: Partial<OrderInfo>;
  /** Null: PACT holds no authorization, so none is read. */
  authorization?: Partial<AuthorizationInfo> | null;
  now?: Date;
}

function facts(input: Case = {}): ReconciliationFact[] {
  return buildReconciliationFacts({
    signed: SIGNED,
    payment: payment(input.payment),
    order: order(input.order),
    authorization: input.authorization === null ? null : authorization(input.authorization),
    now: input.now ?? NOW,
  });
}

const differing = (list: ReconciliationFact[]): string[] => list.filter((fact) => !fact.match).map((fact) => fact.field);
const fact = (list: ReconciliationFact[], field: string): ReconciliationFact | undefined => list.find((item) => item.field === field);

describe("buildReconciliationFacts: a held authorization", () => {
  it("compares order, binding and authorization, and everything agrees", () => {
    expect(facts()).toEqual([
      { field: "Order status", pact: "authorized (expects COMPLETED)", paypal: "COMPLETED", match: true },
      { field: "Order amount", pact: "$47.00", paypal: "$47.00", match: true },
      { field: "Contract binding (custom_id)", pact: CUSTOM_ID, paypal: CUSTOM_ID, match: true },
      { field: "Invoice id", pact: INVOICE_ID, paypal: INVOICE_ID, match: true },
      { field: "Authorization status", pact: "authorized (expects CREATED)", paypal: "CREATED", match: true },
      { field: "Authorized amount", pact: "$47.00", paypal: "$47.00", match: true },
      { field: "Authorization expiry", pact: EXPIRES_AT, paypal: EXPIRES_AT, match: true },
    ]);
  });

  it("flags a hold PayPal has already released or captured behind PACT's back", () => {
    expect(differing(facts({ authorization: { status: "VOIDED" } }))).toEqual(["Authorization status"]);
    expect(differing(facts({ authorization: { status: "CAPTURED" } }))).toEqual(["Authorization status"]);
    expect(differing(facts({ authorization: { status: "DENIED" } }))).toEqual(["Authorization status"]);
  });
});

describe("buildReconciliationFacts: captures", () => {
  const captured = { status: "captured", capturedMinor: 4_700, captureId: "CAP-1" } as const;

  it("a full capture agrees with CAPTURED and with nothing else", () => {
    const list = facts({ payment: captured, authorization: { status: "CAPTURED" } });
    expect(differing(list)).toEqual([]);
    expect(fact(list, "Authorization status")?.pact).toBe("captured (expects CAPTURED)");
    expect(fact(list, "Order status")?.pact).toBe("captured (expects COMPLETED)");

    // PayPal saying "partially" means it captured less than PACT believes.
    expect(differing(facts({ payment: captured, authorization: { status: "PARTIALLY_CAPTURED" } }))).toEqual(["Authorization status"]);
    expect(differing(facts({ payment: captured, authorization: { status: "CREATED" } }))).toEqual(["Authorization status"]);
  });

  it("a partial release agrees with PARTIALLY_CAPTURED, and the authorized amount is still compared in full", () => {
    const partial = { status: "captured", authorizedMinor: 4_700, capturedMinor: 2_350, captureId: "CAP-2" } as const;
    const list = facts({ payment: partial, authorization: { status: "PARTIALLY_CAPTURED" } });
    expect(differing(list)).toEqual([]);
    expect(fact(list, "Authorization status")).toEqual({
      field: "Authorization status",
      pact: "captured (expects PARTIALLY_CAPTURED)",
      paypal: "PARTIALLY_CAPTURED",
      match: true,
    });
    expect(fact(list, "Authorized amount")).toMatchObject({ pact: "$47.00", paypal: "$47.00", match: true });

    expect(differing(facts({ payment: partial, authorization: { status: "CAPTURED" } }))).toEqual(["Authorization status"]);
  });
});

describe("buildReconciliationFacts: released holds", () => {
  it("a voided authorization agrees with VOIDED; a hold PayPal still has is a difference", () => {
    const list = facts({ payment: { status: "voided" }, authorization: { status: "VOIDED" } });
    expect(differing(list)).toEqual([]);
    expect(fact(list, "Authorization status")?.pact).toBe("voided (expects VOIDED)");
    expect(differing(facts({ payment: { status: "voided" }, authorization: { status: "CREATED" } }))).toEqual(["Authorization status"]);
  });

  it("an expired authorization agrees with VOIDED, and with a lapsed hold PayPal still lists as CREATED", () => {
    const expired = { status: "expired" } as const;
    expect(differing(facts({ payment: expired, authorization: { status: "VOIDED" } }))).toEqual([]);

    const afterExpiry = new Date("2026-11-05T00:00:00.000Z");
    const lapsed = facts({ payment: expired, authorization: { status: "CREATED" }, now: afterExpiry });
    expect(differing(lapsed)).toEqual([]);
    expect(fact(lapsed, "Authorization status")?.pact).toBe("expired (expects VOIDED or CREATED)");
    // Before the expiry time a live hold contradicts "expired".
    expect(differing(facts({ payment: expired, authorization: { status: "CREATED" } }))).toEqual(["Authorization status"]);
  });

  it("a failed payment must not leave funds held at PayPal", () => {
    const failed = { status: "failed" } as const;
    expect(differing(facts({ payment: failed, authorization: { status: "DENIED" } }))).toEqual([]);
    expect(differing(facts({ payment: failed, authorization: { status: "VOIDED" } }))).toEqual([]);
    const held = facts({ payment: failed, authorization: { status: "CREATED" } });
    expect(differing(held)).toEqual(["Authorization status"]);
    expect(fact(held, "Authorization status")?.pact).toBe("failed (expects DENIED or VOIDED)");
  });
});

describe("buildReconciliationFacts: amounts and contract binding", () => {
  it("flags an order amount that differs from the ledger", () => {
    const list = facts({ order: { amountMinor: 4_900 } });
    expect(differing(list)).toEqual(["Order amount"]);
    expect(fact(list, "Order amount")).toEqual({ field: "Order amount", pact: "$47.00", paypal: "$49.00", match: false });
  });

  it("flags an authorization for a different amount than PACT recorded", () => {
    const list = facts({ authorization: { amountMinor: 47 } });
    expect(differing(list)).toEqual(["Authorized amount"]);
    expect(fact(list, "Authorized amount")).toMatchObject({ pact: "$47.00", paypal: "$0.47" });
  });

  it("flags an order bound to another contract, or to none", () => {
    const other = paypalCustomId(signedContractFor("revision", { contractId: "ctr_other00000001" }));
    expect(other).not.toBe(CUSTOM_ID);
    const wrong = facts({ order: { customId: other } });
    expect(differing(wrong)).toEqual(["Contract binding (custom_id)"]);
    expect(fact(wrong, "Contract binding (custom_id)")).toEqual({
      field: "Contract binding (custom_id)",
      pact: CUSTOM_ID,
      paypal: other,
      match: false,
    });
    expect(differing(facts({ order: { customId: null } }))).toEqual(["Contract binding (custom_id)"]);
  });

  it("does not let a tampered stored contract vouch for the order", () => {
    const tampered = { ...SIGNED, contract: { ...SIGNED.contract, price: { amountMinor: 100, currency: "USD" as const } } };
    const list = buildReconciliationFacts({ signed: tampered, payment: payment(), order: order(), authorization: authorization(), now: NOW });
    expect(differing(list)).toEqual(["Contract binding (custom_id)"]);
    expect(fact(list, "Contract binding (custom_id)")?.pact).toBe(`${CUSTOM_ID} (the stored contract no longer matches this hash)`);
  });

  it("flags a different invoice id", () => {
    expect(differing(facts({ order: { invoiceId: "ctr_someoneelse1" } }))).toEqual(["Invoice id"]);
    expect(differing(facts({ order: { invoiceId: null } }))).toEqual(["Invoice id"]);
  });

  it("compares the expiry as an instant, whatever notation each side uses", () => {
    const sameInstant = facts({ authorization: { expiresAt: "2026-11-04T05:00:00Z" } });
    expect(fact(sameInstant, "Authorization expiry")).toEqual({
      field: "Authorization expiry",
      pact: EXPIRES_AT,
      paypal: EXPIRES_AT,
      match: true,
    });
    expect(fact(facts({ authorization: { expiresAt: "2026-11-04T14:00:00+09:00" } }), "Authorization expiry")?.match).toBe(true);

    const later = facts({ authorization: { expiresAt: "2026-11-05T05:00:00.000Z" } });
    expect(differing(later)).toEqual(["Authorization expiry"]);
    expect(differing(facts({ authorization: { expiresAt: null } }))).toEqual(["Authorization expiry"]);
    const neither = facts({ payment: { authorizationExpiresAt: null }, authorization: { expiresAt: null } });
    expect(fact(neither, "Authorization expiry")).toMatchObject({ pact: null, paypal: null, match: true });
  });
});

describe("buildReconciliationFacts: before any authorization", () => {
  const awaitingPayer = { status: "created", authorizationId: null, authorizedMinor: 0, authorizationExpiresAt: null } as const;

  it("compares only the order while PACT holds no authorization", () => {
    const list = facts({ payment: awaitingPayer, order: { status: "PAYER_ACTION_REQUIRED" }, authorization: null });
    expect(list.map((item) => item.field)).toEqual(["Order status", "Order amount", "Contract binding (custom_id)", "Invoice id"]);
    expect(differing(list)).toEqual([]);
    expect(list[0].pact).toBe("created (expects CREATED, SAVED or PAYER_ACTION_REQUIRED)");
  });

  it("flags an approval or an authorization PayPal has that PACT has not recorded", () => {
    expect(differing(facts({ payment: awaitingPayer, order: { status: "APPROVED" }, authorization: null }))).toEqual(["Order status"]);
    expect(differing(facts({ payment: awaitingPayer, order: { status: "COMPLETED" }, authorization: null }))).toEqual(["Order status"]);
    const approved = facts({ payment: { ...awaitingPayer, status: "approved" }, order: { status: "APPROVED" }, authorization: null });
    expect(differing(approved)).toEqual([]);
  });

  it("an order the payer cancelled was never completed", () => {
    const cancelled = { ...awaitingPayer, status: "voided" } as const;
    for (const status of ["PAYER_ACTION_REQUIRED", "CREATED", "APPROVED", "VOIDED"] as const) {
      expect(differing(facts({ payment: cancelled, order: { status }, authorization: null }))).toEqual([]);
    }
    // Completed means PayPal authorized it after all: money is held that PACT knows nothing about.
    expect(differing(facts({ payment: cancelled, order: { status: "COMPLETED" }, authorization: null }))).toEqual(["Order status"]);
  });

  it("a payment that never started expects no order at all", () => {
    const list = facts({ payment: { ...awaitingPayer, status: "none" }, order: { status: "CREATED" }, authorization: null });
    expect(list[0]).toEqual({ field: "Order status", pact: "none (expects no such record at PayPal)", paypal: "CREATED", match: false });
  });
});
