/**
 * The HTTP API end to end, against the production build.
 *
 * Every demo scenario is driven the way the browser drives it — create a deal, advance one step
 * per request, decide at the human gates, approve the simulated order — and the properties the
 * transport has to guarantee are checked from outside: sessions and ownership, same-origin
 * enforcement, body limits, and that nothing a client sends can carry an amount or a status.
 *
 * The server runs scripted agents and the labelled payment simulator (see playwright.config.ts),
 * so the outcomes asserted here — prices, rounds, decisions — are exact and repeatable.
 */
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import type {
  AdvanceResponse,
  ApiErrorBody,
  DealListResponse,
  DealResponse,
  DealView,
  OpsSnapshot,
  PolicyResponse,
  ReconciliationView,
  StepKind,
  SystemStatus,
  WalletStatus,
} from "../../src/lib/api/dto";
import type { ScenarioId } from "../../src/lib/domain/scenarios";
import type { HumanDecisionKind } from "../../src/lib/domain/schemas";
import type { DealStatus } from "../../src/lib/domain/status";

/** 14:00 in Tokyo is not required here: the scripted parser only needs a fixed offset to resolve "tomorrow at 6 PM". */
const TOKYO_OFFSET_MINUTES = -540;
/** A deal takes about fifteen requests; anything near this many is stuck. */
const MAX_TURNS = 60;
const ARTIFACT_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

type JsonBody = Record<string, unknown>;

/** One browser's view of the API: a cookie jar plus the Origin header a same-origin page would send. */
interface Client {
  get(path: string): Promise<APIResponse>;
  post(path: string, data?: JsonBody): Promise<APIResponse>;
  put(path: string, data: JsonBody): Promise<APIResponse>;
  /** A POST exactly as given: for bodies and headers no well-behaved page would send. */
  rawPost(path: string, body: string, headers: Record<string, string>): Promise<APIResponse>;
}

function clientOf(request: APIRequestContext, origin: string): Client {
  const sameOrigin = { origin };
  return {
    // Redirects are part of the contract (PayPal returns), so they are never followed silently.
    get: (path) => request.get(path, { maxRedirects: 0 }),
    post: (path, data = {}) => request.post(path, { headers: sameOrigin, data }),
    put: (path, data) => request.put(path, { headers: sameOrigin, data }),
    // As bytes: given a string and a JSON content type, Playwright would re-encode anything that is not valid JSON.
    rawPost: (path, body, headers) => request.post(path, { headers, data: Buffer.from(body, "utf8") }),
  };
}

async function jsonOf<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return (await response.json()) as T;
}

async function errorOf(response: APIResponse, status: number): Promise<ApiErrorBody["error"]> {
  const body = await jsonOf<ApiErrorBody>(response, status);
  // Every error carries the id it was logged under, in the body and in the header.
  expect(body.error.requestId).toBe(response.headers()["x-request-id"]);
  expect(response.headers()["cache-control"]).toBe("no-store");
  return body.error;
}

async function createDeal(client: Client, scenarioId: ScenarioId, extra: JsonBody = {}): Promise<DealView> {
  const response = await client.post("/api/deals", { intent: "", scenarioId, tzOffsetMinutes: TOKYO_OFFSET_MINUTES, ...extra });
  return (await jsonOf<DealResponse>(response, 201)).deal;
}

async function readDeal(client: Client, dealId: string): Promise<DealView> {
  return (await jsonOf<DealResponse>(await client.get(`/api/deals/${dealId}`))).deal;
}

async function decide(client: Client, deal: DealView, kind: HumanDecisionKind, extra: JsonBody = {}): Promise<DealView> {
  const response = await client.post(`/api/deals/${deal.id}/decision`, { kind, reason: "Decided by the end-to-end test", ...extra });
  return (await jsonOf<DealResponse>(response)).deal;
}

