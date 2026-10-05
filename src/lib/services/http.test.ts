import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { IllegalTransitionError } from "../domain/status";
import { PaymentError } from "../payments/types";
import { ApiError, conflict, rateLimited } from "./errors";
import { assertSameOrigin, clientKey, errorResponse, readJson, requestOrigin, route } from "./http";

const ORIGIN = "https://pact.test";

function post(headers: Record<string, string>, body = "{}", path = "/api/deals"): Request {
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers, body });
}

async function bodyOf(response: Response): Promise<{ error: { code: string; message: string; requestId: string; details?: unknown } }> {
  return (await response.json()) as { error: { code: string; message: string; requestId: string; details?: unknown } };
}

beforeEach(() => {
  vi.stubEnv("PACT_LOG_SILENT", "1");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("errorResponse", () => {
  it("answers a rate-limited request with 429 and a Retry-After that lasts as long as the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T05:00:00.000Z"));
    const response = errorResponse(rateLimited("2026-10-06T05:07:30.000Z"), "req-1", "deals.create");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("450");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(response)).toEqual({
      error: {
        code: "rate_limited",
        message: "Too many requests. Please slow down and try again shortly.",
        requestId: "req-1",
        details: { resetAt: "2026-10-06T05:07:30.000Z" },
      },
    });
  });

  it("never tells a client to retry immediately or in the past, and sends no Retry-After without a reset time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T05:00:00.000Z"));
    expect(errorResponse(rateLimited("2026-10-06T04:59:00.000Z"), "r", "x").headers.get("retry-after")).toBe("1");
    expect(errorResponse(rateLimited("2026-10-06T05:00:00.200Z"), "r", "x").headers.get("retry-after")).toBe("1");
    expect(errorResponse(rateLimited("not a timestamp"), "r", "x").headers.has("retry-after")).toBe(false);
    expect(errorResponse(new ApiError(429, "rate_limited", "Slow down"), "r", "x").headers.has("retry-after")).toBe(false);
    // Only a 429 carries it, whatever the details of another error happen to contain.
    expect(errorResponse(conflict("Busy", { resetAt: "2026-10-06T05:07:30.000Z" }), "r", "x").headers.has("retry-after")).toBe(false);
  });

  it("maps payment and state-machine errors to their statuses without leaking internals", async () => {
    const refusal = new PaymentError({ issue: "PAYER_CANNOT_PAY", message: "PayPal said no: secret-detail", debugId: "dbg-1", httpStatus: 422 });
    const payment = errorResponse(refusal, "req-2", "x");
    expect(payment.status).toBe(502);
    const paymentBody = await bodyOf(payment);
    expect(paymentBody.error).toMatchObject({ code: "payment_error", details: { issue: "PAYER_CANNOT_PAY", debugId: "dbg-1", retryable: false } });
    expect(JSON.stringify(paymentBody)).not.toContain("secret-detail");

    const illegal = errorResponse(new IllegalTransitionError("completed", "negotiating", "deal"), "req-3", "x");
    expect(illegal.status).toBe(409);
    expect((await bodyOf(illegal)).error.code).toBe("conflict");

    const unknown = errorResponse(new Error("connect ECONNREFUSED 10.0.0.5:5432"), "req-4", "x");
    expect(unknown.status).toBe(500);
    const unknownBody = await bodyOf(unknown);
    expect(unknownBody.error).toEqual({ code: "internal", message: "Something went wrong on our side. Please try again.", requestId: "req-4" });
  });
});

