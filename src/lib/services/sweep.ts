/**
 * The system driver: settlement that does not depend on the payer's browser.
 *
 * A deal's steps are normally run by its owner's open tab. That is fine before money is held —
 * a deal nobody is watching can simply wait — but not after: once funds are authorized and the
 * seller has delivered, verification and capture (or the release of a rejected delivery's hold)
 * are owed to both parties whether or not anyone is looking. The sweep finds such deals when
 * they have gone quiet and runs their next step through the same engine entry point, lease and
 * idempotency keys as the browser would.
 *
 * It never touches a deal before authorization (those need the payer) or at a human gate, and it
 * runs one step per deal per invocation, for a few deals: a verification step can take 40 s and
 * the route has 60.
 */
import "server-only";
import { listStalledDealIds } from "../db";
import type { StepKind } from "../api/dto";
import type { DealStatus } from "../domain/status";
import { log } from "../observability/logger";
import type { ServiceContext } from "./context";
import { advanceAsSystem } from "./deals";

/**
 * The statuses in which money is held and the next step is automatic. "payment_pending" is not
 * among them on purpose: before authorization a deal is the payer's to continue.
 */
const SWEEPABLE_STATUSES: readonly DealStatus[] = ["authorized", "revision_required", "submitted", "verified", "rejecting"];

/** A deal untouched for this long is not being driven by anyone: an open tab steps every few seconds. */
export const SWEEP_STALE_SECONDS = 120;
const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 50;
/** No new step is started after this long, so the slowest step still finishes inside the route's 60 s. */
const DEFAULT_BUDGET_MS = 15_000;

export interface SweepOptions {
  /** Most deals to step in one run. */
  limit?: number;
  /** Wall-clock time after which no further step is started. */
  budgetMs?: number;
}

export interface SweptDeal {
  dealId: string;
  /** The step that ran to completion, or null when it stalled (the deal's `lastError` says why). */
  executed: StepKind | null;
  /** The deal's status after the attempt. */
  status: DealStatus;
}

export interface SweepResult {
  /** Stalled deals found for this run (at most the limit). */
  examined: number;
  /** The deals a step was attempted for. One that another request was already stepping is left out. */
  advanced: SweptDeal[];
}

/**
 * Run the next step of the deals that hold money and have gone quiet, oldest first.
 * A deal that fails to step is logged and skipped: one bad deal must not stop the others.
 */
export async function sweepStalledDeals(ctx: ServiceContext, appUrl: string, options: SweepOptions = {}): Promise<SweepResult> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const now = ctx.now();
  const staleBefore = new Date(now.getTime() - SWEEP_STALE_SECONDS * 1000);
  const dealIds = await listStalledDealIds(ctx.db, SWEEPABLE_STATUSES, staleBefore, now, limit);

  const startedAt = Date.now();
  const advanced: SweptDeal[] = [];
  for (const dealId of dealIds) {
    if (Date.now() - startedAt > budgetMs) break;
    try {
      const result = await advanceAsSystem(ctx, dealId, appUrl);
      if (!result.busy) advanced.push({ dealId, executed: result.executed, status: result.deal.status });
    } catch (error) {
      log.error("sweep.step_failed", { dealId, error });
    }
  }
  log.info("sweep.done", { examined: dealIds.length, advanced: advanced.length });
  return { examined: dealIds.length, advanced };
}
