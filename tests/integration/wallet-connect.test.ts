/**
 * The delegated agent wallet, end to end against the simulator's vault: connecting, who may
 * connect the shared demo wallet and who may complete it, what a failure leaves behind, and
 * that the vault id never appears in anything the browser can read.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgents } from "@/lib/ai";
import type { DealView } from "@/lib/api/dto";
import { closeDb, createDbSimulatedStore, createTestDb, getWallet, upsertWallet, type Db } from "@/lib/db";
import { PaymentError, SimulatedProvider, type PaymentProvider, type ProviderKind } from "@/lib/payments";
import type { ServiceContext } from "@/lib/services/context";
import { DEMO_WALLET_OWNER, advanceDeal, createDeal } from "@/lib/services/deals";
import { ApiError } from "@/lib/services/errors";
import {
  completeWalletConnect,
  disconnectWallet,
  getWalletStatus,
  isActiveWallet,
  isOperatorToken,
  resolveReturningOwner,
  resolveWalletOwner,
  startWalletConnect,
} from "@/lib/services/wallet";

const NOW = new Date("2026-10-06T05:00:00.000Z");
const APP_URL = "https://pact.test";
const ADMIN_TOKEN = "operator-token-3f9a6c1e8b2d4f70";

let db: Db;
let simulator: SimulatedProvider;
let ctx: ServiceContext;
let sessions = 0;

/** A fresh session id per test, so no test sees another's wallet. */
function newSession(): string {
  sessions += 1;
  return `sess_wallet${String(sessions).padStart(18, "0")}`;
}

beforeAll(async () => {
  db = await createTestDb();
  simulator = new SimulatedProvider(createDbSimulatedStore(db), { now: () => NOW });
  ctx = { db, agents: createAgents({ mode: "scripted" }), provider: simulator, now: () => NOW };
});

afterAll(async () => {
  await closeDb(db);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await disconnectWallet(ctx, DEMO_WALLET_OWNER);
});

/** The simulator behind a provider of the given kind, optionally with some calls replaced. */
function providerOver(
  inner: SimulatedProvider,
  kind: ProviderKind,
  overrides: Partial<Omit<PaymentProvider, "kind">> = {},
): PaymentProvider {
  return {
    kind,
    supportsVault: true,
    createOrder: (input) => inner.createOrder(input),
    getOrder: (orderId) => inner.getOrder(orderId),
    authorizeOrder: (orderId, key) => inner.authorizeOrder(orderId, key),
    getAuthorization: (authorizationId) => inner.getAuthorization(authorizationId),
    captureAuthorization: (input) => inner.captureAuthorization(input),
    voidAuthorization: (authorizationId, key) => inner.voidAuthorization(authorizationId, key),
    reauthorize: (authorizationId, amountMinor, key) => inner.reauthorize(authorizationId, amountMinor, key),
    createVaultSetup: (input) => inner.createVaultSetup(input),
    exchangeVaultSetup: (setupTokenId, key) => inner.exchangeVaultSetup(setupTokenId, key),
    verifyWebhook: (headers, rawBody) => inner.verifyWebhook(headers, rawBody),
    ...overrides,
  };
}

async function apiError(run: Promise<unknown> | (() => unknown)): Promise<ApiError> {
  const error = await (typeof run === "function" ? Promise.resolve().then(run) : run).then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof ApiError)) throw new Error("expected an ApiError");
  return error;
}

async function connect(context: ServiceContext, owner: string, initiatedBy?: string): Promise<void> {
  await startWalletConnect(context, { owner, appUrl: APP_URL, initiatedBy });
  expect(await completeWalletConnect(context, { owner, sessionId: initiatedBy ?? owner })).toEqual({ connected: true, reason: null });
}

