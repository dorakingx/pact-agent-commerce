/**
 * Abuse protection for the public demo: fixed-window counters in the database, so the limits
 * hold across serverless instances.
 */
import "server-only";
import { createHash } from "node:crypto";
import { hitRateLimit } from "../db";
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
} as const satisfies Record<string, RateLimitRule>;

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
  if (!result.allowed) throw rateLimited(result.resetAt);
}

/** Count one request by `subject` against a rule from {@link RATE_LIMITS}. */
export function enforceRule(ctx: ServiceContext, rule: RateLimitRule, subject: string): Promise<void> {
  return enforceRateLimit(ctx, rateLimitKey(rule.scope, subject), rule.limit, rule.windowSeconds);
}
