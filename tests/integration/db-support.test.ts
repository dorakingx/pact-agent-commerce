import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDb,
  createDbSimulatedStore,
  createTestDb,
  deleteWallet,
  getPolicyDoc,
  getWallet,
  getWebhookEvent,
  hitRateLimit,
  insertDeal,
  InvalidRecordError,
  markWebhookProcessed,
  recordWebhookEvent,
  upsertPolicyDoc,
  upsertWallet,
  withTransaction,
  type Db,
  type WebhookEventInput,
} from "@/lib/db";
import { dealFixture, uniqueId } from "@/lib/db/test-fixtures";
import { DEFAULT_POLICY, type Policy } from "@/lib/domain/schemas";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("supporting repositories", () => {
  let db: Db;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await closeDb(db);
  });

  describe("policies", () => {
    it("returns null until an owner saves a policy, then the saved document", async () => {
      const owner = uniqueId("owner");
      expect(await getPolicyDoc(db, owner)).toBeNull();

      await upsertPolicyDoc(db, owner, DEFAULT_POLICY);
      expect(await getPolicyDoc(db, owner)).toEqual(DEFAULT_POLICY);
    });

    it("replaces the document on a second save and keeps owners separate", async () => {
      const owner = uniqueId("owner");
      const stricter: Policy = { ...DEFAULT_POLICY, autonomousLimitMinor: 2_500, allowedCategories: ["copywriting"] };
      await upsertPolicyDoc(db, owner, DEFAULT_POLICY);
      await upsertPolicyDoc(db, owner, stricter);

      expect(await getPolicyDoc(db, owner)).toEqual(stricter);
      expect(await getPolicyDoc(db, uniqueId("owner"))).toBeNull();
    });

    it("refuses a policy that violates its own schema", async () => {
      const inverted: Policy = { ...DEFAULT_POLICY, autonomousLimitMinor: 200_000, maxTransactionMinor: 100_000 };

      await expect(upsertPolicyDoc(db, uniqueId("owner"), inverted)).rejects.toBeInstanceOf(InvalidRecordError);
    });
  });

  describe("wallets", () => {
    it("creates, replaces and deletes an owner's wallet", async () => {
      const owner = uniqueId("owner");
      expect(await getWallet(db, owner)).toBeNull();

      await upsertWallet(db, {
        owner,
        provider: "paypal_sandbox",
        status: "pending",
        setupTokenId: "SETUP-1",
        vaultId: null,
        payerEmailMasked: null,
      });
      const pending = await getWallet(db, owner);
      expect(pending).toMatchObject({ status: "pending", setupTokenId: "SETUP-1", vaultId: null });
      expect(pending?.createdAt).toMatch(ISO_UTC);

      await new Promise((resolve) => setTimeout(resolve, 5));
      await upsertWallet(db, {
        owner,
        provider: "paypal_sandbox",
        status: "active",
        setupTokenId: null,
        vaultId: "VAULT-1",
        payerEmailMasked: "sb****@personal.example.com",
      });
      const active = await getWallet(db, owner);
      expect(active).toMatchObject({
        status: "active",
        setupTokenId: null,
        vaultId: "VAULT-1",
        payerEmailMasked: "sb****@personal.example.com",
        createdAt: pending?.createdAt,
      });
      expect(new Date(active?.updatedAt ?? 0).getTime()).toBeGreaterThan(new Date(pending?.updatedAt ?? 0).getTime());

      await deleteWallet(db, owner);
      expect(await getWallet(db, owner)).toBeNull();
      await expect(deleteWallet(db, owner)).resolves.toBeUndefined();
    });
  });

  describe("webhook events", () => {
    function webhook(overrides: Partial<WebhookEventInput> = {}): WebhookEventInput {
      return {
        id: uniqueId("WH"),
        eventType: "PAYMENT.AUTHORIZATION.CREATED",
        resourceId: "AUTH-1",
        verified: true,
        verificationMethod: "self",
        payload: { id: "evt", resource: { id: "AUTH-1" } },
        ...overrides,
      };
    }

    it("records the first delivery and deduplicates every redelivery on PayPal's event id", async () => {
      const event = webhook();

      expect(await recordWebhookEvent(db, event)).toEqual({ inserted: true, processed: false });
      expect(await recordWebhookEvent(db, event)).toEqual({ inserted: false, processed: false });
      // A redelivery never overwrites what was first received.
      expect(await recordWebhookEvent(db, { ...event, verified: false, payload: { forged: true } })).toEqual({
        inserted: false,
        processed: false,
      });

      const stored = await getWebhookEvent(db, event.id);
      expect(stored).toMatchObject({
        id: event.id,
        eventType: "PAYMENT.AUTHORIZATION.CREATED",
        resourceId: "AUTH-1",
        dealId: null,
        verified: true,
        verificationMethod: "self",
        processed: false,
        payload: event.payload,
      });
      expect(stored?.receivedAt).toMatch(ISO_UTC);
    });

    it("tells a redelivery whether the first delivery was fully processed", async () => {
      const deal = await insertDeal(db, dealFixture());
      const event = webhook();
      await recordWebhookEvent(db, event);

      await markWebhookProcessed(db, event.id, deal.id);

      expect(await recordWebhookEvent(db, event)).toEqual({ inserted: false, processed: true });
      expect(await getWebhookEvent(db, event.id)).toMatchObject({ processed: true, dealId: deal.id });
    });

    it("marks an uncorrelated event processed without inventing a deal", async () => {
      const event = webhook({ dealId: "deal_known_at_receipt", receivedAt: "2026-10-06T10:00:00+09:00" });
      await recordWebhookEvent(db, event);

      await markWebhookProcessed(db, event.id, null);

      expect(await getWebhookEvent(db, event.id)).toMatchObject({
        processed: true,
        dealId: "deal_known_at_receipt",
        receivedAt: "2026-10-06T01:00:00.000Z",
      });
    });

    it("does not abort a surrounding transaction when the event is a duplicate", async () => {
      const event = webhook();
      await recordWebhookEvent(db, event);

      const result = await withTransaction(db, async (tx) => {
        const duplicate = await recordWebhookEvent(tx, event);
        await markWebhookProcessed(tx, event.id, null);
        return duplicate;
      });

      expect(result.inserted).toBe(false);
      expect((await getWebhookEvent(db, event.id))?.processed).toBe(true);
    });

    it("returns null for an unknown event", async () => {
      expect(await getWebhookEvent(db, "WH-UNKNOWN")).toBeNull();
    });
  });

  describe("rate limit", () => {
    const start = new Date("2026-10-06T12:00:00.000Z");
    const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);

    it("allows up to the limit within a window, then blocks", async () => {
      const key = uniqueId("deal:create");

      expect(await hitRateLimit(db, key, 3, 60, start)).toEqual({
        allowed: true,
        remaining: 2,
        resetAt: "2026-10-06T12:01:00.000Z",
      });
      expect(await hitRateLimit(db, key, 3, 60, at(10))).toMatchObject({ allowed: true, remaining: 1 });
      expect(await hitRateLimit(db, key, 3, 60, at(20))).toMatchObject({ allowed: true, remaining: 0 });
      expect(await hitRateLimit(db, key, 3, 60, at(30))).toEqual({
        allowed: false,
        remaining: 0,
        resetAt: "2026-10-06T12:01:00.000Z",
      });
    });

    it("starts a fresh window once the previous one has run its full length", async () => {
      const key = uniqueId("deal:create");
      await hitRateLimit(db, key, 1, 60, start);
      expect(await hitRateLimit(db, key, 1, 60, at(59.999))).toMatchObject({ allowed: false });

      expect(await hitRateLimit(db, key, 1, 60, at(60))).toEqual({
        allowed: true,
        remaining: 0,
        resetAt: "2026-10-06T12:02:00.000Z",
      });
      expect(await hitRateLimit(db, key, 1, 60, at(61))).toMatchObject({ allowed: false });
    });

    it("counts concurrent hits exactly once each", async () => {
      const key = uniqueId("advance");

      const results = await Promise.all(Array.from({ length: 8 }, () => hitRateLimit(db, key, 5, 60, start)));

      expect(results.filter((result) => result.allowed)).toHaveLength(5);
      expect(results.map((result) => result.remaining).sort()).toEqual([0, 0, 0, 0, 1, 2, 3, 4]);
    });

    it("keeps keys independent", async () => {
      const first = uniqueId("ip");
      await hitRateLimit(db, first, 1, 60, start);

      expect(await hitRateLimit(db, uniqueId("ip"), 1, 60, start)).toMatchObject({ allowed: true });
      expect(await hitRateLimit(db, first, 1, 60, start)).toMatchObject({ allowed: false });
    });

    it("rejects a nonsensical limit or window", async () => {
      await expect(hitRateLimit(db, "k", 0, 60, start)).rejects.toThrow(RangeError);
      await expect(hitRateLimit(db, "k", 5, 0, start)).rejects.toThrow(RangeError);
    });
  });

  describe("simulated order store", () => {
    it("loads what was saved and overwrites on the next save", async () => {
      const store = createDbSimulatedStore(db);
      const id = uniqueId("SIM-ORDER");
      expect(await store.load(id)).toBeNull();

      await store.save(id, { status: "CREATED", amountMinor: 10_500 });
      expect(await store.load(id)).toEqual({ status: "CREATED", amountMinor: 10_500 });

      await store.save(id, { status: "COMPLETED", amountMinor: 10_500, authorization: { id: "SIM-AUTH" } });
      expect(await store.load(id)).toEqual({
        status: "COMPLETED",
        amountMinor: 10_500,
        authorization: { id: "SIM-AUTH" },
      });
    });
  });
});