describe("session wallet", () => {
  it("connects end to end through the simulator and is labelled simulated", async () => {
    const session = newSession();
    expect(await getWalletStatus(ctx, session)).toEqual({
      provider: "simulated",
      supportsVault: true,
      session: { connected: false, pending: false, payerEmailMasked: null },
      demo: { connected: false },
      effectiveMode: "interactive",
    });

    const { approveUrl } = await startWalletConnect(ctx, { owner: session, appUrl: APP_URL });
    // The simulator has no consent screen: its approval link is PACT's own return route.
    const url = new URL(approveUrl);
    expect(url.origin + url.pathname).toBe(`${APP_URL}/api/paypal/vault-return`);
    expect(url.searchParams.get("scope")).toBe("session");

    const pending = await getWallet(db, session);
    expect(pending).toMatchObject({ provider: "simulated", status: "pending", vaultId: null, payerEmailMasked: null });
    expect(pending?.setupTokenId).toMatch(/^SIM-S-/);
    expect(await getWalletStatus(ctx, session)).toMatchObject({
      session: { connected: false, pending: true, payerEmailMasked: null },
      effectiveMode: "interactive",
    });

    expect(await completeWalletConnect(ctx, { owner: session })).toEqual({ connected: true, reason: null });
    const active = await getWallet(db, session);
    expect(active).toMatchObject({ provider: "simulated", status: "active", setupTokenId: null });
    expect(active?.vaultId).toMatch(/^SIM-V-/);
    expect(isActiveWallet(active, "simulated")).toBe(true);

    const status = await getWalletStatus(ctx, session);
    expect(status).toEqual({
      provider: "simulated",
      supportsVault: true,
      session: { connected: true, pending: false, payerEmailMasked: "si****@personal.example.com" },
      demo: { connected: false },
      effectiveMode: "delegated",
    });
    // The status the browser is given names neither the vault id nor the setup token.
    expect(JSON.stringify(status)).not.toContain(active?.vaultId ?? "missing");
    expect(JSON.stringify(status)).not.toContain(pending?.setupTokenId ?? "missing");
    expect(approveUrl).not.toContain(active?.vaultId ?? "missing");
  });

  it("completing twice is harmless, and there is nothing to complete without a pending connection", async () => {
    const session = newSession();
    expect(await completeWalletConnect(ctx, { owner: session })).toEqual({ connected: false, reason: "no_pending_connection" });
    expect(await getWallet(db, session)).toBeNull();

    await connect(ctx, session);
    const first = await getWallet(db, session);
    expect(await completeWalletConnect(ctx, { owner: session })).toEqual({ connected: true, reason: null });
    expect((await getWallet(db, session))?.vaultId).toBe(first?.vaultId);
  });

  it("exchanges the stored setup token, never one supplied from outside", async () => {
    const attacker = newSession();
    const victim = newSession();
    await startWalletConnect(ctx, { owner: victim, appUrl: APP_URL });
    // The attacker knows the victim's return URL (token included) but has no pending connection of their own.
    expect(await completeWalletConnect(ctx, { owner: attacker })).toEqual({ connected: false, reason: "no_pending_connection" });
    expect(await getWallet(db, attacker)).toBeNull();
    expect(await getWallet(db, victim)).toMatchObject({ status: "pending", vaultId: null });
  });

  it("a new attempt replaces an abandoned one with a fresh setup token", async () => {
    const session = newSession();
    await startWalletConnect(ctx, { owner: session, appUrl: APP_URL });
    const first = (await getWallet(db, session))?.setupTokenId;
    await startWalletConnect(ctx, { owner: session, appUrl: APP_URL });
    const second = (await getWallet(db, session))?.setupTokenId;
    expect(second).toMatch(/^SIM-S-/);
    expect(second).not.toBe(first);
    expect(await completeWalletConnect(ctx, { owner: session })).toEqual({ connected: true, reason: null });
  });

  it("does not replace a connected wallet until it is disconnected", async () => {
    const session = newSession();
    await connect(ctx, session);
    const vaultId = (await getWallet(db, session))?.vaultId;

    const error = await apiError(startWalletConnect(ctx, { owner: session, appUrl: APP_URL }));
    expect(error).toMatchObject({ status: 409, code: "conflict" });
    expect(await getWallet(db, session)).toMatchObject({ status: "active", vaultId });

    await disconnectWallet(ctx, session);
    expect(await getWallet(db, session)).toBeNull();
    expect(await getWalletStatus(ctx, session)).toMatchObject({ session: { connected: false, pending: false }, effectiveMode: "interactive" });
    await connect(ctx, session);
    // Disconnecting something that is not there is not an error.
    await disconnectWallet(ctx, newSession());
  });

  it("lets the buyer agent authorize an in-policy deal with no PayPal approval", async () => {
    const withWallet = newSession();
    const without = newSession();
    await connect(ctx, withWallet);

    async function untilPaymentStep(sessionId: string): Promise<DealView> {
      let deal = await createDeal(ctx, { sessionId, clientKey: null }, { intent: "", scenarioId: "happy-path", tzOffsetMinutes: -540 });
      for (let step = 0; step < 30 && deal.payment === null && deal.next.kind === "auto"; step += 1) {
        deal = (await advanceDeal(ctx, sessionId, deal.id, APP_URL)).deal;
      }
      return deal;
    }

    const delegated = await untilPaymentStep(withWallet);
    expect(delegated).toMatchObject({ status: "authorized", payment: { mode: "delegated", status: "authorized", approveUrl: null } });
    const interactive = await untilPaymentStep(without);
    expect(interactive).toMatchObject({ status: "awaiting_payment", payment: { mode: "interactive", status: "created" } });

    // The vault id is a credential: it is in neither the deal view nor its audit trail.
    const vaultId = (await getWallet(db, withWallet))?.vaultId ?? "missing";
    expect(JSON.stringify(delegated)).not.toContain(vaultId);
  });
});

