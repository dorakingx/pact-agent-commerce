/**
 * Reconciliation: re-read PayPal's own record of a deal and compare it, field by field, with
 * what PACT's ledger says.
 *
 * Two layers, deliberately separate:
 *
 *  1. Deterministic facts. PayPal is read through the payment provider and every comparison is
 *     plain code. The verdict (`match` / `mismatch` / `unavailable`) comes from here and from
 *     nowhere else.
 *  2. An optional statement by the auditor agent (../ai/auditor.ts), which reads the same order
 *     through the official PayPal Agent Toolkit with a single read-only tool and describes the
 *     result for a human. It cannot change the verdict, and when it fails the facts stand alone.
 *
 * Nothing here changes a payment or a deal status. The only write is one `payment.reconciled`
 * audit event, and only when the deal's owner asked.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import {
  AuditorUnavailableError,
  writeReconciliationStatement,
  type AuditorInput,
  type AuditorStatement,
  type AuditorToolCall,
} from "../ai/auditor";
import type { ReconciliationFact, ReconciliationView } from "../api/dto";
import { getAiMode, getPayPalConfig, type AiMode } from "../config";
import { acquireDealLease, loadDealGraphs, releaseDealLease, withTransaction } from "../db";
import { paypalCustomId, paypalInvoiceId, verifyContractHash } from "../domain/contract";
import { assertNever, joinList, parseTimestamp, plural } from "../domain/format";
import { formatMoney } from "../domain/money";
import type { AuditEventInput, SignedContract } from "../domain/schemas";
import { log } from "../observability/logger";
import {
  PaymentError,
  type AuthorizationInfo,
  type OrderInfo,
  type PaymentRecord,
  type ProviderKind,
} from "../payments";
import { appendAudit } from "./audit-log";
import type { ServiceContext } from "./context";
import { isDealId } from "./deals";
import { notFound } from "./errors";
import { enforceRateLimit, rateLimitKey } from "./rate-limit";
import { SYSTEM_OWNER } from "./session";

/** Each reconciliation costs PayPal reads and possibly a model call. */
export const RECONCILE_RATE_LIMIT = { scope: "reconcile", limit: 12, windowSeconds: 600 } as const;

/** Long enough for one small insert; short enough that a crashed request never stalls a deal. */
const AUDIT_LEASE_TTL_SECONDS = 20;

/* -------------------------------------------------------------------------- */
/*  Deterministic facts                                                        */
/* -------------------------------------------------------------------------- */

type OrderStatus = OrderInfo["status"];
type AuthorizationStatus = AuthorizationInfo["status"];

/** PayPal order states before the payer has approved anything. */
const AWAITING_PAYER: readonly OrderStatus[] = ["CREATED", "SAVED", "PAYER_ACTION_REQUIRED"];

/**
 * What PayPal should report for the order. An order with intent AUTHORIZE becomes COMPLETED
 * the moment it is authorized and stays COMPLETED whatever later happens to the authorization
 * (capture, void, expiry) — so once PACT holds an authorization id, that is the only answer.
 * A payment that ended without ever being authorized leaves an order that was never completed.
 */
function expectedOrderStatuses(payment: PaymentRecord): readonly OrderStatus[] {
  if (payment.authorizationId !== null) return ["COMPLETED"];
  switch (payment.status) {
    case "none":
      return [];
    case "created":
      return AWAITING_PAYER;
    case "approved":
      return ["APPROVED"];
    case "authorized":
    case "captured":
      return ["COMPLETED"];
    case "voided":
    case "expired":
    case "failed":
      return [...AWAITING_PAYER, "APPROVED", "VOIDED"];
    default:
      return assertNever(payment.status);
  }
}

function isPast(iso: string | null, now: Date): boolean {
  const at = iso === null ? null : parseTimestamp(iso);
  return at !== null && at <= now.getTime();
}

/**
 * What PayPal should report for the authorization.
 *
 *  - authorized → CREATED (funds held);
 *  - captured → CAPTURED, or PARTIALLY_CAPTURED when a human released only part of the price;
 *  - voided / expired → VOIDED (PayPal may keep listing a lapsed hold as CREATED for a while);
 *  - failed → DENIED or VOIDED: if PayPal still holds the funds, someone has to know.
 */
