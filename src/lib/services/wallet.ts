/**
 * The delegated agent wallet.
 *
 * A human connects a PayPal account once (PayPal Vault v3: setup token → payer consent →
 * payment token). From then on the buyer agent can authorize IN-POLICY deals without a PayPal
 * login. The vault token carries no spending cap of its own; the cap is the policy engine,
 * which runs before any PayPal call.
 *
 * Two wallets exist: one per browser session, and the shared "demo" wallet an operator connects
 * so that visitors of the public demo can watch a delegated authorization.
 *
 * The vault id is a credential. It is written to the wallets table and handed to the payment
 * orchestrator by the step engine; nothing in this file returns it, logs it or audits it.
 */
import "server-only";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { WalletStatus } from "../api/dto";
import { getAdminToken } from "../config";
import { deleteWallet, getWallet, upsertWallet, type WalletRow } from "../db";
import { assertNever } from "../domain/format";
import { log } from "../observability/logger";
import { PaymentError, idempotencyKey, type ProviderKind, type VaultSetupInfo, type VaultTokenInfo } from "../payments";
import type { ServiceContext } from "./context";
import { DEMO_WALLET_OWNER } from "./deals";
import { ApiError, conflict, forbidden } from "./errors";

export const WALLET_SCOPES = ["session", "demo"] as const;
export type WalletScope = (typeof WALLET_SCOPES)[number];

/** Request header that carries the operator token for the shared demo wallet. */
export const ADMIN_TOKEN_HEADER = "x-admin-token";

/** Each attempt asks PayPal for a setup token. Counted per session. */
export const WALLET_CONNECT_LIMIT = { scope: "wallet-connect", limit: 10, windowSeconds: 600 } as const;
/** Attempts to act on the shared wallet, right token or wrong. Counted per network address. */
export const OPERATOR_ATTEMPT_LIMIT = { scope: "wallet-operator", limit: 20, windowSeconds: 600 } as const;

const ACTIVE = "active";
const PENDING = "pending";
/**
 * A pending connection to the shared wallet remembers which session started it
 * ("pending:<session id>"). PayPal sends the payer back with a plain redirect, which cannot
 * carry the operator token, so the return is tied to the operator's session instead.
 */
const PENDING_BINDING_SEPARATOR = ":";

const CONNECT_FAILED_MESSAGE =
  "PayPal could not start the wallet connection. If this is a new sandbox app, enable Vault under App Feature Options.";

export type WalletConnectFailure = "no_pending_connection" | "session_mismatch";

export interface WalletConnectResult {
  connected: boolean;
  /** Null when connected; otherwise why not: one of WalletConnectFailure, or the provider's issue code. */
  reason: string | null;
}

/* -------------------------------------------------------------------------- */
/*  Reading wallet rows                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A wallet an order can be charged against: consent completed, token stored, and issued by the
 * provider that is live now. The last condition matters after a configuration change: a token
 * minted by the simulator means nothing to PayPal, and the reverse.
 */
export function isActiveWallet(wallet: WalletRow | null, provider: ProviderKind): boolean {
  return wallet !== null && wallet.status === ACTIVE && wallet.vaultId !== null && wallet.provider === provider;
}

function isPendingStatus(status: string): boolean {
  return status === PENDING || status.startsWith(`${PENDING}${PENDING_BINDING_SEPARATOR}`);
}

function isPendingWallet(wallet: WalletRow | null, provider: ProviderKind): boolean {
  return wallet !== null && isPendingStatus(wallet.status) && wallet.setupTokenId !== null && wallet.provider === provider;
}

function pendingStatus(boundSessionId: string | null): string {
  return boundSessionId === null ? PENDING : `${PENDING}${PENDING_BINDING_SEPARATOR}${boundSessionId}`;
}

/** The session a pending connection is tied to, or null when it is tied to none. */
function boundSessionOf(status: string): string | null {
  const prefix = `${PENDING}${PENDING_BINDING_SEPARATOR}`;
  return status.startsWith(prefix) ? status.slice(prefix.length) : null;
}

function scopeOf(owner: string): WalletScope {
  return owner === DEMO_WALLET_OWNER ? "demo" : "session";
}

/* -------------------------------------------------------------------------- */
/*  Who may touch which wallet                                                 */
/* -------------------------------------------------------------------------- */