describe("shared demo wallet", () => {
  it("only resolves for a caller who presents the operator token", async () => {
    const session = newSession();
    // No operator token configured: the privileged path is closed, whatever is presented.
    vi.stubEnv("ADMIN_TOKEN", "");
    expect(isOperatorToken("")).toBe(false);
    expect(isOperatorToken("anything")).toBe(false);
    expect(await apiError(() => resolveWalletOwner({ scope: "demo", sessionId: session, adminToken: "anything" }))).toMatchObject({
      status: 403,
      code: "forbidden",
    });

    vi.stubEnv("ADMIN_TOKEN", ADMIN_TOKEN);
    for (const wrong of [null, "", "operator-token", `${ADMIN_TOKEN}x`, ADMIN_TOKEN.toUpperCase()]) {
      expect(isOperatorToken(wrong)).toBe(false);
      expect(await apiError(() => resolveWalletOwner({ scope: "demo", sessionId: session, adminToken: wrong }))).toMatchObject({ status: 403 });
    }
    expect(isOperatorToken(ADMIN_TOKEN)).toBe(true);
    expect(resolveWalletOwner({ scope: "demo", sessionId: session, adminToken: ADMIN_TOKEN })).toBe(DEMO_WALLET_OWNER);
    expect(resolveWalletOwner({ scope: "demo", sessionId: null, adminToken: ADMIN_TOKEN })).toBe(DEMO_WALLET_OWNER);
  });

  it("resolves a session's own wallet without any token, and nothing for a caller without a session", () => {
    const session = newSession();
    expect(resolveWalletOwner({ scope: "session", sessionId: session, adminToken: null })).toBe(session);
    expect(resolveWalletOwner({ scope: "session", sessionId: null, adminToken: null })).toBeNull();
    expect(resolveReturningOwner("session", session)).toBe(session);
    expect(resolveReturningOwner("session", null)).toBeNull();
    expect(resolveReturningOwner("demo", session)).toBe(DEMO_WALLET_OWNER);
    expect(resolveReturningOwner("demo", null)).toBeNull();
  });

  it("can only be completed by the session that started the connection", async () => {
    const operator = newSession();
    const other = newSession();
    const { approveUrl } = await startWalletConnect(ctx, { owner: DEMO_WALLET_OWNER, appUrl: APP_URL, initiatedBy: operator });
    expect(new URL(approveUrl).searchParams.get("scope")).toBe("demo");
    expect(await getWallet(db, DEMO_WALLET_OWNER)).toMatchObject({ status: `pending:${operator}`, vaultId: null });

    // Anyone can open the return URL; only the operator's own browser completes it.
    expect(await completeWalletConnect(ctx, { owner: DEMO_WALLET_OWNER, sessionId: other })).toEqual({ connected: false, reason: "session_mismatch" });
    expect(await completeWalletConnect(ctx, { owner: DEMO_WALLET_OWNER, sessionId: null })).toEqual({ connected: false, reason: "session_mismatch" });
    expect(await completeWalletConnect(ctx, { owner: DEMO_WALLET_OWNER })).toEqual({ connected: false, reason: "session_mismatch" });
    expect(await getWallet(db, DEMO_WALLET_OWNER)).toMatchObject({ status: `pending:${operator}`, vaultId: null });
    expect((await getWalletStatus(ctx, other)).demo).toEqual({ connected: false });

    expect(await completeWalletConnect(ctx, { owner: DEMO_WALLET_OWNER, sessionId: operator })).toEqual({ connected: true, reason: null });
    expect(await getWallet(db, DEMO_WALLET_OWNER)).toMatchObject({ status: "active", setupTokenId: null });
  });

  it("cannot be started without a session to bind it to", async () => {
    expect(await apiError(startWalletConnect(ctx, { owner: DEMO_WALLET_OWNER, appUrl: APP_URL }))).toMatchObject({ status: 403 });
    expect(await apiError(startWalletConnect(ctx, { owner: DEMO_WALLET_OWNER, appUrl: APP_URL, initiatedBy: null }))).toMatchObject({ status: 403 });
    expect(await getWallet(db, DEMO_WALLET_OWNER)).toBeNull();
  });

  it("serves every session once connected, and says so without revealing who connected it", async () => {
    const operator = newSession();
    const visitor = newSession();
    await connect(ctx, DEMO_WALLET_OWNER, operator);

    const status = await getWalletStatus(ctx, visitor);
    expect(status).toEqual({
      provider: "simulated",
      supportsVault: true,
      session: { connected: false, pending: false, payerEmailMasked: null },
      demo: { connected: true },
      effectiveMode: "delegated",
    });
    expect(await getWalletStatus(ctx, null)).toMatchObject({ demo: { connected: true }, effectiveMode: "delegated" });
    const demo = await getWallet(db, DEMO_WALLET_OWNER);
    expect(JSON.stringify(status)).not.toContain(demo?.vaultId ?? "missing");
    expect(JSON.stringify(status)).not.toContain(operator);
  });
});

