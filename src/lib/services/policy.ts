/**
 * Spending policy per owner, and the figures the policy engine is fed.
 *
 * The policy document is the human's; the arithmetic is the domain's (../domain/policy.ts).
 * What lives here is everything that needs the database: reading and saving the document,
 * totalling what an owner has already committed today, and the owner-level lock that makes
 * "check the daily limit, then commit the spend" one indivisible action.
 */
import "server-only";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { PolicyResponse } from "../api/dto";
import { getPolicyDoc, upsertPolicyDoc, type Db } from "../db";
import { dbCall } from "../db/errors";
import { auditEvents, deals, payments } from "../db/schema";
import { sha256Hex } from "../domain/canonical";
import { MAX_AMOUNT_MINOR, formatMoney } from "../domain/money";
import { DEFAULT_POLICY, PolicySchema, type AuditEventType, type Policy } from "../domain/schemas";
import type { DealStatus, PaymentStatus } from "../domain/status";
import type { ServiceContext } from "./context";
import { invalid } from "./errors";
import { RATE_LIMITS, enforceRule } from "./rate-limit";

/** The policy in force for an owner: the document they saved, or the default. */
export async function effectivePolicy(db: Db, owner: string): Promise<Policy> {
  return (await getPolicyDoc(db, owner)) ?? DEFAULT_POLICY;
}

/** 00:00 UTC of the day `now` falls in: daily limits run on UTC days. */
export function startOfUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/* -------------------------------------------------------------------------- */
/*  Committed spend                                                            */
/* -------------------------------------------------------------------------- */

/** Money is held or has moved. Counted on the UTC day the authorization was made. */
const HELD_PAYMENT_STATUSES = ["authorized", "captured"] as const satisfies readonly PaymentStatus[];
/** Reserved or waiting for the payer: not held yet, but able to become a hold at any moment. */
const OPEN_PAYMENT_STATUSES = ["none", "created", "approved"] as const satisfies readonly PaymentStatus[];
/** The only deal states in which an open payment can still turn into a hold. */
const OPEN_DEAL_STATUSES = ["payment_pending", "awaiting_payment"] as const satisfies readonly DealStatus[];
const AUTHORIZED_EVENT: AuditEventType = "payment.authorized";

/**
 * What the owner has committed against today's limit, in minor units:
 *
 *  - every authorization made today that is still held or was captured (the same instant and
 *    the same amounts as `sumAuthorizedSince`), and
 *  - every open order — a reservation or an order awaiting the payer — whatever day it was
 *    opened, because the payer can turn it into a hold today.
 *
 * Counting open orders is what closes the gap between "policy checked" and "money held": two
 * deals that each fit the limit cannot both proceed once the first has reserved its amount.
 * It can only over-count (an abandoned order counts until it is cancelled or lapses), never
 * under-count. Pass `excludeDealId` when evaluating a deal, so it is not counted against itself.
 */
export function committedSpendToday(
  db: Db,
  owner: string,
  now: Date,
  options: { excludeDealId?: string } = {},
): Promise<number> {
  return dbCall("committedSpendToday", async () => {
    const authorizedAt = sql`coalesce((
      select min(${auditEvents.at}) from ${auditEvents}
      where ${auditEvents.dealId} = ${payments.dealId} and ${auditEvents.type} = ${AUTHORIZED_EVENT}
    ), ${payments.updatedAt})`;
    const isHeld = inArray(payments.status, HELD_PAYMENT_STATUSES);
    const heldToday = and(isHeld, sql`${authorizedAt} >= ${startOfUtcDay(now)}::timestamptz`);
    const openOrder = and(inArray(payments.status, OPEN_PAYMENT_STATUSES), inArray(deals.status, OPEN_DEAL_STATUSES));
    const amount = sql`case when ${isHeld} then ${payments.authorizedMinor} else ${payments.amountMinor} end`;
    const [row] = await db
      .select({ total: sql<number>`coalesce(sum(${amount}), 0)`.mapWith(Number) })
      .from(payments)
      .innerJoin(deals, eq(deals.id, payments.dealId))
      .where(
        and(
          eq(deals.owner, owner),
          or(heldToday, openOrder),
          options.excludeDealId === undefined ? undefined : ne(payments.dealId, options.excludeDealId),
        ),
      );
    return row.total;
  });
}

/** 52 bits of the digest: the widest key that is still an exact JavaScript integer. */
const LOCK_KEY_HEX_CHARS = 13;

/**
 * Serialise spend decisions per owner. Must be called inside a transaction: the advisory lock
 * is released when that transaction ends, so "read the committed total, compare with the limit,
 * reserve the amount" cannot interleave with the same sequence for another deal of the owner.
 * (Works on Postgres and on PGlite; a hash collision only makes two owners wait for each other.)
 */
export function lockOwnerSpend(tx: Db, owner: string): Promise<void> {
  return dbCall("lockOwnerSpend", async () => {
    const key = Number.parseInt(sha256Hex(`pact-owner-spend:${owner}`).slice(0, LOCK_KEY_HEX_CHARS), 16);
    await tx.execute(sql`select pg_advisory_xact_lock(${key}::bigint)`);
  });
}

/* -------------------------------------------------------------------------- */
/*  Policy document                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The session's policy with today's committed spend (the figure the engine checks the daily
 * limit against). Without a session it is the default policy with nothing spent.
 */
export async function getPolicy(ctx: ServiceContext, sessionId: string | null): Promise<PolicyResponse> {
  if (sessionId === null) return { policy: DEFAULT_POLICY, spentTodayMinor: 0, isDefault: true };
  const stored = await getPolicyDoc(ctx.db, sessionId);
  return {
    policy: stored ?? DEFAULT_POLICY,
    spentTodayMinor: await committedSpendToday(ctx.db, sessionId, ctx.now()),
    isDefault: stored === null,
  };
}

/** PolicySchema already bounds every amount; this states the per-transaction ceiling in the user's terms. */
function parsePolicy(input: unknown): Policy {
  const policy = PolicySchema.parse(input);
  if (policy.maxTransactionMinor > MAX_AMOUNT_MINOR) {
    throw invalid(`The per-transaction maximum cannot exceed ${formatMoney(MAX_AMOUNT_MINOR)}.`);
  }
  if (policy.allowedCategories.includes("restricted")) {
    throw invalid("Restricted work can never be an allowed category.");
  }
  return { ...policy, allowedCategories: [...new Set(policy.allowedCategories)] };
}

/**
 * Replace the session's policy. It applies to that session only and to what happens next: the
 * verification thresholds of a contract were copied into it when it was signed and do not change.
 *
 * @throws ZodError / ApiError (400) for an invalid document, ApiError (429) when updated too often.
 */
export async function updatePolicy(ctx: ServiceContext, sessionId: string, input: unknown): Promise<PolicyResponse> {
  // Parsed before it is counted: an obviously wrong document should not eat the caller's budget.
  const policy = parsePolicy(input);
  await enforceRule(ctx, RATE_LIMITS.policyUpdatePerSession, sessionId);
  await upsertPolicyDoc(ctx.db, sessionId, policy);
  return getPolicy(ctx, sessionId);
}