/**
 * True when `presented` is the configured operator token. Compared as SHA-256 digests in
 * constant time, so neither the token's content nor its length can be probed by timing.
 * Always false when no operator token is configured: the privileged paths are then closed.
 */
export function isOperatorToken(presented: string | null): boolean {
  const expected = getAdminToken();
  if (expected === undefined || presented === null || presented.length === 0) return false;
  const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(expected), digest(presented));
}

/**
 * The wallet a request may act on: the session's own wallet (null when the caller has no
 * session, hence no wallet), or — only with the operator token — the shared demo wallet.
 * Throws 403 for the shared wallet without a valid token.
 */
export function resolveWalletOwner(input: {
  scope: WalletScope;
  sessionId: string | null;
  adminToken: string | null;
}): string | null {
  switch (input.scope) {
    case "session":
      return input.sessionId;
    case "demo":
      if (!isOperatorToken(input.adminToken)) {
        throw forbidden("The shared demo wallet can only be changed by the operator");
      }
      return DEMO_WALLET_OWNER;
    default:
      return assertNever(input.scope);
  }
}

/**
 * The wallet whose pending connection a returning payer's browser may try to complete. A
 * redirect from PayPal cannot carry the operator token, so for the shared wallet this only
 * requires a session; completeWalletConnect then insists it is the session that started.
 */
export function resolveReturningOwner(scope: WalletScope, sessionId: string | null): string | null {
  switch (scope) {
    case "session":
      return sessionId;
    case "demo":
      return sessionId === null ? null : DEMO_WALLET_OWNER;
    default:
      return assertNever(scope);
  }
}

/* -------------------------------------------------------------------------- */
/*  Status                                                                     */
/* -------------------------------------------------------------------------- */

/** What the browser may know about the wallets: connected or not, and a masked payer e-mail. */
export async function getWalletStatus(ctx: ServiceContext, sessionId: string | null): Promise<WalletStatus> {
  const provider = ctx.provider.kind;
  const own = sessionId === null ? null : await getWallet(ctx.db, sessionId);
  const demo = await getWallet(ctx.db, DEMO_WALLET_OWNER);
  const ownConnected = isActiveWallet(own, provider);
  const demoConnected = isActiveWallet(demo, provider);
  return {
    provider,
    supportsVault: ctx.provider.supportsVault,
    session: {
      connected: ownConnected,
      pending: !ownConnected && isPendingWallet(own, provider),
      payerEmailMasked: ownConnected ? (own?.payerEmailMasked ?? null) : null,
    },
    demo: { connected: demoConnected },
    // The step engine prefers the session's wallet and falls back to the shared one.
    effectiveMode: ctx.provider.supportsVault && (ownConnected || demoConnected) ? "delegated" : "interactive",
  };
}

/* -------------------------------------------------------------------------- */
/*  Connect                                                                    */
/* -------------------------------------------------------------------------- */

function connectFailed(error: PaymentError): ApiError {
  return new ApiError(502, "payment_error", CONNECT_FAILED_MESSAGE, {
    issue: error.issue,
    debugId: error.debugId,
    retryable: error.retryable,
  });
}