describe("failures", () => {
  it("reports a provider that will not start the connection as a clean payment error and writes nothing", async () => {
    const session = newSession();
    const vaultDisabled = providerOver(simulator, "paypal_sandbox", {
      createVaultSetup: () =>
        Promise.reject(new PaymentError({ issue: "NOT_AUTHORIZED", message: "Authorization failed due to insufficient permissions.", httpStatus: 403, debugId: "9b1c2d3e4f5a6" })),
    });
    const error = await apiError(startWalletConnect({ ...ctx, provider: vaultDisabled }, { owner: session, appUrl: APP_URL }));
    expect(error).toMatchObject({
      status: 502,
      code: "payment_error",
      message: "PayPal could not start the wallet connection. If this is a new sandbox app, enable Vault under App Feature Options.",
      details: { issue: "NOT_AUTHORIZED", debugId: "9b1c2d3e4f5a6", retryable: false },
    });
    expect(await getWallet(db, session)).toBeNull();
  });

  it("does not swallow an unexpected error while starting", async () => {
    const buggy = providerOver(simulator, "simulated", { createVaultSetup: () => Promise.reject(new TypeError("boom")) });
    await expect(startWalletConnect({ ...ctx, provider: buggy }, { owner: newSession(), appUrl: APP_URL })).rejects.toThrow(TypeError);
  });

  it("a refused exchange leaves no wallet behind", async () => {
    const session = newSession();
    const refusing = providerOver(simulator, "simulated", {
      exchangeVaultSetup: () =>
        Promise.reject(new PaymentError({ issue: "SETUP_TOKEN_NOT_APPROVED", message: "The payer has not approved.", httpStatus: 422, debugId: "c0ffee" })),
    });
    const context = { ...ctx, provider: refusing };
    await startWalletConnect(context, { owner: session, appUrl: APP_URL });
    expect(await completeWalletConnect(context, { owner: session })).toEqual({ connected: false, reason: "SETUP_TOKEN_NOT_APPROVED" });
    expect(await getWallet(db, session)).toBeNull();
    expect(await getWalletStatus(context, session)).toMatchObject({ session: { connected: false, pending: false }, effectiveMode: "interactive" });
  });

  it("a transient exchange failure keeps the connection pending, never active, and the retry completes it", async () => {
    const session = newSession();
    let outage = true;
    const flaky = providerOver(simulator, "simulated", {
      exchangeVaultSetup: (setupTokenId, key) =>
        outage
          ? Promise.reject(new PaymentError({ issue: "INTERNAL_SERVICE_ERROR", message: "try again", httpStatus: 503, retryable: true }))
          : simulator.exchangeVaultSetup(setupTokenId, key),
    });
    const context = { ...ctx, provider: flaky };
    await startWalletConnect(context, { owner: session, appUrl: APP_URL });

    expect(await completeWalletConnect(context, { owner: session })).toEqual({ connected: false, reason: "INTERNAL_SERVICE_ERROR" });
    expect(await getWallet(db, session)).toMatchObject({ status: "pending", vaultId: null });
    expect(isActiveWallet(await getWallet(db, session), "simulated")).toBe(false);

    outage = false;
    expect(await completeWalletConnect(context, { owner: session })).toEqual({ connected: true, reason: null });
    expect(await getWallet(db, session)).toMatchObject({ status: "active" });
  });

  it("refuses when the provider cannot vault at all", async () => {
    const noVault: PaymentProvider = { ...providerOver(simulator, "simulated"), supportsVault: false };
    const session = newSession();
    expect(await apiError(startWalletConnect({ ...ctx, provider: noVault }, { owner: session, appUrl: APP_URL }))).toMatchObject({ status: 409 });
    expect(await getWalletStatus({ ...ctx, provider: noVault }, session)).toMatchObject({ supportsVault: false, effectiveMode: "interactive" });
  });

  it("makes a relative approval link absolute and refuses one that is not a web address", async () => {
    const relative = providerOver(simulator, "simulated", {
      createVaultSetup: async () => ({ setupTokenId: "SIM-S-RELATIVE", approveUrl: "/pay/simulated/vault/SIM-S-RELATIVE" }),
    });
    const { approveUrl } = await startWalletConnect({ ...ctx, provider: relative }, { owner: newSession(), appUrl: APP_URL });
    expect(approveUrl).toBe(`${APP_URL}/pay/simulated/vault/SIM-S-RELATIVE`);

    const session = newSession();
    const hostile = providerOver(simulator, "simulated", {
      createVaultSetup: async () => ({ setupTokenId: "SIM-S-HOSTILE", approveUrl: "javascript:alert(1)" }),
    });
    expect(await apiError(startWalletConnect({ ...ctx, provider: hostile }, { owner: session, appUrl: APP_URL }))).toMatchObject({
      status: 502,
      code: "payment_error",
      details: { issue: "UNEXPECTED_RESPONSE" },
    });
    expect(await getWallet(db, session)).toBeNull();
  });
});

