/**
 * The deal runner: the loop that drives a deal through its automatic steps by calling
 * POST /api/deals/{id}/advance, one step per request.
 *
 * It is a plain class (no React) so its rules can be tested with a scripted server:
 *
 *  - One advance at a time. A second loop is never started while one is alive.
 *  - A short beat separates automatic steps so each one is legible on screen.
 *  - `busy` (another request holds the step lease): wait a second and ask again.
 *  - A transient request failure is retried with exponential backoff, a few times, then the
 *    runner stops with an error and waits for the human to press Retry.
 *  - A step that could not complete (`executed === null` with `deal.lastError`) stops the runner
 *    at once. It is never retried automatically: capture attempts are capped on the server, and a
 *    tight loop would spend them in seconds.
 *  - `stop()` aborts whatever is in flight (unmount, navigation).
 */
import type { AdvanceResponse, DealView, StepKind } from "@/lib/api/dto";
import { ApiClientError } from "./api";
import { supersedes, type RunnerActivity } from "./deal-derive";

/** Pause between automatic steps. Not motion: it stays on under prefers-reduced-motion. */
export const STEP_BEAT_MS = 600;
export const BUSY_POLL_MS = 1_000;
/** Total attempts for one step when the request itself keeps failing. */
export const MAX_TRIES = 3;
export const BACKOFF_BASE_MS = 1_000;
/** A rate limit that resets later than this is not worth waiting for silently. */
export const MAX_RETRY_WAIT_MS = 15_000;
/** How long a foreign lease is polled before the runner gives the human the choice. */
export const MAX_BUSY_POLLS = 90;
/** Answers in a row that neither ran a step nor changed the deal before the runner stops asking. */
export const MAX_IDLE_ANSWERS = 3;

export interface RunnerProblem {
  /** `stalled`: the server answered, the step did not complete. `request`: the call itself failed. */
  kind: "stalled" | "request";
  message: string;
  code: string | null;
  requestId: string | null;
}

export interface RunnerSnapshot {
  phase: RunnerActivity;
  autoRun: boolean;
  /** The step being attempted, while one is. */
  step: StepKind | null;
  /** 1 on the first try of a step; higher while backing off. */
  attempt: number;
  problem: RunnerProblem | null;
}

export interface DealRunnerDeps {
  advance(signal: AbortSignal): Promise<AdvanceResponse>;
  /** Re-read the deal (used when the server says the deal is not where the page thinks it is). */
  refresh(signal: AbortSignal): Promise<DealView>;
  /** Hand a deal the runner received to the page. */
  publish(deal: DealView): void;
  /** Resolves after `ms`, or rejects when the signal aborts. Injected in tests. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  now?(): number;
  beatMs?: number;
  autoRun?: boolean;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** `details.resetAt` of a 429, as epoch milliseconds. */
function rateLimitReset(error: ApiClientError): number | null {
  if (error.status !== 429 || typeof error.details !== "object" || error.details === null) return null;
  const resetAt = (error.details as { resetAt?: unknown }).resetAt;
  const ms = typeof resetAt === "number" ? resetAt : typeof resetAt === "string" ? Date.parse(resetAt) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
}

/**
 * How long to wait before try number `failedTries + 1`, or null when retrying automatically
 * makes no sense (the error is not transient, the tries are used up, or a rate limit resets too
 * far in the future).
 */
export function retryDelayMs(error: unknown, failedTries: number, nowMs: number): number | null {
  if (!(error instanceof ApiClientError) || !error.transient) return null;
  if (failedTries >= MAX_TRIES) return null;
  const backoff = BACKOFF_BASE_MS * 2 ** (failedTries - 1);
  const reset = rateLimitReset(error);
  if (reset === null) return backoff;
  // A little past the reset, so the next request is not the one that trips the limit again.
  const untilReset = reset - nowMs + 250;
  if (untilReset > MAX_RETRY_WAIT_MS) return null;
  return Math.max(backoff, untilReset);
}

export function describeRequestFailure(error: unknown): RunnerProblem {
  if (error instanceof ApiClientError) {
    return { kind: "request", message: error.message, code: error.code, requestId: error.requestId };
  }
  return { kind: "request", message: "Something went wrong while advancing the deal.", code: null, requestId: null };
}

function initialSnapshot(autoRun: boolean): RunnerSnapshot {
  return { phase: "idle", autoRun, step: null, attempt: 0, problem: null };
}

export class DealRunner {
  private deal: DealView | null = null;
  private snapshot: RunnerSnapshot;
  private readonly serverSnapshot: RunnerSnapshot;
  private readonly listeners = new Set<() => void>();
  /** Non-null between start() and stop(). */
  private controller: AbortController | null = null;
  private looping = false;
  /** A human asked for exactly one step ("Run next step" / "Retry step"). */
  private manualStep = false;
  /** The next step skips the beat: a human pressed a button and should not wait for it. */
  private immediate = false;

  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly beatMs: number;