/** The provider's approval link as an absolute http(s) URL (the simulator may answer with a path). */
function absoluteApproveUrl(approveUrl: string, appUrl: string): string | null {
  try {
    const url = new URL(approveUrl, appUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Start connecting a wallet: ask the provider for a vault setup token and remember it,
 * server-side, as a pending connection. Returns where the payer gives consent.
 *
 * `initiatedBy` is required for the shared demo wallet: the session that starts the connection
 * is the only one allowed to complete it (see completeWalletConnect).
 *
 * A wallet that is already connected is never replaced implicitly — it must be disconnected
 * first — so an abandoned or failed attempt cannot take a working wallet away. Nothing is
 * written unless the provider issued a setup token.
 */
export async function startWalletConnect(
  ctx: ServiceContext,
  input: { owner: string; appUrl: string; initiatedBy?: string | null },
): Promise<{ approveUrl: string }> {
  const { owner, appUrl } = input;
  const scope = scopeOf(owner);
  const initiatedBy = input.initiatedBy ?? null;
  if (scope === "demo" && initiatedBy === null) {
    throw forbidden("The shared demo wallet can only be connected from an operator session");
  }
  if (!ctx.provider.supportsVault) throw conflict("The active payment provider cannot hold a delegated wallet");
  if (isActiveWallet(await getWallet(ctx.db, owner), ctx.provider.kind)) {
    throw conflict("A wallet is already connected. Disconnect it before connecting another one.");
  }

  let setup: VaultSetupInfo;
  try {
    setup = await ctx.provider.createVaultSetup({
      // Only the scope travels in the URL; the setup token is looked up server-side on return.
      returnUrl: `${appUrl}/api/paypal/vault-return?scope=${scope}`,
      cancelUrl: `${appUrl}/policies?wallet=cancelled`,
      // A fresh nonce per attempt: retrying after an abandoned consent must mint a NEW setup
      // token, not replay the stale one. It is deliberately stored nowhere.
      idempotencyKey: idempotencyKey("vault_setup", owner, randomUUID()),
    });
  } catch (error) {
    if (!(error instanceof PaymentError)) throw error;
    log.warn("wallet.setup_failed", { scope, issue: error.issue, paypalDebugId: error.debugId, httpStatus: error.httpStatus });
    throw connectFailed(error);
  }
  const approveUrl = absoluteApproveUrl(setup.approveUrl, appUrl);
  if (approveUrl === null) {
    log.error("wallet.setup_unusable_link", { scope });
    throw new ApiError(502, "payment_error", CONNECT_FAILED_MESSAGE, { issue: "UNEXPECTED_RESPONSE", debugId: null, retryable: false });
  }

  await upsertWallet(ctx.db, {
    owner,
    provider: ctx.provider.kind,
    status: pendingStatus(scope === "demo" ? initiatedBy : null),
    setupTokenId: setup.setupTokenId,
    vaultId: null,
    payerEmailMasked: null,
  });
  log.info("wallet.connect_started", { scope, provider: ctx.provider.kind });
  return { approveUrl };
}

/**
 * Finish a connection after the payer returned from the provider.
 *
 * The setup token is read from the pending row and never from the request: a crafted return
 * URL cannot make PACT exchange a token of the caller's choosing. For the shared demo wallet
 * `sessionId` must be the session that started the connection.
 *
 * Never leaves a half-connected wallet: the row becomes "active" only together with the vault
 * id, in one write, after the provider issued it. A refused exchange removes the pending row
 * (the setup token is spent); a transient failure keeps it so the same return can be retried.
 */
export async function completeWalletConnect(
  ctx: ServiceContext,
  input: { owner: string; sessionId?: string | null },
): Promise<WalletConnectResult> {
  const { owner } = input;
  const scope = scopeOf(owner);
  const wallet = await getWallet(ctx.db, owner);
  // Reloading the return URL after a successful exchange is not an error.
  if (isActiveWallet(wallet, ctx.provider.kind)) return { connected: true, reason: null };
  if (wallet === null || wallet.setupTokenId === null || !isPendingWallet(wallet, ctx.provider.kind)) {
    return { connected: false, reason: "no_pending_connection" };
  }
  if (scope === "demo") {
    const bound = boundSessionOf(wallet.status);
    if (bound === null || bound !== (input.sessionId ?? null)) {
      log.warn("wallet.return_from_other_session", { scope });
      return { connected: false, reason: "session_mismatch" };
    }
  }

  const { setupTokenId } = wallet;
  let token: VaultTokenInfo;
  try {
    token = await ctx.provider.exchangeVaultSetup(setupTokenId, idempotencyKey("vault_exchange", setupTokenId));
  } catch (error) {
    if (!(error instanceof PaymentError)) throw error;
    log.warn("wallet.exchange_failed", {
      scope,
      issue: error.issue,
      paypalDebugId: error.debugId,
      httpStatus: error.httpStatus,
      retryable: error.retryable,
    });
    if (!error.retryable) await deleteWallet(ctx.db, owner);
    return { connected: false, reason: error.issue };
  }

  await upsertWallet(ctx.db, {
    owner,
    provider: ctx.provider.kind,
    status: ACTIVE,
    setupTokenId: null,
    vaultId: token.vaultId,
    payerEmailMasked: token.payerEmailMasked,
  });
  log.info("wallet.connected", { scope, provider: ctx.provider.kind });
  return { connected: true, reason: null };
}

/**
 * Forget a wallet (connected or pending). Deals already authorized keep their authorization;
 * new deals fall back to the shared wallet or to interactive approval.
 */
export async function disconnectWallet(ctx: ServiceContext, owner: string): Promise<void> {
  await deleteWallet(ctx.db, owner);
  log.info("wallet.disconnected", { scope: scopeOf(owner) });
}