/** What the payer does on the simulated approval page; PACT then authorizes exactly as after a PayPal return. */
async function approveSimulatedOrder(client: Client, deal: DealView): Promise<DealView> {
  const orderId = deal.payment?.orderId ?? "";
  expect(deal.payment?.approveUrl).toBe(`/pay/simulated/${orderId}`);
  const approved = await jsonOf<{ dealId: string; outcome: string }>(await client.post("/api/simulated/approve", { orderId }));
  expect(approved).toEqual({ dealId: deal.id, outcome: "authorized" });
  return readDeal(client, deal.id);
}

interface Driven {
  deal: DealView;
  /** Statuses in order, consecutive repeats collapsed (a negotiation stays "negotiating" for several moves). */
  path: DealStatus[];
  /** Automatic steps in order, consecutive repeats collapsed. */
  steps: StepKind[];
}

function pushDistinct<T>(list: T[], value: T): void {
  if (list[list.length - 1] !== value) list.push(value);
}

/**
 * Drive a deal until `stop` says so (by default: until nothing is left to do), one request per
 * step, playing the human at each gate. `review` is the decision taken if verification asks for one.
 */
async function drive(
  client: Client,
  first: DealView,
  options: { review?: HumanDecisionKind; stop?: (deal: DealView) => boolean } = {},
): Promise<Driven> {
  const stop = options.stop ?? ((deal: DealView) => deal.next.kind === "done");
  let deal = first;
  const path: DealStatus[] = [deal.status];
  const steps: StepKind[] = [];
  for (let turn = 0; turn < MAX_TURNS && !stop(deal); turn += 1) {
    if (deal.next.kind === "auto") {
      const result = await jsonOf<AdvanceResponse>(await client.post(`/api/deals/${deal.id}/advance`));
      // One client, scripted agents, a simulator that never fails: every call runs exactly one step.
      expect(result.busy).toBe(false);
      expect(result.executed, result.deal.lastError ?? "no step ran").not.toBeNull();
      if (result.executed !== null) pushDistinct(steps, result.executed);
      deal = result.deal;
    } else if (deal.next.kind === "human") {
      if (deal.next.gate === "approval") deal = await decide(client, deal, "approve_spend");
      else if (deal.next.gate === "payment") deal = await approveSimulatedOrder(client, deal);
      else deal = await decide(client, deal, options.review ?? "release_payment");
    }
    pushDistinct(path, deal.status);
  }
  expect(stop(deal), `the deal stopped at "${deal.status}"`).toBe(true);
  return { deal: await readDeal(client, deal.id), path, steps };
}

function auditTypes(deal: DealView): string[] {
  return deal.audit.map((event) => event.type);
}

test.describe("the server under test", () => {
  test("runs scripted agents, the payment simulator and a healthy database", async ({ request, baseURL }) => {
    const status = await jsonOf<SystemStatus>(await clientOf(request, baseURL ?? "").get("/api/health"));
    expect(status.payments).toEqual({ provider: "simulated", configured: expect.any(Boolean), webhooks: expect.any(Boolean), delegatedWallet: false });
    expect(status.ai.mode).toBe("scripted");
    expect(status.database).toBe("pglite");
    expect(status.degraded).toBeUndefined();
  });

  test("publishes the API description it implements", async ({ request }) => {
    const document = await jsonOf<{ openapi: string; paths: Record<string, unknown> }>(await request.get("/openapi.json"));
    expect(document.openapi).toMatch(/^3\.1\./);
    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining(["/api/deals", "/api/deals/{id}/advance", "/api/webhooks/paypal"]));
  });
});

