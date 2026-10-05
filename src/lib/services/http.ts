/**
 * Shared plumbing for route handlers: one error shape, request ids, body limits,
 * same-origin enforcement and a privacy-preserving client key for rate limits.
 */
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { ZodError, type z } from "zod";
import type { ApiErrorBody } from "../api/dto";
import { InvalidMoveError } from "../domain/negotiation";
import { IllegalTransitionError } from "../domain/status";
import { log } from "../observability/logger";
import { PaymentError } from "../payments/types";
import { ApiError, invalid, forbidden } from "./errors";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function json<T>(body: T, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return Response.json(body, { status: init.status ?? 200, headers: { ...NO_STORE, ...init.headers } });
}

function errorBody(code: string, message: string, requestId: string, details?: unknown): ApiErrorBody {
  return { error: { code, message, requestId, ...(details === undefined ? {} : { details }) } };
}

/**
 * Seconds until a rate-limit window reopens, for the Retry-After header of a 429 — so a client
 * (or a proxy) backs off for as long as the limit actually lasts instead of guessing.
 */
function retryAfterSeconds(error: ApiError): string | null {
  if (error.status !== 429 || typeof error.details !== "object" || error.details === null) return null;
  const resetAt: unknown = (error.details as { resetAt?: unknown }).resetAt;
  const resetMs = typeof resetAt === "string" ? Date.parse(resetAt) : Number.NaN;
  if (Number.isNaN(resetMs)) return null;
  return String(Math.max(1, Math.ceil((resetMs - Date.now()) / 1000)));
}

/** Convert any thrown value into the API's error response. Internal details are logged, never returned. */
export function errorResponse(error: unknown, requestId: string, routeName: string): Response {
  if (error instanceof ApiError) {
    if (error.status >= 500) log.error("api.error", { requestId, route: routeName, code: error.code, error });
    const retryAfter = retryAfterSeconds(error);
    return json(errorBody(error.code, error.message, requestId, error.details), {
      status: error.status,
      ...(retryAfter === null ? {} : { headers: { "Retry-After": retryAfter } }),
    });
  }
  if (error instanceof ZodError) {
    const issues = error.issues.slice(0, 8).map((i) => ({ path: i.path.join("."), message: i.message }));
    return json(errorBody("invalid_request", "The request is not valid.", requestId, { issues }), { status: 400 });
  }
  if (error instanceof PaymentError) {
    log.error("api.payment_error", {
      requestId,
      route: routeName,
      issue: error.issue,
      paypalDebugId: error.debugId,
      httpStatus: error.httpStatus,
      error,
    });
    return json(
      errorBody("payment_error", "The payment provider could not complete this step.", requestId, {
        issue: error.issue,
        debugId: error.debugId,
        retryable: error.retryable,
      }),
      { status: 502 },
    );
  }
  if (error instanceof IllegalTransitionError || error instanceof InvalidMoveError) {
    log.warn("api.conflict", { requestId, route: routeName, error });
    return json(errorBody("conflict", "That action is not possible in the deal's current state.", requestId), {
      status: 409,
    });
  }
  log.error("api.unhandled", {
    requestId,
    route: routeName,
    error,
    stack: error instanceof Error ? error.stack?.split("\n").slice(0, 6).join(" | ") : undefined,
  });
  return json(errorBody("internal", "Something went wrong on our side. Please try again.", requestId), { status: 500 });
}

export interface RouteMeta {
  requestId: string;
}

/**
 * Wrap a route handler: assigns a request id, enforces same-origin on state-changing methods
 * (unless `crossOrigin` is set, e.g. for PayPal webhooks), and turns thrown errors into the API error shape.
 */
export function route<Ctx>(
  name: string,
  handler: (request: Request, context: Ctx, meta: RouteMeta) => Promise<Response>,
  options: { crossOrigin?: boolean } = {},
): (request: Request, context: Ctx) => Promise<Response> {
  return async (request, context) => {
    const requestId = randomUUID();
    try {
      if (!options.crossOrigin) assertSameOrigin(request);
      const response = await handler(request, context, { requestId });
      response.headers.set("x-request-id", requestId);
      return response;
    } catch (error) {
      const response = errorResponse(error, requestId, name);
      response.headers.set("x-request-id", requestId);
      return response;
    }
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence in depth (the session cookie is already SameSite=Lax): a state-changing request
 * must come from this origin. Browsers always send Origin on cross-origin POSTs and send
 * Sec-Fetch-Site on modern engines; a request with neither is a non-browser client, which
 * carries no ambient cookie authority worth protecting against.
 */
export function assertSameOrigin(request: Request): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw forbidden("Cross-site requests are not allowed");
  const origin = request.headers.get("origin");
  if (!origin) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw forbidden("Cross-site requests are not allowed");
  }
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  if (originHost !== host) throw forbidden("Cross-site requests are not allowed");
}

/** Read and validate a JSON body with a hard size limit. */
export async function readJson<S extends z.ZodType>(request: Request, schema: S, maxBytes = 16_384): Promise<z.infer<S>> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) throw invalid("Content-Type must be application/json");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw invalid("Request body is too large");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw invalid("Request body is too large");
  let parsed: unknown;
  try {
    parsed = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw invalid("Request body is not valid JSON");
  }
  return schema.parse(parsed);
}

/**
 * A stable, non-reversible key for the caller's network address, for rate limiting only.
 * The raw IP is never stored or logged.
 */
export function clientKey(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || request.headers.get("x-real-ip")?.trim();
  if (!ip) return null;
  return createHash("sha256").update(`pact-ip:${ip}`).digest("hex").slice(0, 20);
}

/** Origin of the incoming request as the user's browser sees it (honours the proxy headers Vercel sets). */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}
