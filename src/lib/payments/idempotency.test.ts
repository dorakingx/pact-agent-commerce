import { describe, expect, it } from "vitest";
import { idempotencyKey } from "./idempotency";
import type { PaymentOperationKind } from "./types";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("idempotencyKey", () => {
  it("is UUID-shaped: 36 chars, 8-4-4-4-12 lowercase hex, version 8 / RFC variant", () => {
    const key = idempotencyKey("capture", "deal_1", "AUTH-1");
    expect(key).toHaveLength(36);
    expect(key).toMatch(UUID_SHAPE);
  });

  it("is deterministic: the same operation on the same ids always yields the same key", () => {
    expect(idempotencyKey("capture", "deal_1", "AUTH-1")).toBe(idempotencyKey("capture", "deal_1", "AUTH-1"));
  });

  it("differs per operation kind, so a capture and a void of one authorization never share a key", () => {
    const kinds: PaymentOperationKind[] = [
      "create_order",
      "authorize",
      "capture",
      "void",
      "reauthorize",
      "vault_setup",
      "vault_exchange",
    ];
    const keys = kinds.map((kind) => idempotencyKey(kind, "deal_1", "AUTH-1"));
    expect(new Set(keys).size).toBe(kinds.length);
  });

  it("differs when any part differs", () => {
    const base = idempotencyKey("capture", "deal_1", "AUTH-1");
    expect(idempotencyKey("capture", "deal_2", "AUTH-1")).not.toBe(base);
    expect(idempotencyKey("capture", "deal_1", "AUTH-2")).not.toBe(base);
    expect(idempotencyKey("capture", "deal_1")).not.toBe(base);
  });

  it("keeps part boundaries: moving a character between parts changes the key", () => {
    expect(idempotencyKey("capture", "a", "bc")).not.toBe(idempotencyKey("capture", "ab", "c"));
    expect(idempotencyKey("capture", "a,b")).not.toBe(idempotencyKey("capture", "a", "b"));
    expect(idempotencyKey("capture", "", "a")).not.toBe(idempotencyKey("capture", "a", ""));
  });

  it("is stable across releases (a changed derivation would orphan every key already sent to PayPal)", () => {
    expect(idempotencyKey("capture", "deal_1", "AUTH-1")).toBe("002b1977-e161-82ba-b4fe-a64ac59302a5");
  });
});
