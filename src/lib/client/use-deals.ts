"use client";

/** The current browser session's deals, newest first (GET /api/deals). */
import { useCallback } from "react";
import useSWR from "swr";
import type { DealListResponse, DealSummary } from "@/lib/api/dto";
import { isTerminal } from "@/lib/domain/status";
import { ApiClientError, fetcher } from "./api";

export const DEALS_PATH = "/api/deals";
const ACTIVE_REFRESH_MS = 5_000;

/** A list with a deal still in flight is re-read so its status pill keeps up with the deal page. */
export function dealsRefreshMs(deals: readonly Pick<DealSummary, "status">[] | undefined): number {
  return deals !== undefined && deals.some((deal) => !isTerminal(deal.status)) ? ACTIVE_REFRESH_MS : 0;
}

export interface UseDeals {
  deals: DealSummary[] | undefined;
  error: ApiClientError | undefined;
  isLoading: boolean;
  refresh(): Promise<void>;
}

export function useDeals(): UseDeals {
  const { data, error, isLoading, mutate } = useSWR<DealListResponse, ApiClientError>(DEALS_PATH, fetcher, {
    refreshInterval: (latest) => dealsRefreshMs(latest?.deals),
    shouldRetryOnError: (failure) => failure instanceof ApiClientError && failure.transient,
    errorRetryCount: 3,
  });
  const refresh = useCallback(async (): Promise<void> => {
    await mutate();
  }, [mutate]);
  return { deals: data?.deals, error: data === undefined ? error : undefined, isLoading, refresh };
}
