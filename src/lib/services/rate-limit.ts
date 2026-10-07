/**
 * Abuse protection for the public demo: fixed-window counters in the database, so the limits
 * hold across serverless instances.
 */
import "server-only";
import { createHash } from "node:crypto";
import { deleteStaleRateLimits, hitRateLimit } from "../db";
import { log } from "../observability/logger";
import type { ServiceContext } from "./context";
import { rateLimited } from "./errors";

export interface RateLimitRule {
  /** What is being limited. Part of the key, so two rules never share a counter. */
  scope: string;
  limit: number;
  windowSeconds: number;
}

const TEN_MINUTES = 600;
const ONE_HOUR = 3600;

/** Every limit the deal-facing API enforces, in one place. */
export const RATE_LIMITS = {
  /** Creating a deal costs a model call, so it is the tightest limit. */
  createDealPerSession: { scope: "deal-create", limit: 8, windowSeconds: TEN_MINUTES },
  /** Clearing cookies gives a new session but not a new network address. */
  createDealPerClient: { scope: "deal-create-client", limit: 40, windowSeconds: ONE_HOUR },
  /** A deal takes about fifteen steps; this leaves room for several deals and their retries. */
  advancePerSession: { scope: "deal-advance", limit: 300, windowSeconds: TEN_MINUTES },
  decisionPerSession: { scope: "deal-decision", limit: 60, windowSeconds: TEN_MINUTES },
  /** The return from PayPal needs no session, and every attempt costs a PayPal read: throttled per deal. */
  approvalReturnPerDeal: { scope: "paypal-return", limit: 30, windowSeconds: TEN_MINUTES },
  policyUpdatePerSession: { scope: "policy-update", limit: 30, windowSeconds: TEN_MINUTES },
  /**
   * A session is free: a client that never returns the cookie gets a new one, and with it a new
   * per-session budget, on every request. Each route that may start a session therefore also
   * counts per network address, which a new cookie does not change.
   */
  policyUpdatePerClient: { scope: "policy-update-client", limit: 120, windowSeconds: ONE_HOUR },
  /** Every attempt asks PayPal for a vault setup token and writes a pending wallet row. */
  walletConnectPerClient: { scope: "wallet-connect-client", limit: 30, windowSeconds: ONE_HOUR },
  /** Three sessions' worth of reconciliations: each one costs PayPal reads. */
  reconcilePerClient: { scope: "reconcile-client", limit: 36, windowSeconds: TEN_MINUTES },
  /**
   * The auditor agent's statement is a model call anyone who can see a deal can ask for. One
   * budget for the whole deployment bounds that spend; beyond it a reconciliation still answers,
   * with the deterministic comparison alone.
   */
  narratedReconcileGlobal: { scope: "reconcile-narration", limit: 120, windowSeconds: ONE_HOUR },
  /**
   * Outbound calls made to verify a webhook nobody has authenticated yet (fetching a signing
   * certificate, asking PayPal to verify). Genuine deliveries verify locally from the cached
   * key and spend none of it; PayPal redelivers an event that was turned away.
   */
  webhookVerificationGlobal: { scope: "webhook-verification", limit: 30, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

/** Callers whose network address is not known share one per-address budget. */
export const UNKNOWN_CLIENT = "unknown";

/** The one subject of a rule that is counted for the whole deployment. */
export const GLOBAL_SUBJECT = "all";

/** No window is longer than an hour; a counter this old can never matter again. */
const STALE_AFTER_MS = 24 * ONE_HOUR * 1000;
/** Pruning is swept along by a small share of hits rather than paid for by every one. */
const PRUNE_PROBABILITY = 0.02;

const KEY_DIGEST_CHARS = 32;

/**
 * The counter key for one subject under one rule. The subject (a session id, a client key) is
 * hashed, so the rate-limit table never holds an identifier that means anything elsewhere —
 * and never a network address, whatever the caller passes in.
 */
export function rateLimitKey(scope: string, subject: string): string {
  const digest = createHash("sha256").update(`pact-rate-limit:${scope}:${subject}`).digest("hex");
  return `rl:${scope}:${digest.slice(0, KEY_DIGEST_CHARS)}`;
}

/**
 * Count one request against `key`.
 *
 * @throws ApiError (429) carrying `resetAt` once the window's budget is spent.
 */
export async function enforceRateLimit(
  ctx: ServiceContext,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const result = await hitRateLimit(ctx.db, key, limit, windowSeconds, ctx.now());
  if (Math.random() < PRUNE_PROBABILITY) await pruneRateLimits(ctx);
  if (!result.allowed) throw rateLimited(result.resetAt);
}

/**
 * Count one request against a rule and report whether it is within budget, without throwing.
 * For callers that degrade instead of refusing (a reconciliation without the agent's statement).
 */
export async function withinRule(ctx: ServiceContext, rule: RateLimitRule, subject: string): Promise<boolean> {
  return (await hitRateLimit(ctx.db, rateLimitKey(rule.scope, subject), rule.limit, rule.windowSeconds, ctx.now())).allowed;
}

/**
 * Delete counters that are long past their window, so the table holds what is being limited now
 * and not a row for every session and address that ever called. Never lets a failed clean-up
 * fail the request it rode along with.
 */
export async function pruneRateLimits(ctx: ServiceContext): Promise<number> {
  try {
    return await deleteStaleRateLimits(ctx.db, new Date(ctx.now().getTime() - STALE_AFTER_MS));
  } catch (error) {
    log.warn("rate_limit.prune_failed", { error });
    return 0;
  }
}

/** Count one request by `subject` against a rule from {@link RATE_LIMITS}. */
export function enforceRule(ctx: ServiceContext, rule: RateLimitRule, subject: string): Promise<void> {
  return enforceRateLimit(ctx, rateLimitKey(rule.scope, subject), rule.limit, rule.windowSeconds);
}
