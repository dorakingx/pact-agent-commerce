import { describe, expect, it } from "vitest";
import type { AdvanceResponse, DealView, StepKind } from "@/lib/api/dto";
import type { DealStatus } from "@/lib/domain/status";
import { ApiClientError } from "./api";
import { auditEvent, deal } from "./deal-derive.fixtures";
import {
  BUSY_POLL_MS,
  DealRunner,
  MAX_BUSY_POLLS,
  MAX_IDLE_ANSWERS,
  MAX_TRIES,
  STEP_BEAT_MS,
  describeRequestFailure,
  retryDelayMs,
} from "./use-deal-runner-core";

const NOW = Date.parse("2026-10-06T10:00:00.000Z");

/** A deal at `status` whose audit trail has `version` entries, so later versions supersede earlier ones. */
function at(status: DealStatus, version: number, overrides: Partial<DealView> = {}): DealView {
  return deal({
    status,
    audit: Array.from({ length: version }, (_, index) => auditEvent(index + 1, "negotiation.move")),
    ...overrides,
  });
}

function ran(executed: StepKind, next: DealView): AdvanceResponse {
  return { deal: next, executed, busy: false };
}

type Scripted = AdvanceResponse | Error | (() => Promise<AdvanceResponse>);

interface Harness {
  runner: DealRunner;
  calls(): number;
  sleeps: number[];
  published: DealView[];
  signals: AbortSignal[];
  refreshes(): number;
}

function harness(script: Scripted[], options: { autoRun?: boolean; refreshed?: DealView } = {}): Harness {
  const sleeps: number[] = [];
  const published: DealView[] = [];
  const signals: AbortSignal[] = [];
  let calls = 0;
  let refreshes = 0;
  const runner = new DealRunner({
    advance: async (signal) => {
      calls += 1;
      signals.push(signal);
      const next = script.shift();
      if (next === undefined) throw new Error("the script has no more answers: the runner called advance too often");
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next() : next;
    },
    refresh: async () => {
      refreshes += 1;
      if (options.refreshed === undefined) throw new Error("unexpected refresh");
      return options.refreshed;
    },
    publish: (received) => published.push(received),
    // Waits are instant in tests, but still asynchronous and still abortable.
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      await Promise.resolve();
      if (signal.aborted) throw signal.reason;
    },
    now: () => NOW,
    autoRun: options.autoRun,
  });
  return { runner, calls: () => calls, sleeps, published, signals, refreshes: () => refreshes };
}

