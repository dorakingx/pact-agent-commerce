/**
 * What PACT hands to AG Studio as its application `context`.
 *
 * Studio reads `context` once, at construction, and passes the same object to every custom
 * widget, cell renderer and agent tool. The dashboard therefore gives it one stable object whose
 * methods read whatever the dashboard was last given: widgets always see the current snapshot
 * and the current `onOpenDeal`, and Studio never has to be rebuilt when either changes.
 */
import type { OpsRow, OpsSnapshot } from "@/lib/api/dto";

export interface PactStudioContext {
  /** The snapshot the dashboard is currently showing. */
  snapshot(): OpsSnapshot;
  /** The ledger row behind a deal code, or null when the code is not in the snapshot. */
  dealByCode(code: string): OpsRow | null;
  /** Navigate to a deal (the host page decides how). */
  openDeal(dealId: string): void;
}

export interface PactStudioContextSource {
  snapshot: OpsSnapshot;
  onOpenDeal: (dealId: string) => void;
}

export interface PactStudioContextHandle {
  context: PactStudioContext;
  /** Point the context at the dashboard's latest props. */
  update(source: PactStudioContextSource): void;
}

export function createStudioContextHandle(initial: PactStudioContextSource): PactStudioContextHandle {
  let current = initial;
  return {
    context: {
      snapshot: () => current.snapshot,
      dealByCode: (code) => {
        const wanted = code.trim().toLowerCase();
        return current.snapshot.deals.find((deal) => deal.code.toLowerCase() === wanted) ?? null;
      },
      openDeal: (dealId) => current.onOpenDeal(dealId),
    },
    update: (source) => {
      current = source;
    },
  };
}
