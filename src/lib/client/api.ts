/**
 * Browser-side API client. Every call is same-origin JSON; errors are normalised to
 * ApiClientError carrying the server's stable error code and request id (shown in error states
 * so a failure in the demo can be traced in the logs).
 */
import type { ApiErrorBody } from "../api/dto";

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string | null,
    public readonly details: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
  }

  /** True for failures worth retrying automatically (network blips, 5xx, rate limits). */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

const DEFAULT_TIMEOUT_MS = 70_000;

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    const timedOut = cause instanceof DOMException && cause.name === "TimeoutError";
    throw new ApiClientError(
      0,
      timedOut ? "timeout" : "network",
      timedOut ? "The server took too long to respond." : "Could not reach the server. Check your connection.",
      null,
      null,
    );
  }
  const requestId = response.headers.get("x-request-id");
  if (response.status === 204) return undefined as T;
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
      error?.requestId ?? requestId,
      error?.details ?? null,
    );
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, undefined, signal),
  post: <T>(path: string, body: unknown = {}, signal?: AbortSignal) => request<T>("POST", path, body, signal),
  put: <T>(path: string, body: unknown, signal?: AbortSignal) => request<T>("PUT", path, body, signal),
  delete: <T>(path: string, signal?: AbortSignal) => request<T>("DELETE", path, undefined, signal),
};

/** SWR fetcher. */
export const fetcher = <T>(path: string): Promise<T> => api.get<T>(path);