/** Lets every pending microtask (the whole loop, since waits are instant) run to its next real pause. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const transient = (): ApiClientError => new ApiClientError(503, "unavailable", "The service is busy.", "req_503", null);

describe("the loop", () => {
  it("runs one step per request, with a beat before each, until a human gate", async () => {
    const h = harness([ran("negotiate", at("agreed", 2)), ran("contract", at("contracted", 3)), ran("policy", at("awaiting_approval", 4))]);
    h.runner.start();
    h.runner.sync(at("negotiating", 1));
    await settle();
    expect(h.calls()).toBe(3);
    expect(h.sleeps).toEqual([STEP_BEAT_MS, STEP_BEAT_MS, STEP_BEAT_MS]);
    expect(h.published.map((entry) => entry.status)).toEqual(["agreed", "contracted", "awaiting_approval"]);
    expect(h.runner.getSnapshot()).toMatchObject({ phase: "idle", step: null, problem: null });
  });

  it("stops when the deal is done", async () => {
    const h = harness([ran("capture", at("completed", 2))]);
    h.runner.start();
    h.runner.sync(at("verified", 1));
    await settle();
    expect(h.calls()).toBe(1);
    expect(h.runner.getSnapshot().phase).toBe("idle");
  });

  it("never advances a deal the viewer does not own, a gate, or a finished deal", async () => {
    for (const view of [at("negotiating", 1, { isOwner: false }), at("awaiting_approval", 1), at("in_review", 1), at("completed", 1)]) {
      const h = harness([]);
      h.runner.start();
      h.runner.sync(view);
      await settle();
      expect(h.calls()).toBe(0);
      expect(h.sleeps).toEqual([]);
    }
  });

  it("does nothing before start()", async () => {
    const h = harness([]);
    h.runner.sync(at("negotiating", 1));
    await settle();
    expect(h.calls()).toBe(0);
  });

  it("names the step it is working on while it works", async () => {
    const pending = deferred<AdvanceResponse>();
    const h = harness([() => pending.promise]);
    h.runner.start();
    h.runner.sync(at("submitted", 1));
    await settle();
    expect(h.runner.getSnapshot()).toMatchObject({ phase: "running", step: "verify", attempt: 1 });
    pending.resolve(ran("verify", at("in_review", 2)));
    await settle();
    expect(h.runner.getSnapshot()).toMatchObject({ phase: "idle", step: null });
  });
});

describe("one advance at a time", () => {
  it("does not start a second request while one is in flight, whatever is called meanwhile", async () => {
    const pending = deferred<AdvanceResponse>();
    const h = harness([() => pending.promise, ran("contract", at("awaiting_approval", 3))]);
    h.runner.start();
    h.runner.sync(at("negotiating", 1));
    await settle();
    expect(h.calls()).toBe(1);

    h.runner.start();
    h.runner.sync(at("negotiating", 1));
    h.runner.runNext();
    h.runner.retry();
    h.runner.setAutoRun(false);
    h.runner.setAutoRun(true);
    await settle();
    expect(h.calls()).toBe(1);

    pending.resolve(ran("negotiate", at("agreed", 2)));
    await settle();
    expect(h.calls()).toBe(2);
  });

  it("survives stop() immediately followed by start(), as React strict mode does on mount", async () => {
    const h = harness([ran("negotiate", at("awaiting_approval", 2))]);
    h.runner.start();
    h.runner.sync(at("negotiating", 1));
    h.runner.stop();
    h.runner.start();
    h.runner.sync(at("negotiating", 1));
    await settle();
    // The first loop was aborted during its beat, before it sent anything.
    expect(h.calls()).toBe(1);
    expect(h.published.map((entry) => entry.status)).toEqual(["awaiting_approval"]);
  });
});

describe("abort", () => {
  it("stop() aborts the request in flight and nothing is published afterwards", async () => {
    const pending = deferred<AdvanceResponse>();
    const h = harness([() => pending.promise]);
    h.runner.start();
    h.runner.sync(at("negotiating", 1));
    await settle();
    expect(h.signals[0].aborted).toBe(false);

    h.runner.stop();
    expect(h.signals[0].aborted).toBe(true);
    pending.reject(new DOMException("Aborted", "AbortError"));
    await settle();
    expect(h.published).toEqual([]);
    expect(h.runner.getSnapshot()).toMatchObject({ phase: "idle", problem: null });
  });

  it("start() after stop() resumes the deal", async () => {
    const pending = deferred<AdvanceResponse>();
    const h = harness([() => pending.promise, ran("negotiate", at("awaiting_approval", 2))]);
    h.runner.start();
    h.runner.sync(at("negotiating", 1));
    await settle();
    h.runner.stop();
    pending.reject(new DOMException("Aborted", "AbortError"));
    await settle();

    h.runner.start();
    await settle();
    expect(h.calls()).toBe(2);
    expect(h.published.map((entry) => entry.status)).toEqual(["awaiting_approval"]);
  });
});

describe("busy", () => {
  it("waits a second and asks again while another request holds the lease", async () => {
    const same = at("authorized", 1);
    const h = harness([
      { deal: same, executed: null, busy: true },
      { deal: same, executed: null, busy: true },
      ran("fulfill", at("in_review", 2)),
    ]);
    h.runner.start();
    h.runner.sync(same);
    await settle();
    expect(h.calls()).toBe(3);
    expect(h.sleeps).toEqual([STEP_BEAT_MS, BUSY_POLL_MS, BUSY_POLL_MS]);
    expect(h.runner.getSnapshot().problem).toBeNull();
  });

  it("gives the human the choice after a very long wait instead of polling forever", async () => {
    const same = at("authorized", 1);
    const h = harness(Array.from({ length: MAX_BUSY_POLLS }, (): AdvanceResponse => ({ deal: same, executed: null, busy: true })));
    h.runner.start();
    h.runner.sync(same);
    await settle();
    expect(h.calls()).toBe(MAX_BUSY_POLLS);
    expect(h.runner.getSnapshot()).toMatchObject({ phase: "failed", problem: { kind: "request", code: "busy" } });
  });
});

describe("request failures", () => {
  it("retries a transient failure with exponential backoff", async () => {
    const h = harness([transient(), transient(), ran("verify", at("in_review", 2))]);
    h.runner.start();
    h.runner.sync(at("submitted", 1));
    await settle();
    expect(h.calls()).toBe(3);
    expect(h.sleeps).toEqual([STEP_BEAT_MS, 1000, 2000]);
    expect(h.runner.getSnapshot()).toMatchObject({ phase: "idle", problem: null });
  });

  it("stops after three tries with the error and its request id, and does not loop", async () => {
    const h = harness([transient(), transient(), transient()]);
    h.runner.start();
    h.runner.sync(at("submitted", 1));
    await settle();
    expect(h.calls()).toBe(MAX_TRIES);
    expect(h.runner.getSnapshot()).toMatchObject({
      phase: "failed",
      problem: { kind: "request", message: "The service is busy.", code: "unavailable", requestId: "req_503" },
    });
    await settle();
    expect(h.calls()).toBe(MAX_TRIES);
  });

  it("retry() clears the error and tries again at once, without the beat", async () => {
    const h = harness([transient(), transient(), transient(), ran("verify", at("in_review", 2))]);
    h.runner.start();
    h.runner.sync(at("submitted", 1));
    await settle();
    const sleepsBefore = h.sleeps.length;

    h.runner.retry();
    await settle();
    expect(h.calls()).toBe(4);
    expect(h.sleeps.length).toBe(sleepsBefore);
    expect(h.runner.getSnapshot()).toMatchObject({ phase: "idle", problem: null });
  });

  it("does not retry a failure that cannot heal", async () => {
    const h = harness([new ApiClientError(403, "forbidden", "You do not have access to this resource", "req_403", null)]);
    h.runner.start();
    h.runner.sync(at("submitted", 1));
    await settle();
    expect(h.calls()).toBe(1);
    expect(h.sleeps).toEqual([STEP_BEAT_MS]);
    expect(h.runner.getSnapshot()).toMatchObject({ phase: "failed", problem: { code: "forbidden" } });
  });

  it("reports an unexpected exception without leaking its text", async () => {
    const h = harness([new TypeError("cannot read properties of undefined")]);
    h.runner.start();
    h.runner.sync(at("submitted", 1));
    await settle();
    expect(h.runner.getSnapshot().problem).toEqual({
      kind: "request",
      message: "Something went wrong while advancing the deal.",
      code: null,
      requestId: null,
    });
  });

  it("on a conflict, looks at the deal again once: a deal that moved on is not an error", async () => {
    const h = harness([new ApiClientError(409, "conflict", "The deal is not at this step.", "req_409", null)], {
      refreshed: at("awaiting_payment", 2),
    });
    h.runner.start();
    h.runner.sync(at("payment_pending", 1));
    await settle();
    expect(h.refreshes()).toBe(1);
    expect(h.calls()).toBe(1);
    expect(h.published.map((entry) => entry.status)).toEqual(["awaiting_payment"]);
    expect(h.runner.getSnapshot()).toMatchObject({ phase: "idle", problem: null });
  });

  it("a conflict that repeats is an error", async () => {
    const conflict = (): ApiClientError => new ApiClientError(409, "conflict", "The deal is not at this step.", "req_409", null);
    const h = harness([conflict(), conflict()], { refreshed: at("payment_pending", 1) });
    h.runner.start();
    h.runner.sync(at("payment_pending", 1));
    await settle();
    expect(h.refreshes()).toBe(1);
    expect(h.calls()).toBe(2);
    expect(h.runner.getSnapshot()).toMatchObject({ phase: "failed", problem: { code: "conflict" } });
  });
});

describe("a step that did not complete", () => {
  const stalled = at("verified", 1, { lastError: "PayPal has not confirmed the capture yet." });

  it("stops at once with the engine's message and never retries by itself", async () => {
    const h = harness([{ deal: stalled, executed: null, busy: false }]);
    h.runner.start();
    h.runner.sync(at("verified", 1));
    await settle();
    expect(h.calls()).toBe(1);
    expect(h.runner.getSnapshot()).toMatchObject({
      phase: "stalled",
      problem: { kind: "stalled", message: "PayPal has not confirmed the capture yet." },
    });
    await settle();
    await settle();
    expect(h.calls()).toBe(1);
  });

  it("'Retry step' makes exactly one more attempt, and the loop then carries on", async () => {
    const h = harness([{ deal: stalled, executed: null, busy: false }, ran("capture", at("completed", 2))]);
    h.runner.start();
    h.runner.sync(at("verified", 1));
    await settle();
    h.runner.retry();
    await settle();
    expect(h.calls()).toBe(2);
    expect(h.runner.getSnapshot()).toMatchObject({ phase: "idle", problem: null });
  });

  it("a page opened on a step that already failed waits for the human", async () => {
    const h = harness([ran("capture", at("completed", 2))]);
    h.runner.start();
    h.runner.sync(stalled);
    await settle();
    expect(h.calls()).toBe(0);
    expect(h.runner.getSnapshot().phase).toBe("stalled");
    h.runner.retry();
    await settle();
    expect(h.calls()).toBe(1);
  });

  it("a step that only caught up with the payment record is progress, not a stall", async () => {
    const h = harness([{ deal: at("authorized", 2), executed: null, busy: false }, ran("fulfill", at("in_review", 3))]);
    h.runner.start();
    h.runner.sync(at("payment_pending", 1));
    await settle();
    expect(h.calls()).toBe(2);
    expect(h.runner.getSnapshot().problem).toBeNull();
  });

  it("answers that change nothing end in a stall instead of an endless loop", async () => {
    const same = at("authorized", 1);
    const h = harness(Array.from({ length: MAX_IDLE_ANSWERS }, (): AdvanceResponse => ({ deal: same, executed: null, busy: false })));
    h.runner.start();
    h.runner.sync(same);
    await settle();
    expect(h.calls()).toBe(MAX_IDLE_ANSWERS);
    expect(h.runner.getSnapshot()).toMatchObject({ phase: "stalled", problem: { kind: "stalled" } });
  });

  it("forgets the problem when the deal moves on by other means", async () => {
    const h = harness([{ deal: stalled, executed: null, busy: false }]);
    h.runner.start();
    h.runner.sync(at("verified", 1));
    await settle();
    expect(h.runner.getSnapshot().phase).toBe("stalled");
    // A webhook confirmed the capture; the page's poll delivered the completed deal.
    h.runner.sync(at("completed", 2));
    expect(h.runner.getSnapshot()).toMatchObject({ phase: "idle", problem: null });
  });
});

describe("auto-run and manual stepping", () => {
  it("with auto-run off nothing runs until 'Run next step', which runs exactly one step without the beat", async () => {
    const h = harness([ran("negotiate", at("negotiating", 2)), ran("negotiate", at("agreed", 3))], { autoRun: false });
    h.runner.start();
    h.runner.sync(at("negotiating", 1));
    await settle();
    expect(h.calls()).toBe(0);
    expect(h.runner.getSnapshot()).toMatchObject({ phase: "idle", autoRun: false });

    h.runner.runNext();
    await settle();
    expect(h.calls()).toBe(1);
    expect(h.sleeps).toEqual([]);

    h.runner.runNext();
    await settle();
    expect(h.calls()).toBe(2);
  });

  it("switching auto-run on resumes the loop; switching it off lets the step in flight finish and then pauses", async () => {
    const pending = deferred<AdvanceResponse>();
    const h = harness([() => pending.promise, ran("contract", at("contracted", 3))], { autoRun: false });
    h.runner.start();
    h.runner.sync(at("negotiating", 1));
    h.runner.setAutoRun(true);
    await settle();
    expect(h.calls()).toBe(1);

    h.runner.setAutoRun(false);
    pending.resolve(ran("negotiate", at("agreed", 2)));
    await settle();
    expect(h.calls()).toBe(1);
    expect(h.published.map((entry) => entry.status)).toEqual(["agreed"]);
    expect(h.runner.getSnapshot()).toMatchObject({ phase: "idle", autoRun: false });
  });

  it("resumes by itself after a human decision moves the deal to an automatic step", async () => {
    const h = harness([ran("order", at("awaiting_payment", 3))]);
    h.runner.start();
    h.runner.sync(at("awaiting_approval", 1));
    await settle();
    expect(h.calls()).toBe(0);
    h.runner.sync(at("payment_pending", 2));
    await settle();
    expect(h.calls()).toBe(1);
  });
});

describe("the page never goes back in time", () => {
  it("ignores an older deal handed to sync()", async () => {
    const h = harness([ran("capture", at("completed", 3))], { autoRun: false });
    h.runner.start();
    h.runner.sync(at("verified", 2));
    // A slow poll that started before the last step resolves late.
    h.runner.sync(at("submitted", 1));
    h.runner.runNext();
    await settle();
    expect(h.runner.getSnapshot().step).toBeNull();
    expect(h.calls()).toBe(1);
    expect(h.published.map((entry) => entry.status)).toEqual(["completed"]);
  });
});

describe("the external store", () => {
  it("notifies subscribers on change and returns a stable snapshot in between", async () => {
    const h = harness([ran("capture", at("completed", 2))]);
    let notifications = 0;
    const unsubscribe = h.runner.subscribe(() => {
      notifications += 1;
    });
    const before = h.runner.getSnapshot();
    expect(h.runner.getSnapshot()).toBe(before);
    h.runner.start();
    h.runner.sync(at("verified", 1));
    await settle();
    expect(notifications).toBeGreaterThan(0);
    const after = h.runner.getSnapshot();
    expect(h.runner.getSnapshot()).toBe(after);

    unsubscribe();
    const seen = notifications;
    h.runner.setAutoRun(false);
    expect(notifications).toBe(seen);
  });

  it("renders the default on the server, whatever the stored preference", () => {
    const h = harness([], { autoRun: false });
    expect(h.runner.getServerSnapshot()).toEqual({ phase: "idle", autoRun: true, step: null, attempt: 0, problem: null });
    expect(h.runner.getServerSnapshot()).toBe(h.runner.getServerSnapshot());
  });
});

describe("retryDelayMs", () => {
  it("backs off exponentially and gives up after the last try", () => {
    expect(retryDelayMs(transient(), 1, NOW)).toBe(1000);
    expect(retryDelayMs(transient(), 2, NOW)).toBe(2000);
    expect(retryDelayMs(transient(), MAX_TRIES, NOW)).toBeNull();
  });
  it("treats network errors and timeouts as transient", () => {
    expect(retryDelayMs(new ApiClientError(0, "network", "Could not reach the server.", null, null), 1, NOW)).toBe(1000);
    expect(retryDelayMs(new ApiClientError(0, "timeout", "Too slow.", null, null), 1, NOW)).toBe(1000);
  });
  it("never retries what is not transient, or not an API error at all", () => {
    expect(retryDelayMs(new ApiClientError(400, "invalid_request", "No.", null, null), 1, NOW)).toBeNull();
    expect(retryDelayMs(new ApiClientError(404, "not_found", "No.", null, null), 1, NOW)).toBeNull();
    expect(retryDelayMs(new Error("boom"), 1, NOW)).toBeNull();
    expect(retryDelayMs("boom", 1, NOW)).toBeNull();
  });
  it("waits for a rate limit that resets soon, a little past the reset", () => {
    const soon = new ApiClientError(429, "rate_limited", "Slow down.", null, { resetAt: new Date(NOW + 5_000).toISOString() });
    expect(retryDelayMs(soon, 1, NOW)).toBe(5_250);
    const already = new ApiClientError(429, "rate_limited", "Slow down.", null, { resetAt: new Date(NOW - 5_000).toISOString() });
    expect(retryDelayMs(already, 2, NOW)).toBe(2000);
  });
  it("does not wait silently for a rate limit that resets far in the future", () => {
    const later = new ApiClientError(429, "rate_limited", "Slow down.", null, { resetAt: new Date(NOW + 120_000).toISOString() });
    expect(retryDelayMs(later, 1, NOW)).toBeNull();
  });
  it("falls back to plain backoff when a rate limit carries no usable reset time", () => {
    expect(retryDelayMs(new ApiClientError(429, "rate_limited", "Slow down.", null, null), 1, NOW)).toBe(1000);
    expect(retryDelayMs(new ApiClientError(429, "rate_limited", "Slow down.", null, { resetAt: "soon" }), 1, NOW)).toBe(1000);
  });
});

describe("describeRequestFailure", () => {
  it("carries the server's code and request id", () => {
    expect(describeRequestFailure(transient())).toEqual({ kind: "request", message: "The service is busy.", code: "unavailable", requestId: "req_503" });
  });
});
