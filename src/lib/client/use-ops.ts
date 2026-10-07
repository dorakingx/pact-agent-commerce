"use client";

/**
 * Data hooks of the Operations page. The snapshot is a server-side read model (own deals plus
 * showcase deals); the page polls it so an operator watching the ledger sees agents move
 * without touching anything.
 */
import { useCallback } from "react";
import useSWR from "swr";
import type { DealResponse, DealView, OpsSnapshot } from "../api/dto";
import { fetcher, type ApiClientError } from "./api";

export const OPS_ENDPOINT = "/api/operations";
/** A deal step takes one to four seconds with live models; 15 s keeps the ledger current without hammering the API. */
export const OPS_REFRESH_MS = 15_000;

export interface UseOps {
  snapshot: OpsSnapshot | undefined;
  /** The last request failed. `snapshot` may still hold the previous good answer. */
  error: ApiClientError | undefined;
  /** First load: there is nothing to show yet. */
  isLoading: boolean;
  /** A request is in flight (first load, the interval, or a manual refresh). */
  isRefreshing: boolean;
  refresh: () => void;
}

export function useOps(): UseOps {
  const { data, error, isLoading, isValidating, mutate } = useSWR<OpsSnapshot, ApiClientError>(OPS_ENDPOINT, fetcher, {
    refreshInterval: OPS_REFRESH_MS,
    // Nobody is looking at a hidden tab; polling resumes (and revalidates at once) on return.
    refreshWhenHidden: false,
    refreshWhenOffline: false,
    revalidateOnFocus: true,
    keepPreviousData: true,
    // The interval already is the retry schedule; stacking SWR's backoff on top would double the load after an outage.
    shouldRetryOnError: false,
  });
  const refresh = useCallback(() => {
    void mutate();
  }, [mutate]);
  return { snapshot: data, error, isLoading, isRefreshing: isValidating, refresh };
}

export interface UseOpsDeal {
  deal: DealView | undefined;
  error: ApiClientError | undefined;
  isLoading: boolean;
  retry: () => void;
}

/**
 * The full deal behind one ledger row, loaded when the inspector opens. `null` loads nothing.
 *
 * `version` is the row's `updatedAt`: when the ledger learns that the deal moved on, the detail
 * is fetched again, and the previous detail stays on screen until the new one arrives.
 */
export function useOpsDeal(dealId: string | null, version: string | null = null): UseOpsDeal {
  const { data, error, isLoading, mutate } = useSWR<DealResponse, ApiClientError, readonly [string, string | null] | null>(
    dealId === null ? null : [`/api/deals/${encodeURIComponent(dealId)}`, version],
    ([path]) => fetcher<DealResponse>(path),
    { revalidateOnFocus: false, shouldRetryOnError: false, keepPreviousData: true },
  );
  const retry = useCallback(() => {
    void mutate();
  }, [mutate]);
  // `keepPreviousData` also keeps the detail of the deal inspected before this one; never show that.
  const deal = data?.deal.id === dealId ? data.deal : undefined;
  return { deal, error, isLoading: isLoading || (deal === undefined && error === undefined && dealId !== null), retry };
}