function expectedAuthorizationStatuses(
  payment: PaymentRecord,
  authorization: AuthorizationInfo,
  now: Date,
): readonly AuthorizationStatus[] {
  switch (payment.status) {
    case "authorized":
      return ["CREATED"];
    case "captured":
      return payment.capturedMinor < payment.authorizedMinor ? ["PARTIALLY_CAPTURED"] : ["CAPTURED"];
    case "voided":
      return ["VOIDED"];
    case "expired":
      return isPast(authorization.expiresAt ?? payment.authorizationExpiresAt, now) ? ["VOIDED", "CREATED"] : ["VOIDED"];
    case "failed":
      return ["DENIED", "VOIDED"];
    case "none":
    case "created":
    case "approved":
      // PACT records no authorization in these states, so none of PayPal's statuses can agree.
      return [];
    default:
      return assertNever(payment.status);
  }
}

/** "A", "A or B", "A, B or C". */
function anyOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** PACT's status together with what it expects PayPal to say, since the two vocabularies differ. */
function statusFact(field: string, pactStatus: string, expected: readonly string[], actual: string): ReconciliationFact {
  const expectation = expected.length === 0 ? "no such record at PayPal" : anyOf(expected);
  return { field, pact: `${pactStatus} (expects ${expectation})`, paypal: actual, match: expected.includes(actual) };
}

function valueFact(field: string, pact: string | null, paypal: string | null): ReconciliationFact {
  return { field, pact, paypal, match: pact === paypal };
}

/** Timestamps are compared as instants and shown in one canonical form, so equal times look equal. */
function canonicalInstant(iso: string | null): string | null {
  const at = iso === null ? null : parseTimestamp(iso);
  return at === null ? iso : new Date(at).toISOString();
}

function bindingFact(signed: SignedContract, order: OrderInfo): ReconciliationFact {
  const expected = paypalCustomId(signed);
  // A stored contract that no longer hashes to its own fingerprint cannot vouch for any order.
  if (!verifyContractHash(signed)) {
    return {
      field: "Contract binding (custom_id)",
      pact: `${expected} (the stored contract no longer matches this hash)`,
      paypal: order.customId,
      match: false,
    };
  }
  return valueFact("Contract binding (custom_id)", expected, order.customId);
}

export interface ReconciliationInput {
  signed: SignedContract;
  payment: PaymentRecord;
  /** PayPal's record of the order, as just read. */
  order: OrderInfo;
  /** PayPal's record of the authorization; null when PACT holds no authorization id. */
  authorization: AuthorizationInfo | null;
  now: Date;
}

/**
 * The field-by-field comparison. Pure: the same records always produce the same facts.
 * Order facts are always present; authorization facts only once PACT holds an authorization.
 */
export function buildReconciliationFacts(input: ReconciliationInput): ReconciliationFact[] {
  const { signed, payment, order, authorization, now } = input;
  const facts: ReconciliationFact[] = [
    statusFact("Order status", payment.status, expectedOrderStatuses(payment), order.status),
    valueFact("Order amount", formatMoney(payment.amountMinor), formatMoney(order.amountMinor)),
    bindingFact(signed, order),
    valueFact("Invoice id", paypalInvoiceId(signed), order.invoiceId),
  ];
  if (authorization === null) return facts;
  return [
    ...facts,
    statusFact(
      "Authorization status",
      payment.status,
      expectedAuthorizationStatuses(payment, authorization, now),
      authorization.status,
    ),
    valueFact("Authorized amount", formatMoney(payment.authorizedMinor), formatMoney(authorization.amountMinor)),
    valueFact(
      "Authorization expiry",
      canonicalInstant(payment.authorizationExpiresAt),
      canonicalInstant(authorization.expiresAt),
    ),
  ];
}

/* -------------------------------------------------------------------------- */
/*  The auditor agent                                                          */
/* -------------------------------------------------------------------------- */

/** Injection points for tests; production reads the configuration and calls the real agent. */
export interface AuditorServiceDeps {
  aiMode?: () => AiMode;
  /** PayPal REST credentials for the Agent Toolkit, or null when none are configured. */
  credentials?: () => AuditorInput["credentials"] | null;
  narrate?: (input: AuditorInput) => Promise<AuditorStatement>;
}

export interface ReconcileOptions {
  /** Rate-limit key for a caller without a session (see clientKey in ./http.ts). */
  clientKey?: string | null;
  /** Pass false to skip the auditor agent, e.g. when nobody will read its statement. */
  narrate?: boolean;
  deps?: AuditorServiceDeps;
}

function providerName(kind: ProviderKind): string {
  switch (kind) {
    case "paypal_sandbox":
      return "PayPal";
    case "simulated":
      return "Simulated PayPal";
    default:
      return assertNever(kind);
  }
}

