import { describe, expect, it } from "vitest";
import { createMemoryLedger } from "./ledger";

const OPERATION = { key: "key-1", dealId: "deal_1", kind: "capture", request: { amountMinor: 9000 } } as const;
const ERROR = { issue: "TIMEOUT", message: "PayPal did not answer", debugId: null };

describe("createMemoryLedger", () => {
  it("reports an unknown key as new and records the request", async () => {
    const ledger = createMemoryLedger();
    await expect(ledger.begin(OPERATION)).resolves.toEqual({ state: "new" });
    expect(ledger.entries().get("key-1")).toMatchObject({
      dealId: "deal_1",
      kind: "capture",
      status: "started",
      request: { amountMinor: 9000 },
      attempts: 1,
    });
  });

  it("replays a recorded success instead of allowing a second call", async () => {
    const ledger = createMemoryLedger();
    await ledger.begin(OPERATION);
    await ledger.succeed("key-1", { captureId: "CAP-1" });
    await expect(ledger.begin(OPERATION)).resolves.toEqual({ state: "succeeded", response: { captureId: "CAP-1" } });
    await expect(ledger.begin(OPERATION)).resolves.toEqual({ state: "succeeded", response: { captureId: "CAP-1" } });
  });

  it("reports an attempt that never recorded an outcome (a crash) as retry, counting attempts", async () => {
    const ledger = createMemoryLedger();
    await ledger.begin(OPERATION);
    await expect(ledger.begin(OPERATION)).resolves.toEqual({ state: "retry", attempts: 2 });
    await expect(ledger.begin(OPERATION)).resolves.toEqual({ state: "retry", attempts: 3 });
  });

  it("reports a transient failure as retry and a terminal failure as failed", async () => {
    const ledger = createMemoryLedger();
    await ledger.begin(OPERATION);
    await ledger.fail("key-1", ERROR, { retryable: true });
    await expect(ledger.begin(OPERATION)).resolves.toEqual({ state: "retry", attempts: 2 });

    const declined = { issue: "INSTRUMENT_DECLINED", message: "Declined", debugId: "dbg-1" };
    await ledger.fail("key-1", declined, { retryable: false });
    await expect(ledger.begin(OPERATION)).resolves.toEqual({ state: "failed", error: declined });
  });

  it("never lets a late failure report reopen a recorded success", async () => {
    const ledger = createMemoryLedger();
    await ledger.begin(OPERATION);
    await ledger.succeed("key-1", { captureId: "CAP-1" });
    await ledger.fail("key-1", ERROR, { retryable: true });
    await expect(ledger.begin(OPERATION)).resolves.toMatchObject({ state: "succeeded" });
  });

  it("refuses to reuse a key for a different operation or deal", async () => {
    const ledger = createMemoryLedger();
    await ledger.begin(OPERATION);
    await expect(ledger.begin({ ...OPERATION, kind: "void" })).rejects.toThrow(/already belongs to capture/);
    await expect(ledger.begin({ ...OPERATION, dealId: "deal_2" })).rejects.toThrow(/deal deal_1/);
  });

  it("rejects outcomes for operations that were never begun", async () => {
    const ledger = createMemoryLedger();
    await expect(ledger.succeed("missing", {})).rejects.toThrow(/no operation/);
    await expect(ledger.fail("missing", ERROR, { retryable: false })).rejects.toThrow(/no operation/);
  });

  it("stores copies, so later mutation of a request or response cannot rewrite history", async () => {
    const ledger = createMemoryLedger();
    const request = { amountMinor: 9000 };
    await ledger.begin({ ...OPERATION, request });
    request.amountMinor = 1;
    const response = { captureId: "CAP-1" };
    await ledger.succeed("key-1", response);
    response.captureId = "CAP-2";
    expect(ledger.entries().get("key-1")).toMatchObject({ request: { amountMinor: 9000 }, response: { captureId: "CAP-1" } });
  });
});
