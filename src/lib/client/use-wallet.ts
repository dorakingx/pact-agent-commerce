"use client";

import { useCallback } from "react";
import useSWR from "swr";
import type { ApiErrorBody, WalletStatus } from "../api/dto";
import { ApiClientError, api, fetcher } from "./api";

export const WALLET_KEY = "/api/wallet";

export type WalletScope = "session" | "demo";

/** Header the wallet routes read the operator token from. The server constant lives in a server-only module. */
const ADMIN_TOKEN_HEADER = "x-admin-token";
const OPERATOR_TIMEOUT_MS = 30_000;
/** A header value must be visible ASCII; anything else makes `fetch` throw before a request is sent. */
const HEADER_SAFE = /^[\x21-\x7e]+$/;

/**
 * A wallet request made as the operator. The token travels only in the request header: never
 * in the URL, never in a body, and it is not kept by this module.
 */
async function operatorRequest<T>(method: "POST" | "DELETE", path: string, adminToken: string, body?: unknown): Promise<T> {
  const token = adminToken.trim();
  if (!HEADER_SAFE.test(token)) {
    throw new ApiClientError(400, "invalid_request", "Enter the operator token exactly as it was issued.", null, null);
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        Accept: "application/json",
        [ADMIN_TOKEN_HEADER]: token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(OPERATOR_TIMEOUT_MS),
    });
  } catch {
    throw new ApiClientError(0, "network", "Could not reach the server. Check your connection.", null, null);
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = (payload as ApiErrorBody | null)?.error;
    throw new ApiClientError(
      response.status,
      error?.code ?? "http_error",
      error?.message ?? `Request failed (${response.status}).`,
      error?.requestId ?? response.headers.get("x-request-id"),
      error?.details ?? null,
    );
  }
  return payload as T;
}

export interface WalletActionOptions {
  /** Required for the shared demo wallet (`scope: "demo"`); ignored for the session's own wallet. */
  adminToken?: string;
}

export interface UseWallet {
  data: WalletStatus | undefined;
  error: ApiClientError | undefined;
  isLoading: boolean;
  /**
   * Start the one-time PayPal consent. Resolves with the URL the browser must navigate to
   * (PayPal's consent page; with simulated payments, a local return that completes at once).
   */
  connect: (scope: WalletScope, options?: WalletActionOptions) => Promise<string>;
  /** Forget a wallet (connected or half-connected) and refresh the status. */
  disconnect: (scope: WalletScope, options?: WalletActionOptions) => Promise<WalletStatus>;
  reload: () => void;
}

/** Delegated agent wallet status and actions (GET/DELETE /api/wallet, POST /api/wallet/connect). */
export function useWallet(): UseWallet {
  const { data, error, isLoading, mutate } = useSWR<WalletStatus, ApiClientError>(WALLET_KEY, fetcher);

  const connect = useCallback(async (scope: WalletScope, options: WalletActionOptions = {}): Promise<string> => {
    const path = `${WALLET_KEY}/connect`;
    const { approveUrl } =
      scope === "demo"
        ? await operatorRequest<{ approveUrl: string }>("POST", path, options.adminToken ?? "", { scope })
        : await api.post<{ approveUrl: string }>(path, { scope });
    return approveUrl;
  }, []);

  const disconnect = useCallback(
    async (scope: WalletScope, options: WalletActionOptions = {}): Promise<WalletStatus> => {
      const path = `${WALLET_KEY}?scope=${scope}`;
      const status =
        scope === "demo"
          ? await operatorRequest<WalletStatus>("DELETE", path, options.adminToken ?? "")
          : await api.delete<WalletStatus>(path);
      await mutate(status, { revalidate: false });
      return status;
    },
    [mutate],
  );

  const reload = useCallback(() => {
    void mutate();
  }, [mutate]);

  return { data, error, isLoading, connect, disconnect, reload };
}