function configuredCredentials(): AuditorInput["credentials"] | null {
  const config = getPayPalConfig();
  return config === null ? null : { clientId: config.clientId, clientSecret: config.clientSecret };
}

type AgentAccess = { credentials: AuditorInput["credentials"] } | { unavailable: string };

/**
 * The agent runs only against the real PayPal Sandbox, with AI enabled and credentials present.
 * The simulator has no PayPal record to read, and pretending otherwise would be dishonest.
 */
function agentAccess(provider: ProviderKind, options: ReconcileOptions): AgentAccess {
  const deps = options.deps ?? {};
  if (options.narrate === false) return { unavailable: "The auditor agent was not asked for a statement." };
  if (provider !== "paypal_sandbox") {
    return { unavailable: "Payments are simulated, so there is no PayPal record for the auditor agent to read." };
  }
  if ((deps.aiMode ?? getAiMode)() !== "ai") return { unavailable: "The auditor agent is switched off (scripted mode)." };
  const credentials = (deps.credentials ?? configuredCredentials)();
  if (credentials === null) return { unavailable: "The auditor agent has no PayPal credentials to read with." };
  return { credentials };
}

interface Narration {
  narrative: string | null;
  model: string | null;
  toolCalls: AuditorToolCall[];
  note: string | null;
}

const DETERMINISTIC_ONLY = "The comparison shown is deterministic.";

function withoutStatement(reason: string, toolCalls: AuditorToolCall[] = []): Narration {
  return { narrative: null, model: null, toolCalls, note: `${reason} ${DETERMINISTIC_ONLY}` };
}

/** Any failure of the agent degrades to "no statement": the facts are never held hostage by a model. */
async function narrate(
  request: Omit<AuditorInput, "credentials">,
  provider: ProviderKind,
  options: ReconcileOptions,
): Promise<Narration> {
  const access = agentAccess(provider, options);
  if ("unavailable" in access) return withoutStatement(access.unavailable);
  const run = options.deps?.narrate ?? ((input: AuditorInput) => writeReconciliationStatement(input));
  try {
    const statement = await run({ ...request, credentials: access.credentials });
    return { narrative: statement.narrative, model: statement.model, toolCalls: statement.toolCalls, note: null };
  } catch (error) {
    if (error instanceof AuditorUnavailableError) {
      return withoutStatement(`The auditor agent was unavailable (${error.reason}).`, error.toolCalls);
    }
    log.warn("auditor.unexpected_failure", { ...request.logFields, error });
    return withoutStatement("The auditor agent was unavailable.");
  }
}

/* -------------------------------------------------------------------------- */
/*  Audit                                                                      */
/* -------------------------------------------------------------------------- */

function reconciledEvent(
  payment: PaymentRecord,
  facts: ReconciliationFact[],
  narration: Narration,
  now: Date,
): AuditEventInput {
  const differing = facts.filter((fact) => !fact.match).map((fact) => fact.field);
  const name = providerName(payment.provider);
  return {
    actor: "system",
    type: "payment.reconciled",
    title:
      differing.length === 0
        ? `Reconciled with ${name}: ledger matches`
        : `Reconciled with ${name}: ${plural(differing.length, "difference")}`,
    detail: differing.length === 0 ? null : `Differs: ${joinList(differing)}.`,
    // Statuses, amounts, hashes and ids only: none of the facts can hold an e-mail address.
    data: {
      provider: payment.provider,
      orderId: payment.orderId,
      authorizationId: payment.authorizationId,
      captureId: payment.captureId,
      status: differing.length === 0 ? "match" : "mismatch",
      checked: facts.length,
      differences: differing,
      facts: facts.map(({ field, pact, paypal, match }) => ({ field, pact, paypal, match })),
      source: narration.narrative === null ? "deterministic" : "ai",
      model: narration.model,
      toolCalls: narration.toolCalls.map(({ tool, ok }) => ({ tool, ok })),
    },
    at: now.toISOString(),
  };
}

/**
 * Append the event under the deal's step lease, so it can never race a lifecycle step for the
 * next audit sequence number. Returns false, writing nothing, when a step holds the lease.
 */
async function recordReconciliation(ctx: ServiceContext, dealId: string, event: AuditEventInput, now: Date): Promise<boolean> {
  const lockId = `reconcile:${randomUUID()}`;
  if ((await acquireDealLease(ctx.db, dealId, lockId, AUDIT_LEASE_TTL_SECONDS, now)) === null) return false;
  try {
    await withTransaction(ctx.db, (tx) => appendAudit(tx, dealId, [event], now));
    return true;
  } finally {
    await releaseDealLease(ctx.db, dealId, lockId);
  }
}