describe("a wallet issued by another provider", () => {
  it("is not connected, cannot be completed, and may be replaced", async () => {
    const session = newSession();
    // Connected while the simulator was active; PayPal Sandbox credentials were configured afterwards.
    await connect(ctx, session);
    const paypal: ServiceContext = { ...ctx, provider: providerOver(simulator, "paypal_sandbox") };

    expect(isActiveWallet(await getWallet(db, session), "paypal_sandbox")).toBe(false);
    expect(await getWalletStatus(paypal, session)).toMatchObject({
      provider: "paypal_sandbox",
      session: { connected: false, pending: false, payerEmailMasked: null },
      effectiveMode: "interactive",
    });
    expect(await completeWalletConnect(paypal, { owner: session })).toEqual({ connected: false, reason: "no_pending_connection" });

    await connect(paypal, session);
    expect(await getWallet(db, session)).toMatchObject({ provider: "paypal_sandbox", status: "active" });
    expect((await getWalletStatus(paypal, session)).session.connected).toBe(true);
  });

  it("treats a row that is active without a vault id as not connected", async () => {
    const session = newSession();
    await upsertWallet(db, { owner: session, provider: "simulated", status: "active", setupTokenId: null, vaultId: null, payerEmailMasked: null });
    expect(isActiveWallet(await getWallet(db, session), "simulated")).toBe(false);
    expect(await getWalletStatus(ctx, session)).toMatchObject({ session: { connected: false, pending: false }, effectiveMode: "interactive" });
  });
});
