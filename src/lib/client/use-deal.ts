"use client";

/**
 * Data access for one deal: the SWR-backed read, and the two writes a human can make from the
 * deal screen (a decision at a gate, a reconciliation with PayPal).
 *
 * The deal has a single home, the SWR cache entry for GET /api/deals/{id}. Everything that
 * receives a newer deal (the runner, a decision) publishes it there, and nothing is ever
 * replaced by an older copy.
 */
import { useCallback, useState } from "react";
import useSWR from "swr";
import type { DealResponse, DealView, DecisionRequest, ReconciliationView } from "@/lib/api/dto";
import type { HumanDecisionKind } from "@/lib/domain/schemas";
import { ApiClientError, api, fetcher } from "./api";
import { pollIntervalMs, supersedes } from "./deal-derive";

export function dealPath(dealId: string): string {
  return `/api/deals/${encodeURIComponent(dealId)}`;
}

/** Normalise anything thrown by a request into the client's error type. */
export function toApiError(cause: unknown): ApiClientError {
  if (cause instanceof ApiClientError) return cause;
  return new ApiClientError(0, "unknown", "Something went wrong. Please try again.", null, null);
}

export interface UseDeal {
  /** Undefined until the first answer arrives; with `error` also undefined, the deal is loading. */
  deal: DealView | undefined;
  /** Set only while there is no deal to show: a failed background poll never blanks the page. */
  error: ApiClientError | undefined;
  /** Re-read the deal from the server. */
  refresh(): Promise<void>;
  /** Show a deal received from a write, unless the page already shows something newer. */
  publish(deal: DealView): void;
}

export function useDeal(dealId: string): UseDeal {
  const { data, error, mutate } = useSWR<DealResponse, ApiClientError>(dealPath(dealId), fetcher, {
    // Polls only while the page is not driving the deal itself: an open human gate, or a visitor
    // watching someone else's deal. The runner's own responses arrive through `publish`.
    refreshInterval: (latest) => pollIntervalMs(latest?.deal),
    revalidateOnFocus: true,
    // A missing deal stays missing; only failures that can heal are retried.
    shouldRetryOnError: (failure) => failure instanceof ApiClientError && failure.transient,
    errorRetryCount: 3,
    keepPreviousData: true,
  });

  const refresh = useCallback(async (): Promise<void> => {
    await mutate();
  }, [mutate]);

  const publish = useCallback(
    (incoming: DealView): void => {
      void mutate((current) => (current !== undefined && !supersedes(current.deal, incoming) ? current : { deal: incoming }), {
        revalidate: false,
      });
    },
    [mutate],
  );

  return { deal: data?.deal, error: data === undefined ? error : undefined, refresh, publish };
}

/* -------------------------------------------------------------------------- */
/*  Decisions                                                                  */
/* -------------------------------------------------------------------------- */

export type DecisionResult = { ok: true; deal: DealView } | { ok: false; error: ApiClientError };

export interface UseDealDecision {
  /** The decision being sent, so the pressed button can show progress and the rest can lock. */
  pending: HumanDecisionKind | null;
  /** The last failure, kept until the next attempt so the gate can show it with its request id. */
  error: ApiClientError | null;
  decide(request: DecisionRequest): Promise<DecisionResult>;
}

/**
 * Sends a human decision. One at a time: a second click while one is in flight is ignored, so a
 * double click can never approve and then act on the next gate.
 */
export function useDealDecision(dealId: string, deal: Pick<UseDeal, "publish" | "refresh">): UseDealDecision {
  const [pending, setPending] = useState<HumanDecisionKind | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const { publish, refresh } = deal;

  const decide = useCallback(
    async (request: DecisionRequest): Promise<DecisionResult> => {
      if (pending !== null) return { ok: false, error: new ApiClientError(409, "conflict", "A decision is already being sent.", null, null) };
      setPending(request.kind);
      setError(null);
      try {
        const response = await api.post<DealResponse>(`${dealPath(dealId)}/decision`, request);
        publish(response.deal);
        return { ok: true, deal: response.deal };
      } catch (cause) {
        const failure = toApiError(cause);
        setError(failure);
        // A conflict means the gate this button belongs to is no longer open: show what is.
        if (failure.status === 409) await refresh().catch(() => undefined);
        return { ok: false, error: failure };
      } finally {
        setPending(null);
      }
    },
    [dealId, pending, publish, refresh],
  );

  return { pending, error, decide };
}

/* -------------------------------------------------------------------------- */
/*  Reconciliation                                                             */
/* -------------------------------------------------------------------------- */

export interface UseReconciliation {
  result: ReconciliationView | null;
  pending: boolean;
  error: ApiClientError | null;
  run(): Promise<void>;
}

/** Re-reads PayPal's record of the deal and compares it with PACT's ledger. */
export function useReconciliation(dealId: string, onRecorded: () => Promise<void>): UseReconciliation {
  const [result, setResult] = useState<ReconciliationView | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);

  const run = useCallback(async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      setResult(await api.post<ReconciliationView>(`${dealPath(dealId)}/reconcile`, {}));
      // The owner's reconciliation is written to the audit trail: show the new entry.
      await onRecorded().catch(() => undefined);
    } catch (cause) {
      setError(toApiError(cause));
    } finally {
      setPending(false);
    }
  }, [dealId, onRecorded, pending]);

  return { result, pending, error, run };
}