/* -------------------------------------------------------------------------- */
/*  Service                                                                    */
/* -------------------------------------------------------------------------- */

function unavailable(dealId: string, now: Date, note: string): ReconciliationView {
  return {
    dealId,
    status: "unavailable",
    checkedAt: now.toISOString(),
    facts: [],
    narrative: null,
    toolCalls: [],
    source: "deterministic",
    model: null,
    note,
  };
}

interface PayPalRecords {
  order: OrderInfo;
  authorization: AuthorizationInfo | null;
}

async function readPayPal(ctx: ServiceContext, orderId: string, authorizationId: string | null): Promise<PayPalRecords> {
  const order = await ctx.provider.getOrder(orderId);
  const authorization = authorizationId === null ? null : await ctx.provider.getAuthorization(authorizationId);
  return { order, authorization };
}

/** Per session; callers without one share a budget per network address (or one anonymous budget). */
function rateLimitSubject(viewerSessionId: string | null, clientKey: string | null): string {
  return viewerSessionId ?? `client:${clientKey ?? "anonymous"}`;
}

function joinNotes(...notes: (string | null)[]): string | null {
  const present = notes.filter((note): note is string => note !== null);
  return present.length === 0 ? null : present.join(" ");
}

/**
 * Compare PACT's ledger with PayPal's record of the deal.
 *
 * Anyone who can see the deal may ask (the answer contains nothing the deal view does not),
 * within a rate limit; only a reconciliation asked for by the deal's owner is written to the
 * audit trail. The seed script reconciles showcase deals as their owner, SYSTEM_OWNER, which no
 * browser session can ever be, and is the one caller that is not rate-limited.
 *
 * A provider failure is an answer ("unavailable", with PayPal's issue and debug id), not an error.
 */
export async function reconcileWithPayPal(
  ctx: ServiceContext,
  viewerSessionId: string | null,
  dealId: string,
  options: ReconcileOptions = {},
): Promise<ReconciliationView> {
  if (!isDealId(dealId)) throw notFound("Deal");
  if (viewerSessionId !== SYSTEM_OWNER) {
    const { scope, limit, windowSeconds } = RECONCILE_RATE_LIMIT;
    const subject = rateLimitSubject(viewerSessionId, options.clientKey ?? null);
    await enforceRateLimit(ctx, rateLimitKey(scope, subject), limit, windowSeconds);
  }
  const now = ctx.now();
  const graph = (await loadDealGraphs(ctx.db, [dealId], { artifacts: false })).get(dealId);
  if (!graph) throw notFound("Deal");

  const { payment, signed } = graph;
  if (payment === null || payment.orderId === null || signed === null) {
    return unavailable(dealId, now, "This deal has no PayPal order yet, so there is nothing to reconcile.");
  }
  if (payment.provider !== ctx.provider.kind) {
    return unavailable(
      dealId,
      now,
      `This deal was paid through ${providerName(payment.provider)}, which is not the active payment provider.`,
    );
  }

  const name = providerName(payment.provider);
  let records: PayPalRecords;
  try {
    records = await readPayPal(ctx, payment.orderId, payment.authorizationId);
  } catch (error) {
    if (!(error instanceof PaymentError)) throw error;
    log.warn("auditor.provider_unreadable", { dealId, issue: error.issue, paypalDebugId: error.debugId, httpStatus: error.httpStatus });
    const debug = error.debugId === null ? "" : `, debug id ${error.debugId}`;
    return unavailable(dealId, now, `${name} could not be read (${error.issue}${debug}). Nothing was compared.`);
  }

  const facts = buildReconciliationFacts({ signed, payment, ...records, now });
  const narration = await narrate({ orderId: payment.orderId, facts, logFields: { dealId } }, payment.provider, options);

  const isOwner = viewerSessionId !== null && viewerSessionId === graph.deal.owner;
  const unrecorded =
    isOwner && !(await recordReconciliation(ctx, dealId, reconciledEvent(payment, facts, narration, now), now));
  return {
    dealId,
    status: facts.every((fact) => fact.match) ? "match" : "mismatch",
    checkedAt: now.toISOString(),
    facts,
    narrative: narration.narrative,
    toolCalls: narration.toolCalls,
    source: narration.narrative === null ? "deterministic" : "ai",
    model: narration.model,
    note: joinNotes(narration.note, unrecorded ? "Not written to the audit trail: the deal was busy with another step." : null),
  };
}