describe("route", () => {
  it("stamps every answer, success or failure, with the request id it logs under", async () => {
    const ok = await route("test.ok", async () => Response.json({ fine: true }))(new Request(`${ORIGIN}/api/x`), undefined);
    const failed = await route("test.fail", async () => {
      throw conflict("No");
    })(new Request(`${ORIGIN}/api/x`), undefined);
    expect(ok.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(failed.status).toBe(409);
    expect((await bodyOf(failed)).error.requestId).toBe(failed.headers.get("x-request-id"));
  });

  it("refuses a cross-site state change before the handler runs, unless the route is declared cross-origin", async () => {
    const handler = vi.fn(async () => Response.json({ ran: true }));
    const crossSite = post({ origin: "https://evil.example", "content-type": "application/json" });
    const refused = await route("test.guarded", handler)(crossSite, undefined);
    expect(refused.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();

    const allowed = await route("test.webhook", handler, { crossOrigin: true })(post({ origin: "https://www.paypal.com" }), undefined);
    expect(allowed.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("assertSameOrigin", () => {
  const refused = (headers: Record<string, string>, method = "POST"): boolean => {
    try {
      assertSameOrigin(new Request(`${ORIGIN}/api/deals`, { method, headers }));
      return false;
    } catch (error) {
      expect(error).toMatchObject({ status: 403, code: "forbidden" });
      return true;
    }
  };

  it("accepts this origin and a client that is not a browser", () => {
    expect(refused({ origin: ORIGIN, "sec-fetch-site": "same-origin" })).toBe(false);
    expect(refused({ origin: ORIGIN })).toBe(false);
    // No Origin and no Fetch Metadata: not a browser, so there is no ambient cookie to abuse.
    expect(refused({})).toBe(false);
    expect(refused({ "sec-fetch-site": "none" })).toBe(false);
  });

  it("refuses another origin, a sibling site and an unparseable Origin on every state-changing method", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect(refused({ origin: "https://evil.example" }, method), method).toBe(true);
      expect(refused({ "sec-fetch-site": "cross-site" }, method), method).toBe(true);
      expect(refused({ origin: ORIGIN, "sec-fetch-site": "same-site" }, method), method).toBe(true);
      expect(refused({ origin: "null" }, method), method).toBe(true);
      // Same host on another port or scheme-relative look-alikes are other origins.
      expect(refused({ origin: "https://pact.test:8443" }, method), method).toBe(true);
      expect(refused({ origin: "https://pact.test.evil.example" }, method), method).toBe(true);
    }
  });

  it("does not police reads", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) expect(refused({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }, method)).toBe(false);
  });
});

describe("readJson", () => {
  const schema = z.object({ kind: z.string() });
  const json = { "content-type": "application/json" };

  it("parses a JSON body against the schema and reads an empty body as an empty object", async () => {
    expect(await readJson(post(json, '{"kind":"approve_spend","amountMinor":1}'), schema)).toEqual({ kind: "approve_spend" });
    expect(await readJson(post(json, ""), z.object({}))).toEqual({});
  });

  it("refuses a body that is not declared JSON, not JSON, or over the limit — measured in bytes", async () => {
    await expect(readJson(post({ "content-type": "text/plain" }, '{"kind":"x"}'), schema)).rejects.toMatchObject({ status: 400, message: "Content-Type must be application/json" });
    await expect(readJson(post({ "content-type": "application/x-www-form-urlencoded" }, "kind=x"), schema)).rejects.toMatchObject({ status: 400 });
    await expect(readJson(post(json, "{kind"), schema)).rejects.toMatchObject({ status: 400, message: "Request body is not valid JSON" });
    await expect(readJson(post(json, JSON.stringify({ kind: "x".repeat(200) })), schema, 64)).rejects.toMatchObject({ status: 400, message: "Request body is too large" });
    // 40 three-byte characters fit a 64-character limit but not a 64-byte one.
    await expect(readJson(post(json, JSON.stringify({ kind: "あ".repeat(40) })), schema, 64)).rejects.toMatchObject({ status: 400, message: "Request body is too large" });
    await expect(readJson(post(json, '{"kind":7}'), schema)).rejects.toBeInstanceOf(z.ZodError);
  });
});

describe("clientKey and requestOrigin", () => {
  it("derives a stable key from the first forwarded hop and never returns the address itself", () => {
    const key = clientKey(post({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }));
    expect(key).toMatch(/^[0-9a-f]{20}$/);
    expect(key).toBe(clientKey(post({ "x-forwarded-for": "203.0.113.7" })));
    expect(key).not.toBe(clientKey(post({ "x-forwarded-for": "203.0.113.8" })));
    expect(key).not.toContain("203");
    expect(clientKey(post({ "x-real-ip": "203.0.113.7" }))).toBe(key);
    expect(clientKey(post({}))).toBeNull();
  });

  it("reports the origin the browser used, honouring the proxy's forwarding headers", () => {
    expect(requestOrigin(new Request("http://127.0.0.1:3000/api/deals", { headers: { "x-forwarded-host": "pact.example", "x-forwarded-proto": "https" } }))).toBe("https://pact.example");
    expect(requestOrigin(new Request("https://pact.test/api/deals"))).toBe("https://pact.test");
  });
});
