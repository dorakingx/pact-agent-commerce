/**
 * PayPal REST transport: OAuth2 token handling, timeouts, bounded retries, error normalisation
 * and request logging. Raw `fetch` on purpose — every call controls its own PayPal-Request-Id
 * and Prefer header and can read PayPal's debug_id, which an SDK would hide.
 *
 * This module knows nothing about orders or money. It deliberately does not import the app
 * configuration either, so the operator scripts can use it outside the Next.js server runtime.
 */
import { z } from "zod";
import { log, type LogFields } from "../observability/logger";
import { PaymentError } from "./types";

const SANDBOX_HOSTS: ReadonlySet<string> = new Set(["api-m.sandbox.paypal.com", "api.sandbox.paypal.com"]);
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

const DEFAULT_TIMEOUT_MS = 15_000;
/** Retries after the first attempt. Kept small: a serverless request must still answer in time. */
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 250;
/** Refresh this long before PayPal's stated expiry so a token never dies mid-request. */
const TOKEN_EXPIRY_MARGIN_S = 60;

/**
 * PACT only ever talks to the PayPal Sandbox. The single exception is a loopback address over
 * plain http, which is how integration tests point the client at a local emulator.
 */
export function isAllowedApiBase(apiBase: string): boolean {
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return SANDBOX_HOSTS.has(url.hostname);
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

export interface PayPalHttpOptions {
  clientId: string;
  clientSecret: string;
  apiBase: string;
  fetchImpl?: typeof fetch;
  /** Epoch milliseconds. Injected by tests to control token expiry. */
  now?: () => number;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Injected by tests so backoff does not slow the suite down. */
  sleep?: (ms: number) => Promise<void>;
}

export interface PayPalRequest {
  method: "GET" | "POST" | "PATCH";
  /** Concrete path; ids must already be URL-encoded. */
  path: string;
  /** The path with ids replaced by placeholders. This is the only form that is ever logged. */
  template: string;
  /** JSON-serialisable body. */
  body?: unknown;
  /** Pre-serialised JSON, for the one call whose bytes must not be re-encoded (webhook postback). */
  rawBody?: string;
  /** Sent as PayPal-Request-Id. Its presence is what makes a non-GET request safe to retry. */
  idempotencyKey?: string;
  /** Ask for the full resource (Prefer: return=representation) instead of PayPal's minimal default. */
  representation?: boolean;
  /** Correlation fields for the request log (deal id, PayPal ids). Never secrets. */
  context?: LogFields;
}

export interface PayPalResponse {
  status: number;
  /** Parsed JSON body, or null for an empty or non-JSON response. */
  body: unknown;
  debugId: string | null;
}

const ErrorBodySchema = z.object({
  name: z.string().nullish(),
  message: z.string().nullish(),
  debug_id: z.string().nullish(),
  details: z.array(z.object({ issue: z.string().nullish(), description: z.string().nullish() })).nullish(),
  // The OAuth endpoint answers in RFC 6749 form rather than PayPal's usual error envelope.
  error: z.string().nullish(),
  error_description: z.string().nullish(),
});

const TokenBodySchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

/**
 * Turn a non-2xx PayPal answer into a PaymentError. `details[0].issue` is the stable code to
 * branch on; `name` is only a coarse class (and misspelt in places) so it is the fallback.
 */
export function paymentErrorFromResponse(response: PayPalResponse): PaymentError {
  const parsed = ErrorBodySchema.safeParse(response.body);
  const body = parsed.success ? parsed.data : {};
  const detail = body.details?.[0];
  const issue = detail?.issue ?? body.name ?? body.error ?? `HTTP_${response.status}`;
  const message =
    detail?.description ?? body.message ?? body.error_description ?? `PayPal answered HTTP ${response.status}`;
  return new PaymentError({
    issue,
    message,
    httpStatus: response.status,
    debugId: body.debug_id ?? response.debugId,
    // 409 is only transient when it means "your earlier identical request is still running".
    retryable:
      response.status >= 500 ||
      response.status === 429 ||
      (response.status === 409 && issue === "PREVIOUS_REQUEST_IN_PROGRESS"),
  });
}

/** A 2xx answer that lacks the fields PACT needs. Not retried: asking again would not change the shape. */
export function unexpectedResponse(what: string, response: PayPalResponse): PaymentError {
  return new PaymentError({
    issue: "UNEXPECTED_RESPONSE",
    message: `PayPal's ${what} response did not have the expected shape`,
    httpStatus: response.status,
    debugId: response.debugId,
    retryable: false,
  });
}

function parseJson(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // e.g. an HTML error page from an intermediary; the status code still tells the story.
    return null;
  }
}

function debugIdOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as { debug_id?: unknown }).debug_id;
  return typeof value === "string" ? value : null;
}

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

interface WireRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  /** What gets logged: never the URL (it carries ids) and never the headers (they carry credentials). */
  logFields: LogFields;
}

export class PayPalHttp {
  readonly apiBase: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private token: CachedToken | null = null;
  private tokenRefresh: Promise<string> | null = null;