  constructor(private readonly deps: DealRunnerDeps) {
    this.sleep = deps.sleep ?? abortableSleep;
    this.now = deps.now ?? Date.now;
    this.beatMs = deps.beatMs ?? STEP_BEAT_MS;
    this.snapshot = initialSnapshot(deps.autoRun ?? true);
    // What the server renders: it cannot know a stored preference, and it never runs the loop.
    this.serverSnapshot = initialSnapshot(true);
  }

  /* ---- external-store interface (stable identities for useSyncExternalStore) ---- */

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): RunnerSnapshot => this.snapshot;

  readonly getServerSnapshot = (): RunnerSnapshot => this.serverSnapshot;

  /* ---- lifecycle ---- */

  start(): void {
    if (this.controller !== null) return;
    this.controller = new AbortController();
    this.kick();
  }

  /** Abort the in-flight request and any pending wait. Safe to call twice; `start()` resumes. */
  stop(): void {
    this.controller?.abort();
    this.controller = null;
  }

  /** Tell the runner what the page currently shows. Called whenever the deal changes. */
  sync(deal: DealView): void {
    const first = this.deal === null;
    if (!supersedes(this.deal ?? undefined, deal)) return;
    this.deal = deal;
    if (first && deal.isOwner && deal.next.kind === "auto" && deal.lastError !== null) {
      // The page was opened on a step that had already failed. Retrying is the human's call.
      this.halt("stalled", { kind: "stalled", message: deal.lastError, code: null, requestId: null });
      return;
    }
    if (deal.next.kind !== "auto" && this.snapshot.problem !== null && !this.looping) {
      // The deal moved on by other means (a decision, a webhook, another tab): the problem is history.
      this.set({ phase: "idle", problem: null, step: null, attempt: 0 });
    }
    this.kick();
  }

  setAutoRun(autoRun: boolean): void {
    if (this.snapshot.autoRun === autoRun) return;
    this.set({ autoRun });
    this.kick();
  }

  /** Run exactly one step now, clearing a previous problem. With auto-run on, the loop then continues. */
  runNext(): void {
    if (this.looping) return;
    this.manualStep = true;
    this.immediate = true;
    if (this.snapshot.problem !== null) this.set({ phase: "idle", problem: null, attempt: 0 });
    this.kick();
  }

  /** Same operation as `runNext`; named for the button that follows a problem. */
  retry(): void {
    this.runNext();
  }

  /* ---- internals ---- */

