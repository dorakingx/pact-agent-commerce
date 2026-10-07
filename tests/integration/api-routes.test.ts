/**
 * The deal-facing HTTP API, exercised by calling the exported route handlers with real Request
 * objects: sessions and cookies, same-origin enforcement, body limits, the error shape, and a
 * whole deal driven over HTTP — against the process-wide database (in-memory PGlite here), the
 * scripted agents and the labelled payment simulator, exactly as a keyless deployment runs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as advanceRoute from "@/app/api/deals/[id]/advance/route";
import * as artifactRoute from "@/app/api/deals/[id]/artifacts/[artifactId]/route";
import * as decisionRoute from "@/app/api/deals/[id]/decision/route";
import * as dealRoute from "@/app/api/deals/[id]/route";
import * as dealsRoute from "@/app/api/deals/route";
import * as cancelRoute from "@/app/api/paypal/cancel/route";
import * as returnRoute from "@/app/api/paypal/return/route";
import * as policyRoute from "@/app/api/policy/route";
import * as simulatedApproveRoute from "@/app/api/simulated/approve/route";
import * as simulatedCancelRoute from "@/app/api/simulated/cancel/route";
import * as webhookRoute from "@/app/api/webhooks/paypal/route";
import type { AdvanceResponse, DealView } from "@/lib/api/dto";
import { acquireDealLease, closeDb, getDb, releaseDealLease } from "@/lib/db";
import { DEFAULT_POLICY } from "@/lib/domain/schemas";
import { SimulatedProvider } from "@/lib/payments";
import { getServiceContext } from "@/lib/services/context";
import { SESSION_COOKIE, verifySession } from "@/lib/services/session";

/** A cookie jar standing in for the browser: what `cookies()` reads and what handlers set. */
const browser = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  writes: [] as { name: string; value: string; options: Record<string, unknown> }[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (browser.jar.has(name) ? { name, value: browser.jar.get(name) } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      browser.jar.set(name, value);
      browser.writes.push({ name, value, options });
    },
  }),
}));

/**
 * The simulator never verifies a webhook. To drive the verified path over HTTP, one test swaps
 * the signature check of the provider the routes are handed; everything else stays real.
 */
const signatures = vi.hoisted(() => ({ accept: null as string | null }));

vi.mock("@/lib/services/context", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/services/context")>();
  const getServiceContext: typeof original.getServiceContext = async () => {
    const ctx = await original.getServiceContext();
    const header = signatures.accept;
    if (header === null) return ctx;
    const verifyWebhook: typeof ctx.provider.verifyWebhook = async (headers) =>
      headers.get(header) === "valid" ? { verified: true, method: "simulated", reason: null } : { verified: false, method: "simulated", reason: "bad_signature" };
    return { ...ctx, provider: Object.assign(Object.create(ctx.provider) as typeof ctx.provider, { verifyWebhook }) };
  };
  return { ...original, getServiceContext };
});

const ORIGIN = "https://pact.test";
const SECRET = "api-routes-test-session-secret";
const ENV_KEYS = ["PACT_AI_MODE", "PACT_PAYMENT_MODE", "SESSION_SECRET", "DATABASE_URL", "POSTGRES_URL", "PGLITE_DIR", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "APP_URL", "NEXT_PUBLIC_APP_URL"] as const;
const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  // Keyless: scripted agents, the simulator, and an in-memory database of this process's own.
  process.env.PACT_AI_MODE = "scripted";
  process.env.PACT_PAYMENT_MODE = "simulated";
  process.env.SESSION_SECRET = SECRET;
});

afterAll(async () => {
  await closeDb();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  browser.jar.clear();
  browser.writes.length = 0;
  signatures.accept = null;
});

/* -------------------------------------------------------------------------- */
/*  Calling handlers                                                           */
/* -------------------------------------------------------------------------- */

type Handler = (request: Request, context: never) => Promise<Response>;