test.describe("the four scenarios over HTTP", () => {
  test("verified delivery: negotiate, sign, authorize, deliver, verify, capture", async ({ request, baseURL }) => {
    const client = clientOf(request, baseURL ?? "");
    // Whatever else the browser claims is dropped: the price, the status and the owner are the server's.
    const created = await createDeal(client, "happy-path", { priceMinor: 1, amountMinor: 1, status: "completed", owner: "system" });
    expect(created).toMatchObject({ status: "negotiating", isOwner: true, seller: { id: "northwind" }, contract: null, payment: null });
    expect(created.flags).toEqual({ aiDegraded: false, simulatedPayment: true, auditChainValid: true });

    const { deal, path, steps } = await drive(client, created);
    expect(path).toEqual(["negotiating", "agreed", "contracted", "payment_pending", "awaiting_payment", "authorized", "submitted", "verified", "completed"]);
    expect(steps).toEqual(["negotiate", "contract", "policy", "order", "fulfill", "verify", "capture"]);
    expect(deal).toMatchObject({
      status: "completed",
      next: { kind: "done" },
      negotiation: { status: "agreed", agreedTerms: { priceMinor: 4700 } },
      policy: { outcome: "allow" },
      payment: { provider: "simulated", mode: "interactive", status: "captured", amountMinor: 4700, authorizedMinor: 4700, capturedMinor: 4700 },
      revisions: { used: 0 },
      lastError: null,
    });
    expect(deal.contract?.contract.price).toEqual({ amountMinor: 4700, currency: "USD" });
    expect(deal.contract?.paymentState).toBe("captured");
    expect(deal.negotiation.moves).toHaveLength(6);
    expect(deal.submissions).toHaveLength(1);
    expect(deal.submissions[0].artifacts).toHaveLength(6);
    expect(deal.reports.map((report) => report.decision)).toEqual(["capture_eligible"]);
    expect(deal.reports[0].contractHash).toBe(deal.contract?.termsHash);
    expect(auditTypes(deal).slice(-2)).toEqual(["payment.captured", "deal.completed"]);
    expect(deal.flags.auditChainValid).toBe(true);

    // Nothing is left to run: asking again changes nothing and captures nothing.
    const again = await jsonOf<AdvanceResponse>(await client.post(`/api/deals/${deal.id}/advance`));
    expect(again).toMatchObject({ executed: null, busy: false, deal: { status: "completed", payment: { capturedMinor: 4700 } } });
    expect(again.deal.audit).toHaveLength(deal.audit.length);
  });

  test("failed verification: a missing version blocks the capture until the seller revises", async ({ request, baseURL }) => {
    const client = clientOf(request, baseURL ?? "");
    const { deal, path } = await drive(client, await createDeal(client, "revision"));
    expect(path).toEqual([
      "negotiating",
      "agreed",
      "contracted",
      "payment_pending",
      "awaiting_payment",
      "authorized",
      "submitted",
      "revision_required",
      "submitted",
      "verified",
      "completed",
    ]);
    expect(deal.reports.map((report) => report.decision)).toEqual(["revision_required", "capture_eligible"]);
    expect(deal.reports[0].failedRuleIds).toEqual(["R2"]);
    expect(deal.submissions.map((submission) => submission.artifacts.length)).toEqual([3, 4]);
    expect(deal).toMatchObject({ status: "completed", revisions: { used: 1, limit: 1 }, payment: { status: "captured", capturedMinor: 2700 } });
    // Captured once, and only after the second verification.
    const types = auditTypes(deal);
    expect(types.filter((type) => type === "payment.captured")).toHaveLength(1);
    expect(types.indexOf("payment.captured")).toBeGreaterThan(types.lastIndexOf("verification.completed"));
  });

  test("human approval: a price above the autonomous limit pauses before any PayPal call", async ({ request, baseURL }) => {
    const client = clientOf(request, baseURL ?? "");
    const gate = await drive(client, await createDeal(client, "approval"), { stop: (deal) => deal.next.kind !== "auto" });
    expect(gate.deal).toMatchObject({
      status: "awaiting_approval",
      next: { kind: "human", gate: "approval", options: ["approve_spend", "decline_spend"] },
      policy: { outcome: "needs_approval" },
      payment: null,
    });
    expect(gate.deal.policy?.checks.filter((check) => check.outcome !== "pass").map((check) => check.id)).toEqual(["autonomous_limit"]);

    const { deal, path } = await drive(client, gate.deal);
    expect(path).toEqual(["awaiting_approval", "payment_pending", "awaiting_payment", "authorized", "submitted", "verified", "completed"]);
    expect(deal).toMatchObject({ status: "completed", humanDecision: { kind: "approve_spend" }, payment: { status: "captured", capturedMinor: 18000 } });
    expect(deal.submissions[0].artifacts).toHaveLength(12);
  });

  test("hostile delivery: hidden instructions force a human review, and a rejection voids the hold", async ({ request, baseURL }) => {
    const client = clientOf(request, baseURL ?? "");
    const review = await drive(client, await createDeal(client, "injection"), { stop: (deal) => deal.status === "in_review" });
    expect(review.path).toEqual(["negotiating", "agreed", "contracted", "awaiting_approval", "payment_pending", "awaiting_payment", "authorized", "submitted", "in_review"]);
    expect(review.deal.policy?.checks.filter((check) => check.outcome !== "pass").map((check) => check.id)).toEqual(["seller_trust"]);
    expect(review.deal.reports[0]).toMatchObject({ decision: "human_review", failedRuleIds: ["R6"] });
    expect(review.deal).toMatchObject({ payment: { status: "authorized", authorizedMinor: 1800, capturedMinor: 0 }, seller: { demoFault: "embeds_instructions" } });

    const { deal, path, steps } = await drive(client, review.deal, { review: "reject_delivery" });
    expect(path).toEqual(["in_review", "rejecting", "rejected"]);
    expect(steps).toEqual(["void"]);
    expect(deal).toMatchObject({ status: "rejected", humanDecision: { kind: "reject_delivery" }, payment: { status: "voided", capturedMinor: 0, captureId: null } });
    expect(auditTypes(deal)).not.toContain("payment.captured");
    expect(auditTypes(deal).slice(-2)).toEqual(["payment.voided", "deal.rejected"]);
  });

  test("a burst of parallel advance calls at 'verified' captures exactly once", async ({ request, baseURL }) => {
    const client = clientOf(request, baseURL ?? "");
    const verified = await drive(client, await createDeal(client, "happy-path"), { stop: (deal) => deal.status === "verified" });

    const burst = await Promise.all(Array.from({ length: 8 }, () => client.post(`/api/deals/${verified.deal.id}/advance`)));
    const results = await Promise.all(burst.map((response) => jsonOf<AdvanceResponse>(response)));
    expect(results.filter((result) => result.executed === "capture")).toHaveLength(1);
    // Everyone else either found the lease taken or arrived after the deal had ended.
    for (const result of results) expect(result.executed === "capture" || result.executed === null).toBe(true);

    const deal = await readDeal(client, verified.deal.id);
    expect(deal).toMatchObject({ status: "completed", payment: { status: "captured", capturedMinor: 4700 } });
    expect(auditTypes(deal).filter((type) => type === "payment.captured")).toHaveLength(1);
    expect(deal.flags.auditChainValid).toBe(true);
  });
});