  constructor(options: PayPalHttpOptions) {
    if (!isAllowedApiBase(options.apiBase)) {
      throw new Error(
        "PayPal API base must be the PayPal Sandbox (https://api-m.sandbox.paypal.com) or a loopback test emulator",
      );
    }
    if (options.clientId === "" || options.clientSecret === "") {
      throw new Error("PayPal client id and secret are required");
    }
    this.apiBase = new URL(options.apiBase).origin;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    // Looked up lazily when not injected, so a test that stubs the global fetch still takes effect.
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Perform one API call and return its 2xx response; anything else throws a PaymentError.
   *
   * Retry policy: at most two retries, and only when the failure is transient AND repeating the
   * call cannot move money twice — i.e. it is a GET, or it carries a PayPal-Request-Id, in which
   * case the identical key is resent and PayPal deduplicates.
   */
  async request(request: PayPalRequest): Promise<PayPalResponse> {
    const repeatable = request.method === "GET" || request.idempotencyKey !== undefined;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.sendAuthorized(request, attempt);
        if (response.status >= 200 && response.status < 300) return response;
        throw paymentErrorFromResponse(response);
      } catch (error) {
        const canRetry = error instanceof PaymentError && error.retryable && repeatable && attempt < MAX_RETRIES;
        if (!canRetry) throw error;
        await this.sleep(BACKOFF_BASE_MS * 2 ** attempt);
      }
    }
  }

  private async sendAuthorized(request: PayPalRequest, attempt: number): Promise<PayPalResponse> {
    const token = await this.accessToken();
    const response = await this.exchange(this.toWire(request, token, attempt));
    if (response.status !== 401) return response;
    // The cached token was rejected (revoked, or expired earlier than announced). A 401 means
    // PayPal did not process the request, so one resend with a fresh token is safe even for a POST.
    this.dropToken(token);
    return this.exchange(this.toWire(request, await this.accessToken(), attempt));
  }

  private toWire(request: PayPalRequest, token: string, attempt: number): WireRequest {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    };
    if (request.method !== "GET") headers["Content-Type"] = "application/json";
    if (request.idempotencyKey !== undefined) headers["PayPal-Request-Id"] = request.idempotencyKey;
    if (request.representation) headers.Prefer = "return=representation";
    const body = request.rawBody ?? (request.body === undefined ? undefined : JSON.stringify(request.body));
    return {
      method: request.method,
      url: `${this.apiBase}${request.path}`,
      headers,
      body,
      logFields: {
        ...request.context,
        method: request.method,
        path: request.template,
        attempt: attempt + 1,
        ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      },
    };
  }

  /** One HTTP round trip with a hard timeout. Throws only for network failures and timeouts. */
  private async exchange(wire: WireRequest): Promise<PayPalResponse> {
    const startedAt = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(wire.url, {
        method: wire.method,
        headers: wire.headers,
        body: wire.body,
        signal: controller.signal,
      });
      // Reading the body is inside the timeout too: a stalled body is as bad as a stalled header.
      const body = parseJson(await response.text());
      const debugId = response.headers.get("paypal-debug-id") ?? debugIdOf(body);
      const fields = { ...wire.logFields, status: response.status, latencyMs: this.now() - startedAt, paypalDebugId: debugId };
      if (response.status < 400) log.info("paypal.request", fields);
      else log.warn("paypal.request", fields);
      return { status: response.status, body, debugId };
    } catch (cause) {
      const timedOut = controller.signal.aborted;
      const issue = timedOut ? "TIMEOUT" : "NETWORK_ERROR";
      log.warn("paypal.request", { ...wire.logFields, status: null, latencyMs: this.now() - startedAt, issue });
      throw new PaymentError({
        issue,
        message: timedOut ? `PayPal did not answer within ${this.timeoutMs} ms` : "PayPal could not be reached",
        // The outcome is unknown, which is exactly the case PayPal-Request-Id exists for.
        retryable: true,
        cause,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private accessToken(): Promise<string> {
    const cached = this.token;
    if (cached !== null && this.now() < cached.expiresAtMs) return Promise.resolve(cached.value);
    // Single flight: concurrent callers share one token request instead of each minting a token.
    this.tokenRefresh ??= this.fetchToken().finally(() => {
      this.tokenRefresh = null;
    });
    return this.tokenRefresh;
  }

  private dropToken(rejected: string): void {
    // Only drop the token that was actually rejected; a concurrent caller may already have refreshed it.
    if (this.token?.value === rejected) this.token = null;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`, "utf8").toString("base64");
    const response = await this.exchange({
      method: "POST",
      url: `${this.apiBase}/v1/oauth2/token`,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      logFields: { method: "POST", path: "/v1/oauth2/token", attempt: 1 },
    });
    if (response.status < 200 || response.status >= 300) throw paymentErrorFromResponse(response);
    const parsed = TokenBodySchema.safeParse(response.body);
    if (!parsed.success) throw unexpectedResponse("OAuth token", response);
    const lifetimeS = Math.max(0, parsed.data.expires_in - TOKEN_EXPIRY_MARGIN_S);
    this.token = { value: parsed.data.access_token, expiresAtMs: this.now() + lifetimeS * 1000 };
    return parsed.data.access_token;
  }
}