interface CallOptions {
  body?: unknown;
  /** Sent as-is instead of a JSON-encoded `body`. */
  raw?: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
}

interface Reply {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
}

async function call(handler: Handler, method: string, path: string, options: CallOptions = {}): Promise<Reply> {
  const headers = new Headers(method === "GET" ? {} : { origin: ORIGIN, "sec-fetch-site": "same-origin" });
  const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (payload !== undefined) headers.set("content-type", "application/json");
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  const request = new Request(`${ORIGIN}${path}`, { method, headers, body: payload });
  const response = await handler(request, { params: Promise.resolve(options.params ?? {}) } as never);
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

function dealOf(reply: Reply): DealView {
  return (reply.json as { deal: DealView }).deal;
}

function errorOf(reply: Reply): { code: string; message: string; requestId: string; details?: unknown } {
  return (reply.json as { error: { code: string; message: string; requestId: string; details?: unknown } }).error;
}

async function createDeal(scenarioId: string): Promise<DealView> {
  const reply = await call(dealsRoute.POST as Handler, "POST", "/api/deals", { body: { intent: "", scenarioId, tzOffsetMinutes: -540 } });
  expect(reply.status).toBe(201);
  return dealOf(reply);
}

function advance(id: string, options: CallOptions = {}): Promise<Reply> {
  return call(advanceRoute.POST as Handler, "POST", `/api/deals/${id}/advance`, { body: {}, params: { id }, ...options });
}

function decide(id: string, body: unknown): Promise<Reply> {
  return call(decisionRoute.POST as Handler, "POST", `/api/deals/${id}/decision`, { body, params: { id } });
}

function view(id: string): Promise<Reply> {
  return call(dealRoute.GET as Handler, "GET", `/api/deals/${id}`, { params: { id } });
}

/** Advance over HTTP until the engine stops by itself. */
async function advanceToGate(id: string): Promise<DealView> {
  for (let guard = 0; guard < 30; guard += 1) {
    const reply = await advance(id);
    expect(reply.status).toBe(200);
    const result = reply.json as AdvanceResponse;
    expect(result.busy).toBe(false);
    if (result.executed === null) return result.deal;
  }
  throw new Error("the deal never reached a gate");
}

/** Switch to another browser and back. */
function withBrowser<T>(jar: Map<string, string>, run: () => Promise<T>): Promise<T> {
  const mine = new Map(browser.jar);
  browser.jar.clear();
  for (const [name, value] of jar) browser.jar.set(name, value);
  return run().finally(() => {
    browser.jar.clear();
    for (const [name, value] of mine) browser.jar.set(name, value);
  });
}

/* -------------------------------------------------------------------------- */

describe("sessions", () => {
  it("issues a signed, http-only session cookie on the first deal and reuses it afterwards", async () => {
    const first = await createDeal("happy-path");
    expect(browser.writes).toHaveLength(1);
    const cookie = browser.writes[0];
    expect(cookie.name).toBe(SESSION_COOKIE);
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
    const sessionId = verifySession(cookie.value, SECRET);
    expect(sessionId).toMatch(/^sess_[a-z0-9]{24}$/);
    expect(first.isOwner).toBe(true);
    // The session id never appears in what the browser is sent.
    expect(JSON.stringify(first)).not.toContain(sessionId ?? "");

    const second = await createDeal("revision");
    expect(browser.writes).toHaveLength(1);
    const list = await call(dealsRoute.GET as Handler, "GET", "/api/deals");
    expect(list.status).toBe(200);
    expect((list.json as { deals: { id: string }[] }).deals.map((deal) => deal.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(list.headers.get("cache-control")).toBe("no-store");
  });

  it("does not create a session for reads, and a browser without one owns nothing", async () => {
    const mine = await createDeal("happy-path");
    await withBrowser(new Map(), async () => {
      browser.writes.length = 0;
      const list = await call(dealsRoute.GET as Handler, "GET", "/api/deals");
      expect(list.json).toEqual({ deals: [] });
      const seen = await view(mine.id);
      expect(seen.status).toBe(200);
      expect(dealOf(seen)).toMatchObject({ id: mine.id, isOwner: false, mandate: null });
      expect((await call(policyRoute.GET as Handler, "GET", "/api/policy")).json).toEqual({ policy: DEFAULT_POLICY, spentTodayMinor: 0, isDefault: true });

      // Changing someone else's deal is refused, and still creates no session.
      const refused = await advance(mine.id);
      expect(refused.status).toBe(403);
      expect(errorOf(refused).code).toBe("forbidden");
      expect((await decide(mine.id, { kind: "cancel_payment" })).status).toBe(403);
      expect(browser.writes).toEqual([]);
    });
  });

  it("treats a cookie with a bad signature as no session at all", async () => {
    const mine = await createDeal("happy-path");
    const genuine = browser.jar.get(SESSION_COOKIE) ?? "";
    const forged = `${genuine.slice(0, genuine.lastIndexOf("."))}.${"A".repeat(43)}`;
    await withBrowser(new Map([[SESSION_COOKIE, forged]]), async () => {
      expect((await advance(mine.id)).status).toBe(403);
      expect(dealOf(await view(mine.id)).isOwner).toBe(false);
    });
    // Another real session is just as unable to act on it.
    await withBrowser(new Map(), async () => {
      await createDeal("revision");
      expect((await advance(mine.id)).status).toBe(403);
      expect((await decide(mine.id, { kind: "approve_spend" })).status).toBe(403);
    });
    expect((await advance(mine.id)).status).toBe(200);
  });
});

describe("request hygiene", () => {
  it("refuses state-changing requests from another site", async () => {
    const deal = await createDeal("happy-path");
    const before = dealOf(await view(deal.id));

    const crossOrigin = await advance(deal.id, { headers: { origin: "https://evil.example" } });
    const crossSite = await advance(deal.id, { headers: { "sec-fetch-site": "cross-site" } });
    const sameSiteOtherOrigin = await advance(deal.id, { headers: { "sec-fetch-site": "same-site", origin: "https://other.pact.test" } });
    for (const reply of [crossOrigin, crossSite, sameSiteOtherOrigin]) {
      expect(reply.status).toBe(403);
      expect(errorOf(reply)).toMatchObject({ code: "forbidden", message: "Cross-site requests are not allowed" });
    }
    const creation = await call(dealsRoute.POST as Handler, "POST", "/api/deals", { body: { intent: "", scenarioId: "happy-path" }, headers: { origin: "https://evil.example" } });
    expect(creation.status).toBe(403);
    expect((await call(policyRoute.PUT as Handler, "PUT", "/api/policy", { body: DEFAULT_POLICY, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);

    expect(dealOf(await view(deal.id)).audit).toEqual(before.audit);
  });

  it("answers every error in one shape, with a request id that matches the response header", async () => {
    const reply = await view("deal_doesnotexist00");
    expect(reply.status).toBe(404);
    expect(reply.json).toEqual({ error: { code: "not_found", message: "Deal not found", requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
    expect(reply.headers.get("x-request-id")).toBe(errorOf(reply).requestId);
    expect(reply.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 404 for unknown deals on every deal route", async () => {
    await createDeal("happy-path");
    const id = "deal_000000000000";
    expect((await view(id)).status).toBe(404);
    expect((await advance(id)).status).toBe(404);
    expect((await decide(id, { kind: "approve_spend" })).status).toBe(404);
    const artifact = await call(artifactRoute.GET as Handler, "GET", `/api/deals/${id}/artifacts/art_x`, { params: { id, artifactId: "art_x" } });
    expect(artifact.status).toBe(404);
    // Without a session the answer for an unknown deal is still "unknown", not "forbidden".
    await withBrowser(new Map(), async () => {
      expect((await advance(id)).status).toBe(404);
    });
  });

  it("accepts only JSON bodies of a sane size and shape", async () => {
    const post = (options: CallOptions): Promise<Reply> => call(dealsRoute.POST as Handler, "POST", "/api/deals", options);

    const form = await post({ raw: "intent=hello&scenarioId=happy-path", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(form.status).toBe(400);
    expect(errorOf(form)).toMatchObject({ code: "invalid_request", message: "Content-Type must be application/json" });

    expect(errorOf(await post({ raw: "{ not json" })).message).toBe("Request body is not valid JSON");

    const oversize = await post({ body: { intent: "x".repeat(20_000) } });
    expect(oversize.status).toBe(400);
    expect(errorOf(oversize).message).toBe("Request body is too large");
    const declaredOversize = await post({ body: { intent: "short" }, headers: { "content-length": "999999" } });
    expect(errorOf(declaredOversize).message).toBe("Request body is too large");

    const wrongShape = await post({ body: { intent: 42, tzOffsetMinutes: "soon" } });
    expect(wrongShape.status).toBe(400);
    expect(errorOf(wrongShape)).toMatchObject({ code: "invalid_request", message: "The request is not valid." });
    expect(errorOf(wrongShape).details).toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ path: "intent" })]) });

    expect((await post({ body: { intent: "too short" } })).status).toBe(400);
    expect((await post({ body: { intent: "", scenarioId: "nope" } })).status).toBe(400);
    expect((await decide((await createDeal("happy-path")).id, { kind: "release_everything" })).status).toBe(400);
    // The advance endpoint takes JSON too, so a plain HTML form cannot reach it.
    const deal = await createDeal("happy-path");
    expect((await advance(deal.id, { raw: "", headers: { "content-type": "text/plain" } })).status).toBe(400);
  });

  it("ignores amounts, statuses and owners a browser tries to supply", async () => {
    const reply = await call(dealsRoute.POST as Handler, "POST", "/api/deals", {
      body: { intent: "", scenarioId: "happy-path", priceMinor: 1, status: "completed", owner: "system", sellerId: "pixelharbor", mandate: { budgetMinor: 1 } },
    });
    expect(reply.status).toBe(201);
    const deal = dealOf(reply);
    expect(deal).toMatchObject({ status: "negotiating", isOwner: true, seller: { id: "northwind" }, payment: null, contract: null });
    // The scenario's own "under $50", never the browser's figure.
    expect(deal.mandate?.budgetMinor).toBe(4999);

    const advanced = await advance(deal.id, { body: { status: "verified", executed: "capture", amountMinor: 1 } });
    expect(advanced.json).toMatchObject({ executed: "negotiate", deal: { status: "negotiating" } });
  });

  it("declares the same execution budget on every route", () => {
    const routes = [dealsRoute, dealRoute, advanceRoute, decisionRoute, artifactRoute, returnRoute, cancelRoute, simulatedApproveRoute, simulatedCancelRoute, webhookRoute, policyRoute];
    for (const routeModule of routes) expect(routeModule.maxDuration).toBe(60);
  });
});

describe("a deal over HTTP", () => {
  it("create → view → advance → decision → pay → capture, then download a deliverable", async () => {
    const created = await createDeal("approval");
    expect(dealOf(await view(created.id))).toMatchObject({ id: created.id, status: "negotiating", isOwner: true });

    const gate = await advanceToGate(created.id);
    expect(gate).toMatchObject({ status: "awaiting_approval", next: { kind: "human", gate: "approval" } });
    // The decision names a kind; it is refused at the wrong gate and accepted at the right one.
    const wrongGate = await decide(created.id, { kind: "release_payment" });
    expect(wrongGate.status).toBe(409);
    expect(errorOf(wrongGate).code).toBe("conflict");
    const approved = await decide(created.id, { kind: "approve_spend", reason: "Fine by me." });
    expect(approved.status).toBe(200);
    expect(dealOf(approved)).toMatchObject({ status: "payment_pending", humanDecision: { kind: "approve_spend", reason: "Fine by me." } });

    const waiting = await advanceToGate(created.id);
    expect(waiting).toMatchObject({ status: "awaiting_payment", flags: { simulatedPayment: true } });
    const orderId = waiting.payment?.orderId ?? "";
    expect(waiting.payment?.approveUrl).toBe(`/pay/simulated/${orderId}`);

    // The simulated payer approves on the labelled approval page.
    const paid = await call(simulatedApproveRoute.POST as Handler, "POST", "/api/simulated/approve", { body: { orderId } });
    expect(paid.status).toBe(200);
    expect(paid.json).toEqual({ dealId: created.id, outcome: "authorized" });

    const done = await advanceToGate(created.id);
    expect(done).toMatchObject({ status: "completed", payment: { status: "captured", capturedMinor: 18_000 }, flags: { auditChainValid: true } });

    const copy = done.submissions[0].artifacts[0];
    const file = await call(artifactRoute.GET as Handler, "GET", `/api/deals/${created.id}/artifacts/${copy.id}`, { params: { id: created.id, artifactId: copy.id } });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(file.headers.get("content-disposition")).toMatch(new RegExp(`^attachment; filename="${done.code}-copy-1-[a-z]{2}\\.txt"$`));
    expect(file.text).toBe(copy.kind === "copy" ? copy.text : "");
  });

  it("serves an illustration as a sandboxed attachment, to anyone who can read the deal", async () => {
    const created = await createDeal("happy-path");
    const waiting = await advanceToGate(created.id);
    await call(simulatedApproveRoute.POST as Handler, "POST", "/api/simulated/approve", { body: { orderId: waiting.payment?.orderId } });
    const done = await advanceToGate(created.id);
    const artifact = done.submissions[0].artifacts[1];

    await withBrowser(new Map(), async () => {
      const path = `/api/deals/${created.id}/artifacts/${artifact.id}`;
      const file = await call(artifactRoute.GET as Handler, "GET", path, { params: { id: created.id, artifactId: artifact.id } });
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toBe("image/svg+xml");
      expect(file.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
      expect(file.headers.get("x-content-type-options")).toBe("nosniff");
      expect(file.headers.get("content-disposition")).toMatch(new RegExp(`^attachment; filename="${done.code}-illustration-\\d-\\d+x\\d+\\.svg"$`));
      expect(file.text.startsWith("<svg")).toBe(true);
      expect(file.text).toBe(artifact.kind === "illustration" ? artifact.svg : "");

      const missing = await call(artifactRoute.GET as Handler, "GET", `/api/deals/${created.id}/artifacts/art_missing`, { params: { id: created.id, artifactId: "art_missing" } });
      expect(missing.status).toBe(404);
      expect(errorOf(missing).message).toBe("Artifact not found");
    });
  });
});

describe("returning from PayPal", () => {
  const comeBack = (query: string): Promise<Reply> => call(returnRoute.GET as Handler, "GET", `/api/paypal/return${query}`);

  it("redirects to the deal's own page with what actually happened at the provider", async () => {
    const created = await createDeal("happy-path");
    const waiting = await advanceToGate(created.id);
    const orderId = waiting.payment?.orderId ?? "";
    const target = `/deals/${created.id}`;

    // Not approved yet: the redirect proves nothing, PayPal's record decides.
    const premature = await comeBack(`?deal=${created.id}&token=${orderId}`);
    expect(premature.status).toBe(303);
    expect(premature.headers.get("location")).toBe(`${target}?paypal=pending`);
    expect(premature.text).toBe("");

    // A return naming someone else's order is refused even once the payer has approved.
    const { provider } = await getServiceContext();
    if (!(provider instanceof SimulatedProvider)) throw new Error("expected the simulator");
    await provider.approve(orderId);
    expect((await comeBack(`?deal=${created.id}&token=SIM-O-0000000000000000`)).headers.get("location")).toBe(`${target}?paypal=error`);
    expect((await comeBack(`?deal=${created.id}&token=${encodeURIComponent("<script>")}`)).headers.get("location")).toBe(`${target}?paypal=error`);
    expect(dealOf(await view(created.id)).status).toBe("awaiting_payment");

    // The genuine return works without the session cookie (PayPal may hand the payer back in another context).
    await withBrowser(new Map(), async () => {
      const approved = await comeBack(`?deal=${created.id}&token=${orderId}&PayerID=TESTPAYER`);
      expect(approved.status).toBe(303);
      expect(approved.headers.get("location")).toBe(`${target}?paypal=approved`);
    });
    expect(dealOf(await view(created.id))).toMatchObject({ status: "authorized", payment: { status: "authorized", authorizedMinor: 4700 } });
    // Coming back twice is harmless.
    expect((await comeBack(`?deal=${created.id}&token=${orderId}`)).headers.get("location")).toBe(`${target}?paypal=approved`);
  });

  it("never redirects anywhere but this site", async () => {
    for (const deal of ["https://evil.example/x", "//evil.example", "deal_abc/../../admin", "", "deal_ABCDEFGH1234", `deal_${"a".repeat(40)}`]) {
      for (const reply of [
        await comeBack(`?deal=${encodeURIComponent(deal)}&token=X`),
        await call(cancelRoute.GET as Handler, "GET", `/api/paypal/cancel?deal=${encodeURIComponent(deal)}`),
      ]) {
        expect(reply.status).toBe(303);
        expect(reply.headers.get("location")).toMatch(/^\/workspace\?paypal=(error|cancelled)$/);
      }
    }
    expect((await comeBack("")).headers.get("location")).toBe("/workspace?paypal=error");
    // A well-formed id that does not exist leads to that deal's (not found) page, still on this site.
    expect((await comeBack("?deal=deal_000000000000&token=X")).headers.get("location")).toBe("/deals/deal_000000000000?paypal=error");
  });

  it("a cancelled approval leaves the deal waiting for payment", async () => {
    const created = await createDeal("happy-path");
    const waiting = await advanceToGate(created.id);
    const reply = await call(cancelRoute.GET as Handler, "GET", `/api/paypal/cancel?deal=${created.id}`);
    expect(reply.status).toBe(303);
    expect(reply.headers.get("location")).toBe(`/deals/${created.id}?paypal=cancelled`);
    const after = dealOf(await view(created.id));
    expect(after.status).toBe("awaiting_payment");
    expect(after.audit).toEqual(waiting.audit);
  });
});

describe("the simulated approval endpoints", () => {
  const approve = (orderId: unknown): Promise<Reply> => call(simulatedApproveRoute.POST as Handler, "POST", "/api/simulated/approve", { body: { orderId } });
  const cancel = (orderId: unknown): Promise<Reply> => call(simulatedCancelRoute.POST as Handler, "POST", "/api/simulated/cancel", { body: { orderId } });

  it("belong to the deal's owner and to known orders", async () => {
    const created = await createDeal("happy-path");
    const orderId = (await advanceToGate(created.id)).payment?.orderId ?? "";

    await withBrowser(new Map(), async () => {
      expect((await approve(orderId)).status).toBe(403);
      await createDeal("revision");
      expect((await approve(orderId)).status).toBe(403);
      expect((await cancel(orderId)).status).toBe(403);
    });
    expect((await approve("SIM-O-0000000000000000")).status).toBe(404);
    expect((await approve("not an order")).status).toBe(404);
    expect((await approve(42)).status).toBe(400);
    expect(dealOf(await view(created.id)).status).toBe("awaiting_payment");

    expect((await approve(orderId)).json).toEqual({ dealId: created.id, outcome: "authorized" });
    // A double click on "Approve" is answered, not failed.
    expect((await approve(orderId)).json).toEqual({ dealId: created.id, outcome: "authorized" });
    // Once funds are held the order can no longer be cancelled from the approval page.
    expect((await cancel(orderId)).status).toBe(409);
  });

  it("cancelling voids the simulated order and cancels the deal as the owner's decision", async () => {
    const created = await createDeal("happy-path");
    const orderId = (await advanceToGate(created.id)).payment?.orderId ?? "";
    const reply = await cancel(orderId);
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ dealId: created.id, outcome: "cancelled" });
    const after = dealOf(await view(created.id));
    expect(after).toMatchObject({ status: "cancelled", payment: { status: "voided" }, humanDecision: { kind: "cancel_payment" } });
    // The dead order cannot be approved behind PACT's back.
    expect((await approve(orderId)).json).toEqual({ dealId: created.id, outcome: "failed" });
    expect(dealOf(await view(created.id)).status).toBe("cancelled");
  });

  it("do not exist when real PayPal is configured", async () => {
    const created = await createDeal("happy-path");
    const orderId = (await advanceToGate(created.id)).payment?.orderId ?? "";
    delete process.env.PACT_PAYMENT_MODE;
    process.env.PAYPAL_CLIENT_ID = "test-client-id";
    process.env.PAYPAL_CLIENT_SECRET = "test-client-secret";
    try {
      expect((await getServiceContext()).provider.kind).toBe("paypal_sandbox");
      for (const reply of [await approve(orderId), await cancel(orderId), await approve(42)]) {
        expect(reply.status).toBe(404);
        expect(errorOf(reply).code).toBe("not_found");
      }
    } finally {
      delete process.env.PAYPAL_CLIENT_ID;
      delete process.env.PAYPAL_CLIENT_SECRET;
      process.env.PACT_PAYMENT_MODE = "simulated";
    }
    expect(dealOf(await view(created.id)).status).toBe("awaiting_payment");
  });
});

describe("the webhook endpoint", () => {
  const post = (raw: string, headers: Record<string, string> = {}): Promise<Reply> =>
    call(webhookRoute.POST as Handler, "POST", "/api/webhooks/paypal", { raw, headers: { origin: "https://www.paypal.com", "sec-fetch-site": "cross-site", ...headers } });

  it("answers an unverified event with a bare 400 and changes nothing", async () => {
    const created = await createDeal("happy-path");
    const waiting = await advanceToGate(created.id);
    const forged = JSON.stringify({
      id: "WH-FORGED-0001",
      event_type: "PAYMENT.AUTHORIZATION.CREATED",
      resource: { id: "SIM-A-FORGED", amount: { currency_code: "USD", value: "47.00" }, supplementary_data: { related_ids: { order_id: waiting.payment?.orderId } } },
    });

    // It is reachable cross-origin (PayPal is another site), but only a verified signature counts.
    const reply = await post(forged, { "paypal-transmission-id": "forged", "paypal-transmission-sig": "forged" });
    expect(reply.status).toBe(400);
    expect(reply.text).toBe("");
    const after = dealOf(await view(created.id));
    expect(after).toMatchObject({ status: "awaiting_payment", payment: { status: "created", authorizedMinor: 0 } });
    expect(after.audit).toEqual(waiting.audit);
  });

  it("refuses bodies larger than any genuine event", async () => {
    expect((await post("x".repeat(300 * 1024))).status).toBe(400);
    expect((await post("{}", { "content-length": String(10 * 1024 * 1024) })).status).toBe(400);
  });

  it("acknowledges a verified event once it is applied, and asks for redelivery while the deal is busy", async () => {
    signatures.accept = "x-test-signature";
    const created = await createDeal("happy-path");
    const waiting = await advanceToGate(created.id);
    await call(simulatedApproveRoute.POST as Handler, "POST", "/api/simulated/approve", { body: { orderId: waiting.payment?.orderId } });
    const done = await advanceToGate(created.id);
    const event = JSON.stringify({
      id: "WH-API-ROUTE-0001",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: done.payment?.captureId,
        amount: { currency_code: "USD", value: "47.00" },
        supplementary_data: { related_ids: { order_id: done.payment?.orderId, authorization_id: done.payment?.authorizationId } },
      },
    });
    const signed = { "x-test-signature": "valid" };

    // The same body without a valid signature is still nothing.
    expect((await post(event, { "x-test-signature": "forged" })).status).toBe(400);
    expect(dealOf(await view(created.id)).payment?.webhookConfirmed.captured).toBe(false);

    // While a step holds the deal, the event is neither applied nor acknowledged: PayPal will send it again.
    const db = await getDb();
    await acquireDealLease(db, created.id, "step_in-flight", 120, new Date());
    const busy = await post(event, signed);
    expect(busy.status).toBe(503);
    expect(busy.text).toBe("");
    expect(busy.headers.get("retry-after")).toBe("5");
    expect(dealOf(await view(created.id)).payment?.webhookConfirmed.captured).toBe(false);
    await releaseDealLease(db, created.id, "step_in-flight");

    const applied = await post(event, signed);
    expect(applied.status).toBe(200);
    expect(applied.json).toEqual({ received: true });
    expect(dealOf(await view(created.id)).payment?.webhookConfirmed.captured).toBe(true);
    // A redelivery is acknowledged and changes nothing.
    const trail = dealOf(await view(created.id)).audit;
    expect((await post(event, signed)).json).toEqual({ received: true });
    expect(dealOf(await view(created.id)).audit).toEqual(trail);
  });
});

describe("the policy endpoints", () => {
  const put = (body: unknown): Promise<Reply> => call(policyRoute.PUT as Handler, "PUT", "/api/policy", { body });
  const get = (): Promise<Reply> => call(policyRoute.GET as Handler, "GET", "/api/policy");

  it("save a policy for the calling session only", async () => {
    const custom = { ...DEFAULT_POLICY, autonomousLimitMinor: 2500, dailyLimitMinor: 50_000 };
    const saved = await put(custom);
    expect(saved.status).toBe(200);
    expect(saved.json).toEqual({ policy: custom, spentTodayMinor: 0, isDefault: false });
    // Saving a policy may be a session's first act.
    expect(browser.writes.map((write) => write.name)).toEqual([SESSION_COOKIE]);
    expect((await get()).json).toEqual({ policy: custom, spentTodayMinor: 0, isDefault: false });

    await withBrowser(new Map(), async () => {
      expect((await get()).json).toMatchObject({ policy: DEFAULT_POLICY, isDefault: true });
    });

    // The new limit applies to this session's next deal: $47.00 now needs approval.
    const deal = await createDeal("happy-path");
    expect(await advanceToGate(deal.id)).toMatchObject({ status: "awaiting_approval", policy: { outcome: "needs_approval" } });
  });

  it("reject documents that are not a valid policy", async () => {
    for (const invalid of [
      { ...DEFAULT_POLICY, autonomousLimitMinor: 200_000 },
      { ...DEFAULT_POLICY, maxTransactionMinor: 600_000 },
      { ...DEFAULT_POLICY, dailyLimitMinor: -1 },
      { ...DEFAULT_POLICY, autoCaptureMinConfidence: 0.2 },
      { ...DEFAULT_POLICY, allowedCategories: ["illustration", "restricted"] },
      { ...DEFAULT_POLICY, allowedCategories: ["yachts"] },
      { autonomousLimitMinor: 100 },
      "not a policy",
    ]) {
      const reply = await put(invalid);
      expect(reply.status).toBe(400);
      expect(errorOf(reply).code).toBe("invalid_request");
    }
    expect((await get()).json).toMatchObject({ isDefault: true });
  });
});