test.describe("reading", () => {
  test("operations, deal list, policy, wallet, reconciliation and deliverables reflect the session's deals", async ({ request, baseURL, playwright }) => {
    const client = clientOf(request, baseURL ?? "");
    const anonymous = await playwright.request.newContext({ baseURL });
    const visitor = clientOf(anonymous, baseURL ?? "");

    // Reading never creates a session.
    const before = await request.get("/api/deals");
    expect(await jsonOf<DealListResponse>(before)).toEqual({ deals: [] });
    expect(before.headers()["set-cookie"]).toBeUndefined();
    const defaults = await jsonOf<PolicyResponse>(await client.get("/api/policy"));
    expect(defaults).toMatchObject({ isDefault: true, spentTodayMinor: 0, policy: { autonomousLimitMinor: 10000 } });

    const { deal } = await drive(client, await createDeal(client, "happy-path"));
    const rejected = (await drive(client, await createDeal(client, "injection"), { review: "reject_delivery" })).deal;

    const list = await jsonOf<DealListResponse>(await client.get("/api/deals"));
    expect(list.deals.map((summary) => summary.id)).toEqual([rejected.id, deal.id]);
    expect(list.deals[1]).toMatchObject({ code: deal.code, status: "completed", sellerName: "Northwind Studio", priceMinor: 4700 });

    const ops = await jsonOf<OpsSnapshot>(await client.get("/api/operations"));
    const mine = ops.deals.filter((row) => row.origin === "mine");
    expect(mine.map((row) => row.id).sort()).toEqual([deal.id, rejected.id].sort());
    expect(mine.find((row) => row.id === deal.id)).toMatchObject({ stage: "settled", outcome: "captured", capturedMinor: 4700, heldMinor: 0, paymentProvider: "simulated" });
    expect(mine.find((row) => row.id === rejected.id)).toMatchObject({ stage: "closed", outcome: "voided", capturedMinor: 0, heldMinor: 0, sellerTrust: "new" });
    expect(ops.paymentEvents.filter((event) => event.dealId === deal.id).map((event) => event.type)).toEqual(["order_created", "approved", "authorized", "captured"]);
    expect(ops.checks.filter((check) => check.dealId === deal.id)).toHaveLength(6);
    // Another browser sees neither deal in its ledger.
    const foreign = await jsonOf<OpsSnapshot>(await visitor.get("/api/operations"));
    expect(foreign.deals.filter((row) => row.id === deal.id || row.id === rejected.id)).toEqual([]);

    // The spend that counts against today's limit is what is held or captured — the voided hold is not.
    const policy = await jsonOf<PolicyResponse>(await client.get("/api/policy"));
    expect(policy).toMatchObject({ isDefault: true, spentTodayMinor: 4700 });
    const tightened = await jsonOf<PolicyResponse>(await client.put("/api/policy", { ...policy.policy, autonomousLimitMinor: 4000 }));
    expect(tightened).toMatchObject({ isDefault: false, policy: { autonomousLimitMinor: 4000 } });
    expect((await errorOf(await client.put("/api/policy", { ...policy.policy, autonomousLimitMinor: -1 }), 400)).code).toBe("invalid_request");
    expect((await errorOf(await client.put("/api/policy", { ...policy.policy, allowedCategories: ["restricted"] }), 400)).code).toBe("invalid_request");
    // The new limit applies to the next deal: $47.00 now needs a human.
    const next = await drive(client, await createDeal(client, "happy-path"), { stop: (candidate) => candidate.next.kind !== "auto" });
    expect(next.deal).toMatchObject({ status: "awaiting_approval", payment: null });

    const wallet = await jsonOf<WalletStatus>(await client.get("/api/wallet"));
    expect(wallet).toEqual({
      provider: "simulated",
      supportsVault: true,
      session: { connected: false, pending: false, payerEmailMasked: null },
      demo: { connected: false },
      effectiveMode: "interactive",
    });

    const reconciliation = await jsonOf<ReconciliationView>(await client.post(`/api/deals/${deal.id}/reconcile`));
    expect(reconciliation).toMatchObject({ dealId: deal.id, status: "match", source: "deterministic", narrative: null, toolCalls: [] });
    expect(reconciliation.facts.length).toBeGreaterThanOrEqual(4);
    expect(reconciliation.facts.every((fact) => fact.match)).toBe(true);
    // Only the owner's reconciliation is written to the trail; a visitor's is answered and forgotten.
    expect(auditTypes(await readDeal(client, deal.id)).slice(-1)).toEqual(["payment.reconciled"]);
    const trailLength = (await readDeal(client, deal.id)).audit.length;
    expect((await jsonOf<ReconciliationView>(await visitor.post(`/api/deals/${deal.id}/reconcile`))).status).toBe("match");
    expect((await readDeal(client, deal.id)).audit).toHaveLength(trailLength);

    const artifact = deal.submissions[0].artifacts[0];
    const file = await client.get(`/api/deals/${deal.id}/artifacts/${artifact.id}`);
    expect(file.status()).toBe(200);
    expect(file.headers()).toMatchObject({
      "content-type": "image/svg+xml",
      "content-security-policy": ARTIFACT_CSP,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    expect(file.headers()["content-disposition"]).toMatch(new RegExp(`^attachment; filename="${deal.code}-illustration-1-\\d+x\\d+\\.svg"$`));
    expect(await file.text()).toMatch(/^<svg[\s>]/);
    expect((await errorOf(await client.get(`/api/deals/${deal.id}/artifacts/art_000000000000`), 404)).code).toBe("not_found");
    expect((await errorOf(await client.get("/api/deals/deal_000000000000"), 404)).code).toBe("not_found");

    await anonymous.dispose();
  });
});

test.describe("what the transport refuses", () => {
  test("cross-site, oversize and non-JSON requests never reach the engine", async ({ request, baseURL }) => {
    const origin = baseURL ?? "";
    const client = clientOf(request, origin);
    const body = JSON.stringify({ intent: "", scenarioId: "happy-path" });
    const json = { "content-type": "application/json" };

    // Another site's page (Origin), and a browser that says so itself (Fetch Metadata).
    expect((await errorOf(await client.rawPost("/api/deals", body, { ...json, origin: "https://evil.example" }), 403)).code).toBe("forbidden");
    expect((await errorOf(await client.rawPost("/api/deals", body, { ...json, origin, "sec-fetch-site": "cross-site" }), 403)).code).toBe("forbidden");
    expect((await errorOf(await client.rawPost("/api/deals", body, { ...json, "sec-fetch-site": "same-site" }), 403)).code).toBe("forbidden");
    // A plain HTML form cannot send JSON, so a form-encoded body is refused even from this origin.
    const form = await errorOf(await client.rawPost("/api/deals", "intent=three+illustrations+please", { origin, "content-type": "application/x-www-form-urlencoded" }), 400);
    expect(form).toMatchObject({ code: "invalid_request", message: "Content-Type must be application/json" });
    const oversize = await errorOf(await client.rawPost("/api/deals", JSON.stringify({ intent: "x".repeat(20_000) }), { ...json, origin }), 400);
    expect(oversize).toMatchObject({ code: "invalid_request", message: "Request body is too large" });
    expect((await errorOf(await client.rawPost("/api/deals", "{not json", { ...json, origin }), 400)).message).toBe("Request body is not valid JSON");
    expect((await errorOf(await client.post("/api/deals", { intent: "too short" }), 400)).code).toBe("invalid_request");
    expect((await errorOf(await client.post("/api/deals", { intent: "", scenarioId: "no-such-scenario" }), 400)).code).toBe("invalid_request");

    // None of the refused requests created a session, let alone a deal.
    expect(await jsonOf<DealListResponse>(await client.get("/api/deals"))).toEqual({ deals: [] });
  });

  test("only the session that created a deal can advance it or decide on it", async ({ request, baseURL, playwright }) => {
    const owner = clientOf(request, baseURL ?? "");
    const otherContext = await playwright.request.newContext({ baseURL });
    const stranger = clientOf(otherContext, baseURL ?? "");

    const gate = await drive(owner, await createDeal(owner, "approval"), { stop: (deal) => deal.next.kind !== "auto" });
    expect(gate.deal.status).toBe("awaiting_approval");
    const advancePath = `/api/deals/${gate.deal.id}/advance`;
    const decisionPath = `/api/deals/${gate.deal.id}/decision`;

    // Without a session: refused, and no session is created by trying.
    const noSession = await stranger.post(advancePath);
    expect((await errorOf(noSession, 403)).code).toBe("forbidden");
    expect(noSession.headers()["set-cookie"]).toBeUndefined();
    // With a session of its own (it owns another deal): still refused.
    await createDeal(stranger, "happy-path");
    expect((await errorOf(await stranger.post(advancePath), 403)).code).toBe("forbidden");
    expect((await errorOf(await stranger.post(decisionPath, { kind: "approve_spend" }), 403)).code).toBe("forbidden");
    expect((await errorOf(await stranger.post(decisionPath, { kind: "decline_spend" }), 403)).code).toBe("forbidden");
    // Knowing the owner's session id is not enough: without the server's signature the cookie is no session at all.
    const ownerCookie = (await request.storageState()).cookies.find((cookie) => cookie.name === "pact_sid");
    expect(ownerCookie).toMatchObject({ httpOnly: true, sameSite: "Lax", secure: true, path: "/" });
    const ownerSessionId = (ownerCookie?.value ?? "").split(".")[0];
    expect(ownerSessionId).toMatch(/^sess_[a-z0-9]{24}$/);
    for (const forgedValue of [ownerSessionId, `${ownerSessionId}.`, `${ownerSessionId}.${"A".repeat(43)}`]) {
      const forger = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { cookie: `pact_sid=${forgedValue}` } });
      expect(await jsonOf<DealListResponse>(await forger.get("/api/deals"))).toEqual({ deals: [] });
      expect((await forger.post(advancePath, { headers: { origin: baseURL ?? "" }, data: {} })).status()).toBe(403);
      await forger.dispose();
    }

    // A stranger may read the deal, but not the buyer's private mandate.
    const seen = await readDeal(stranger, gate.deal.id);
    expect(seen).toMatchObject({ id: gate.deal.id, isOwner: false, mandate: null, status: "awaiting_approval" });
    const untouched = await readDeal(owner, gate.deal.id);
    expect(untouched.mandate).not.toBeNull();
    expect(untouched.audit).toHaveLength(gate.deal.audit.length);

    // The owner's decision counts only at the gate that is open, and carries no amount or status.
    expect((await errorOf(await owner.post(decisionPath, { kind: "release_payment" }), 409)).code).toBe("conflict");
    expect((await errorOf(await owner.post(decisionPath, { kind: "make_it_free" }), 400)).code).toBe("invalid_request");
    const approved = await decide(owner, gate.deal, "approve_spend", { amountMinor: 1, priceMinor: 1, status: "completed", percent: 1 });
    expect(approved).toMatchObject({ status: "payment_pending", humanDecision: { kind: "approve_spend", percent: null } });
    expect(approved.contract?.contract.price.amountMinor).toBe(18000);

    // The simulated approval belongs to the payer: a stranger cannot approve or cancel the owner's order.
    const waiting = await drive(owner, approved, { stop: (deal) => deal.status === "awaiting_payment" });
    const orderId = waiting.deal.payment?.orderId ?? "";
    expect((await errorOf(await stranger.post("/api/simulated/approve", { orderId }), 403)).code).toBe("forbidden");
    expect((await errorOf(await stranger.post("/api/simulated/cancel", { orderId }), 403)).code).toBe("forbidden");
    expect((await errorOf(await owner.post("/api/simulated/approve", { orderId: "SIM-O-0000000000000000" }), 404)).code).toBe("not_found");
    expect((await readDeal(owner, gate.deal.id)).status).toBe("awaiting_payment");

    // The owner backs out instead: the order is voided and the deal cancelled, nothing was ever held.
    expect(await jsonOf<{ dealId: string; outcome: string }>(await owner.post("/api/simulated/cancel", { orderId }))).toEqual({ dealId: gate.deal.id, outcome: "cancelled" });
    expect(await readDeal(owner, gate.deal.id)).toMatchObject({ status: "cancelled", payment: { status: "voided", authorizedMinor: 0, capturedMinor: 0 } });

    await otherContext.dispose();
  });

  test("PayPal-facing endpoints trust nothing in the request", async ({ request, baseURL }) => {
    const client = clientOf(request, baseURL ?? "");
    const waiting = await drive(client, await createDeal(client, "happy-path"), { stop: (deal) => deal.status === "awaiting_payment" });
    const { id } = waiting.deal;
    const orderId = waiting.deal.payment?.orderId ?? "";

    // A return before the payer approved, or naming another order, authorizes nothing.
    const premature = await client.get(`/api/paypal/return?deal=${id}&token=${orderId}`);
    expect([premature.status(), premature.headers().location]).toEqual([303, `/deals/${id}?paypal=pending`]);
    const wrongOrder = await client.get(`/api/paypal/return?deal=${id}&token=SIM-O-FFFFFFFFFFFFFFFF`);
    expect([wrongOrder.status(), wrongOrder.headers().location]).toEqual([303, `/deals/${id}?paypal=error`]);
    expect(await readDeal(client, id)).toMatchObject({ status: "awaiting_payment", payment: { status: "created", authorizedMinor: 0 } });
    // The redirect target is never taken from the request.
    for (const hostile of ["https://evil.example", "//evil.example", "deal_x/../../admin"]) {
      const response = await client.get(`/api/paypal/return?deal=${encodeURIComponent(hostile)}&token=${orderId}`);
      expect([response.status(), response.headers().location]).toEqual([303, "/workspace?paypal=error"]);
    }
    const cancelled = await client.get(`/api/paypal/cancel?deal=${id}`);
    expect([cancelled.status(), cancelled.headers().location]).toEqual([303, `/deals/${id}?paypal=cancelled`]);
    expect((await readDeal(client, id)).status).toBe("awaiting_payment");

    // An unsigned "capture completed" changes nothing and learns nothing.
    const forgedEvent = JSON.stringify({ id: "WH-FORGED-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAPTURE-1", supplementary_data: { related_ids: { order_id: orderId } } } });
    const webhook = await client.rawPost("/api/webhooks/paypal", forgedEvent, { "content-type": "application/json", origin: "https://www.paypal.com" });
    expect(webhook.status()).toBe(400);
    expect(await webhook.text()).toBe("");
    expect(await readDeal(client, id)).toMatchObject({ status: "awaiting_payment", payment: { status: "created", capturedMinor: 0, webhookConfirmed: { captured: false } } });

    // After the payer approves, the same return authorizes — and repeating it is harmless.
    await approveSimulatedOrder(client, waiting.deal);
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const response = await client.get(`/api/paypal/return?deal=${id}&token=${orderId}`);
      expect([response.status(), response.headers().location]).toEqual([303, `/deals/${id}?paypal=approved`]);
    }
    const authorized = await readDeal(client, id);
    expect(authorized).toMatchObject({ status: "authorized", payment: { status: "authorized", authorizedMinor: 4700, capturedMinor: 0 } });
    expect(auditTypes(authorized).filter((type) => type === "payment.authorized")).toHaveLength(1);

    // The shared demo wallet is the operator's: no token, no connection — and the wallet return invents nothing.
    expect((await errorOf(await client.post("/api/wallet/connect", { scope: "demo" }), 403)).code).toBe("forbidden");
    const vaultReturn = await client.get("/api/paypal/vault-return?scope=session");
    expect([vaultReturn.status(), vaultReturn.headers().location]).toEqual([303, "/policies?wallet=error"]);
  });
});