  private set(patch: Partial<RunnerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private halt(phase: "stalled" | "failed", problem: RunnerProblem): void {
    this.manualStep = false;
    this.immediate = false;
    this.set({ phase, problem, step: null });
  }

  private wantsStep(): boolean {
    const deal = this.deal;
    if (deal === null || !deal.isOwner || deal.next.kind !== "auto") return false;
    if (this.snapshot.problem !== null) return false;
    return this.snapshot.autoRun || this.manualStep;
  }

  private kick(): void {
    if (this.controller === null || this.looping || !this.wantsStep()) return;
    void this.loop(this.controller.signal);
  }

  private accept(deal: DealView): void {
    if (supersedes(this.deal ?? undefined, deal)) this.deal = deal;
    this.deps.publish(deal);
  }

  private async loop(signal: AbortSignal): Promise<void> {
    this.looping = true;
    try {
      while (!signal.aborted && this.wantsStep()) {
        const immediate = this.immediate;
        this.immediate = false;
        this.set({ phase: "running", step: this.nextStep(), attempt: 1 });
        if (!immediate) {
          await this.sleep(this.beatMs, signal);
          // The deal may have changed during the beat (auto-run switched off, a decision made elsewhere).
          if (!this.wantsStep()) break;
        }
        await this.step(signal);
        this.manualStep = false;
      }
    } catch (cause) {
      // An abort is how stop() ends the loop. Anything else is a bug in a dependency: surface it.
      if (!signal.aborted) this.halt("failed", describeRequestFailure(cause));
    } finally {
      this.looping = false;
      if (this.snapshot.problem === null) this.set({ phase: "idle", step: null, attempt: 0 });
      // stop() followed at once by start() (React strict mode) finds the old loop still unwinding;
      // this is where the new controller gets its loop. It also picks up anything that changed
      // while the last step was in flight.
      this.kick();
    }
  }

  private nextStep(): StepKind | null {
    return this.deal !== null && this.deal.next.kind === "auto" ? this.deal.next.step : null;
  }

  /** Attempt the deal's next step until it runs, the deal stops needing it, or the runner gives up. */
  private async step(signal: AbortSignal): Promise<void> {
    let failedTries = 0;
    let busyPolls = 0;
    let conflicts = 0;
    let idleAnswers = 0;

    while (!signal.aborted) {
      const before = this.deal;
      let response: AdvanceResponse;
      try {
        response = await this.deps.advance(signal);
      } catch (cause) {
        if (signal.aborted) return;
        if (cause instanceof ApiClientError && cause.status === 409 && conflicts === 0) {
          // The deal is not where this page thinks it is. Look again once before calling it an error.
          conflicts += 1;
          this.accept(await this.deps.refresh(signal));
          if (!this.stillAuto()) return;
          continue;
        }
        failedTries += 1;
        const delay = retryDelayMs(cause, failedTries, this.now());
        if (delay === null) {
          this.halt("failed", describeRequestFailure(cause));
          return;
        }
        this.set({ phase: "retrying", attempt: failedTries + 1 });
        await this.sleep(delay, signal);
        this.set({ phase: "running" });
        continue;
      }

      this.accept(response.deal);

      if (response.busy) {
        busyPolls += 1;
        if (busyPolls >= MAX_BUSY_POLLS) {
          this.halt("failed", {
            kind: "request",
            message: "Another request has been working on this step for a long time.",
            code: "busy",
            requestId: null,
          });
          return;
        }
        this.set({ phase: "busy" });
        await this.sleep(BUSY_POLL_MS, signal);
        this.set({ phase: "running" });
        continue;
      }

      if (response.executed !== null || !this.stillAuto()) return;

      if (response.deal.lastError !== null) {
        this.halt("stalled", { kind: "stalled", message: response.deal.lastError, code: null, requestId: null });
        return;
      }

      // Nothing ran and nothing is wrong: the deal only caught up with its payment record.
      // That is progress if the deal changed; if it did not, do not keep asking forever.
      const progressed = before === null || before.status !== response.deal.status || before.audit.length !== response.deal.audit.length;
      if (progressed) return;
      idleAnswers += 1;
      if (idleAnswers >= MAX_IDLE_ANSWERS) {
        this.halt("stalled", {
          kind: "stalled",
          message: "The step did not run. Nothing was changed.",
          code: null,
          requestId: null,
        });
        return;
      }
      await this.sleep(BUSY_POLL_MS, signal);
    }
  }

  private stillAuto(): boolean {
    return this.deal !== null && this.deal.isOwner && this.deal.next.kind === "auto";
  }
}