test.describe("the simulated approval page", () => {
  test("says it is simulated and lets the payer's own browser approve the hold", async ({ page, baseURL }) => {
    // The page's API client shares the browser's cookie jar, so this is the browser's own session.
    const client = clientOf(page.request, baseURL ?? "");
    const waiting = await drive(client, await createDeal(client, "happy-path"), { stop: (deal) => deal.status === "awaiting_payment" });
    const approveUrl = waiting.deal.payment?.approveUrl ?? "";

    await page.goto(approveUrl);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Simulated PayPal approval");
    await expect(page.getByText("No money, real or sandbox, is involved.")).toBeVisible();
    await expect(page.getByText("$47.00", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Approve simulated hold" }).click();
    // Where the real PayPal return would land the payer.
    await page.waitForURL((url) => url.pathname === `/deals/${waiting.deal.id}` && url.searchParams.get("paypal") === "approved");
    expect(await readDeal(client, waiting.deal.id)).toMatchObject({ status: "authorized", payment: { status: "authorized", authorizedMinor: 4700, capturedMinor: 0 } });

    // The order is settled: the page no longer offers anything to click.
    await page.goto(approveUrl);
    await expect(page.getByText("already been approved or cancelled")).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve simulated hold" })).toHaveCount(0);
  });

  test("does not exist for an order the simulator never issued", async ({ page }) => {
    const response = await page.goto("/pay/simulated/SIM-O-0000000000000000");
    expect(response?.status()).toBe(404);
  });
});
