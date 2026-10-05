/**
 * The step engine: the only writer of a deal's status.
 *
 * A deal moves one step at a time. Each step
 *   1. runs under the deal's lease, so a double click, a second tab or a retried request can
 *      never run the same step twice;
 *   2. does its external work — one model call or one PayPal call — outside any transaction;
 *   3. persists the result, the audit events and the status change in ONE transaction, guarded by
 *      the deal's version, after the change has passed the deal state machine.
 *
 * Agents only propose here: what they return is parsed, clamped by the negotiation rules,
 * judged by the verification and settlement engines, and only then written. Nothing the
 * browser sends carries an amount, a status or a contract — it sends a request in words and,
 * at a human gate, a decision.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ZodError } from "zod";
import type { AgentMeta } from "../ai/types";
import type { AdvanceResponse, CreateDealRequest, DealSummary, DealView, DecisionRequest, StepKind } from "../api/dto";
import {
  DuplicateError,
  acquireDealLease,
  createDbLedger,
  findDealIdByAuthorizationId,
  findDealIdByCaptureId,
  findDealIdByOrderId,
  getDeal,
  getPayment,
  getWallet,
  getWebhookEvent,
  insertContract,
  insertDeal,
  insertMove,
  insertReport,
  insertSubmission,
  listDealsByOwner,
  listPaymentOperations,
  loadDealGraphs,
  markWebhookProcessed,
  recordWebhookEvent,
  releaseDealLease,
  updateDeal,
  upsertPayment,
  withTransaction,
  type Db,
  type DealGraph,
  type DealInsert,
  type DealRow,
} from "../db";
import { compileContract } from "../domain/contract";
import { assertNever, plural } from "../domain/format";
import { newDealCode, newId } from "../domain/ids";
import { formatMoney } from "../domain/money";
import {
  InvalidMoveError,
  applyMove,
  buyerContextFor,
  nextActor,
  sellerContextFor,
  type RulesContext,
} from "../domain/negotiation";
import { scriptedBuyerMove, scriptedSellerMove } from "../domain/negotiation-strategy";
import { nextStepFor } from "../domain/next-step";
import { evaluatePolicy } from "../domain/policy";
import { getScenario, type Scenario } from "../domain/scenarios";
import {
  HumanDecisionKindSchema,
  SubmissionSchema,
  type Artifact,
  type AuditEvent,
  type AuditEventInput,
  type HumanDecision,
  type Mandate,
  type MoveAction,
  type NegotiationMove,
  type NegotiationState,
  type Party,
  type Policy,
  type PolicyEvaluation,
  type SignedContract,
  type Submission,
  type VerificationReport,
} from "../domain/schemas";
import { getSeller, matchSeller, type SellerProfile } from "../domain/sellers";
import { checkCaptureAllowed, checkVoidAllowed, type GuardViolation } from "../domain/settlement";
import { assertTransition, isAuto, type DealStatus } from "../domain/status";
import { buildReport, runDeterministicChecks } from "../domain/verification";
import { log } from "../observability/logger";
import { sanitizeSvg } from "../studio/svg-sanitize";
import {
  PaymentError,
  PaymentStepError,
  SimulatedProvider,
  applyWebhookEffect,
  authorizeApprovedOrder,
  captureVerified,
  interpretWebhookEvent,
  newPaymentRecord,
  openOrder,
  reconcile,
  voidHeldFunds,
  type ApprovalMode,
  type OrchestratorDeps,
  type PaymentOperationKind,
  type PaymentRecord,
  type PaymentStepResult,
  type ProviderKind,
  type WebhookEffect,
  type WebhookVerification,
} from "../payments";
import { appendAudit, withoutRecorded } from "./audit-log";
import type { ServiceContext } from "./context";
import { buildDealView, toArtifactFile, toDealSummary, type ArtifactFile } from "./deal-view";
import { conflict, forbidden, invalid, notFound, unavailable } from "./errors";
import { committedSpendToday, effectivePolicy, lockOwnerSpend } from "./policy";
import { RATE_LIMITS, enforceRule, type RateLimitRule } from "./rate-limit";
import { sanitizeIntent, sanitizeReason } from "./sanitize";
import { SYSTEM_OWNER } from "./session";

/** Owner key of the shared, operator-connected sandbox wallet. */
export const DEMO_WALLET_OWNER = "demo";

/** Who is asking for a deal to be created. */
export interface Actor {
  /** The browser session (or SYSTEM_OWNER for the seed script). It becomes the deal's owner. */
  sessionId: string;
  /** Hashed network address from http.ts `clientKey`, or null when unknown. Rate limiting only. */
  clientKey: string | null;
}

/** Longer than the slowest step (a 40 s verification call), shorter than anyone waits for a stuck deal. */
const LEASE_TTL_SECONDS = 120;
/** A webhook, a decision or a PayPal return waits this long, in total, for a running step to finish. */
const LEASE_RETRY_DELAYS_MS = [100, 250, 500] as const;
/** Attempts of one PayPal operation before the engine stops retrying and fails the deal. */
const MAX_PAYMENT_ATTEMPTS = 4;
const MAX_CODE_ATTEMPTS = 5;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const DEAL_ID_PATTERN = /^deal_[a-z0-9]{8,32}$/;
const SIMULATED_ORDER_PATTERN = /^SIM-O-[0-9A-F]{16}$/;
const NO_SELLER_REASON = "No seller agent in the directory offers this kind of work";

/* -------------------------------------------------------------------------- */
/*  Reading                                                                    */
/* -------------------------------------------------------------------------- */

/** True for a string shaped like a deal id. Use it before putting an id from a URL into a redirect. */
export function isDealId(value: string): boolean {
  return DEAL_ID_PATTERN.test(value);
}

async function loadGraph(db: Db, dealId: string): Promise<DealGraph> {
  if (!isDealId(dealId)) throw notFound("Deal");
  const graph = (await loadDealGraphs(db, [dealId])).get(dealId);
  if (!graph) throw notFound("Deal");
  return graph;
}

/** The deal row alone, for the checks that do not need everything hanging off it. */
async function loadDeal(db: Db, dealId: string): Promise<DealRow> {
  const deal = isDealId(dealId) ? await getDeal(db, dealId) : null;
  if (deal === null) throw notFound("Deal");
  return deal;
}

function viewOf(ctx: ServiceContext, graph: DealGraph, viewerSessionId: string | null): DealView {
  return buildDealView(graph, viewerSessionId, ctx.now(), { providerKind: ctx.provider.kind });
}

/**
 * The deal as the viewer may see it. Reading is allowed to anyone holding the id: ids are
 * unguessable, a view carries no secret, and showcase deals are public by design.
 *
 * @throws ApiError (404) for an unknown id.
 */
export async function getDealView(ctx: ServiceContext, viewerSessionId: string | null, dealId: string): Promise<DealView> {
  return viewOf(ctx, await loadGraph(ctx.db, dealId), viewerSessionId);
}

/** The session's own deals, newest first. */
export async function listMyDeals(ctx: ServiceContext, sessionId: string, limit = DEFAULT_LIST_LIMIT): Promise<DealSummary[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  return (await listDealsByOwner(ctx.db, sessionId, bounded)).map(toDealSummary);
}

/** One deliverable of a deal as a downloadable file. Readable by anyone who can read the deal. */
export async function getArtifactFile(ctx: ServiceContext, dealId: string, artifactId: string): Promise<ArtifactFile> {
  const graph = await loadGraph(ctx.db, dealId);
  // A revision keeps the ids of the files it did not touch; the newest round holds the current bytes.
  for (const submission of [...graph.submissions].reverse()) {
    const artifact = submission.artifacts.find((candidate) => candidate.id === artifactId);
    if (artifact) return toArtifactFile(graph.deal.code, artifact);
  }
  throw notFound("Artifact");
}

/* -------------------------------------------------------------------------- */
/*  Shared plumbing                                                            */
/* -------------------------------------------------------------------------- */

/** Only the session that created a deal may change it. Showcase deals belong to no browser session. */
function assertOwner(deal: DealRow, sessionId: string): void {
  if (deal.owner !== sessionId) throw forbidden("Only the session that created this deal can change it.");
}

/**
 * For route handlers: the session a state-changing request acts as. A request without a session
 * may read a deal but never change one; an unknown deal is still reported as unknown (404) first.
 *
 * @throws ApiError 404 (unknown deal), 403 (no session, or not the deal's owner).
 */
export async function requireOwner(ctx: ServiceContext, sessionId: string | null, dealId: string): Promise<string> {
  const deal = await loadDeal(ctx.db, dealId);
  if (sessionId === null) throw forbidden("Only the session that created this deal can change it.");
  assertOwner(deal, sessionId);
  return sessionId;
}

/** The seed script acts as SYSTEM_OWNER, which can never arrive over HTTP, and is not throttled. */
async function limitSession(ctx: ServiceContext, rule: RateLimitRule, sessionId: string): Promise<void> {
  if (sessionId !== SYSTEM_OWNER) await enforceRule(ctx, rule, sessionId);
}

function paymentDeps(ctx: ServiceContext): OrchestratorDeps {
  // The ledger gets the root database: its "started" row must survive whatever fails next.
  return { provider: ctx.provider, ledger: createDbLedger(ctx.db), now: ctx.now };
}

function providerLabel(kind: ProviderKind): string {
  switch (kind) {
    case "paypal_sandbox":
      return "PayPal";
    case "simulated":
      return "Simulated PayPal";
    default:
      return assertNever(kind);
  }
}

function latest<T>(items: readonly T[]): T | null {
  return items[items.length - 1] ?? null;
}

/** Stored state the engine itself wrote is missing. Not reachable through the API; fails loudly rather than guessing. */
function broken(dealId: string, what: string): Error {
  return new Error(`Deal ${dealId} is in an inconsistent state: ${what}`);
}

function mandateOf(graph: DealGraph): Mandate {
  if (!graph.deal.mandate) throw broken(graph.deal.id, "it has no mandate");
  return graph.deal.mandate;
}

function sellerOf(graph: DealGraph): SellerProfile {
  const seller = graph.deal.sellerId === null ? undefined : getSeller(graph.deal.sellerId);
  if (!seller) throw broken(graph.deal.id, "its seller is not in the directory");
  return seller;
}

function signedOf(graph: DealGraph): SignedContract {
  if (!graph.signed) throw broken(graph.deal.id, "it has no contract");
  return graph.signed;
}

function paymentOf(graph: DealGraph): PaymentRecord {
  if (!graph.payment) throw broken(graph.deal.id, "it has no payment record");
  return graph.payment;
}

const staleDeal = () => conflict("The deal changed while this step was running. Reload it and try again.");

/* ----------------------------------- Lease ---------------------------------- */

async function takeLease(ctx: ServiceContext, dealId: string): Promise<string | null> {
  const lockId = `step_${randomUUID()}`;
  return (await acquireDealLease(ctx.db, dealId, lockId, LEASE_TTL_SECONDS, ctx.now())) ? lockId : null;
}

/** For callers that cannot simply come back later (PayPal's webhook, a human's click): wait briefly for a running step. */
async function takeLeasePatiently(ctx: ServiceContext, dealId: string): Promise<string | null> {
  for (const delayMs of LEASE_RETRY_DELAYS_MS) {
    const lockId = await takeLease(ctx, dealId);
    if (lockId !== null) return lockId;
    await sleep(delayMs);
  }
  return takeLease(ctx, dealId);
}

/** Run `work` and release the lease whatever happens. A failed release must not hide the work's own outcome. */
async function underLease<T>(ctx: ServiceContext, dealId: string, lockId: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } finally {
    await releaseDealLease(ctx.db, dealId, lockId).catch((error: unknown) => {
      // The lease expires on its own after LEASE_TTL_SECONDS.
      log.error("deal.lease_release_failed", { dealId, error });
    });
  }
}

/* ---------------------------------- Commit ---------------------------------- */

interface StepWrite {
  /** Status after the step; the current status when the step could not move the deal on. */
  to: DealStatus;
  events: AuditEventInput[];
  patch?: Partial<DealInsert>;
  /** Child rows of the step (a move, a contract, a payment record, a submission, a report). */
  rows?: (tx: Db) => Promise<void>;
}

/**
 * Persist one step: child rows, audit events and the deal update commit together or not at all.
 * The status change must be one the state machine allows, and the deal must still be at the
 * version the step read — otherwise someone else moved it and this step's result is discarded.
 *
 * @throws ApiError (409) when the deal changed underneath the step.
 */
async function commit(ctx: ServiceContext, deal: DealRow, write: StepWrite, now: Date): Promise<void> {
  if (write.to !== deal.status) assertTransition(deal.status, write.to);
  try {
    await withTransaction(ctx.db, async (tx) => {
      await write.rows?.(tx);
      await appendAudit(tx, deal.id, write.events, now);
      const patch = { ...write.patch, status: write.to, updatedAt: now.toISOString() };
      if ((await updateDeal(tx, deal.id, deal.version, patch)) === null) throw staleDeal();
    });
  } catch (error) {
    // A unique index refused a row of this step (same move, round or sequence number): another
    // request has already written the step's result, which is the same lost race.
    if (error instanceof DuplicateError) throw staleDeal();
    throw error;
  }
}

/* --------------------------------- Failures --------------------------------- */

/**
 * A step could not run and nothing about the deal may change except the record that it failed.
 * `message` is written to the deal and shown to its owner, so it never carries internals.
 */
class StepFailure extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StepFailure";
  }
}

/**
 * Run an agent. Agents absorb model problems themselves (fallback, degraded result); anything
 * that still escapes is a fault in the agent's own code, and it must stop the step, not the deal.
 */
async function proposing<T>(dealId: string, step: StepKind, failure: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    log.error("step.agent_failed", { dealId, step, error });
    throw new StepFailure(failure, { cause: error });
  }
}

function problemEvent(message: string, data: Record<string, unknown> = {}): AuditEventInput {
  return { actor: "system", type: "system.error", title: message, data };
}

/** Record that a step failed: the deal keeps its status, gains `lastError`, and the trail gets the message once. */
async function recordFailure(ctx: ServiceContext, graph: DealGraph, message: string, now: Date): Promise<void> {
  await commit(
    ctx,
    graph.deal,
    { to: graph.deal.status, events: withoutRecorded(graph.audit, [problemEvent(message)]), patch: { lastError: message } },
    now,
  );
}

/* --------------------------------- Degraded --------------------------------- */

type DegradableStep = "intent" | Extract<StepKind, "negotiate" | "fulfill" | "verify">;

const DEGRADED_TITLE: Record<DegradableStep, string> = {
  intent: "The buyer agent's model was unavailable, so the scripted parser read the request",
  negotiate: "A negotiating agent's model was unavailable, so a scripted agent made the move",
  fulfill: "The seller agent's model was unavailable, so the scripted studio produced the delivery",
  verify: "The AI verifier was unavailable, so the AI-judged conditions were not evaluated",
};

/** One notice per deal and kind of step, however many moves or rounds were affected. */
function degradedEvents(audit: readonly AuditEvent[], step: DegradableStep, reason: string | null): AuditEventInput[] {
  if (reason === null) return [];
  const noted = audit.some((event) => event.type === "system.degraded" && event.data?.step === step);
  return noted ? [] : [{ actor: "system", type: "system.degraded", title: DEGRADED_TITLE[step], data: { step, reason } }];
}

/* -------------------------------------------------------------------------- */
/*  Creating a deal                                                            */
/* -------------------------------------------------------------------------- */

function scenarioFor(scenarioId: string | undefined): Scenario | undefined {
  if (scenarioId === undefined) return undefined;
  const scenario = getScenario(scenarioId);
  if (!scenario) throw invalid("Unknown scenario.");
  return scenario;
}

async function limitCreation(ctx: ServiceContext, actor: Actor): Promise<void> {
  await limitSession(ctx, RATE_LIMITS.createDealPerSession, actor.sessionId);
  if (actor.sessionId !== SYSTEM_OWNER && actor.clientKey !== null) {
    await enforceRule(ctx, RATE_LIMITS.createDealPerClient, actor.clientKey);
  }
}

/**
 * Before negotiation there is no price and no seller to judge, so only the category is evaluated —
 * by the policy engine itself, so restricted work is refused in the engine's own words.
 */
function categoryOnlyEvaluation(policy: Policy, mandate: Mandate, now: Date): PolicyEvaluation {
  const full = evaluatePolicy(policy, {
    amountMinor: 0,
    category: mandate.category,
    seller: { id: "none", name: "No seller", trust: "established" },
    spentTodayMinor: 0,
    now,
  });
  const checks = full.checks.filter((check) => check.id === "category_allowed");
  return { ...full, checks, outcome: checks.some((check) => check.outcome === "block") ? "block" : "allow" };
}

interface Opening {
  status: DealStatus;
  patch: Partial<DealInsert>;
  events: AuditEventInput[];
}

/** Restricted work is never negotiated: the deal is created already blocked, with the policy engine's reason. */
function restrictedOpening(policy: Policy, mandate: Mandate, now: Date): Opening {
  const evaluation = categoryOnlyEvaluation(policy, mandate, now);
  return {
    status: "blocked",
    patch: { policyEvaluation: evaluation },
    events: [
      {
        actor: "policy_engine",
        type: "policy.evaluated",
        title: "Blocked by the spending policy before any negotiation",
        detail: evaluation.checks.map((check) => check.detail).join(" "),
        data: { outcome: evaluation.outcome, flagged: ["category_allowed"] },
      },
    ],
  };
}

/** A deal starts negotiating with its seller, or is over at once when no seller offers the work. */
function matchedOpening(mandate: Mandate, seller: SellerProfile | undefined, pinned: boolean): Opening {
  if (!seller) {
    return {
      status: "negotiation_failed",
      patch: { negotiationStatus: "failed", negotiationFailure: NO_SELLER_REASON },
      events: [{ actor: "system", type: "negotiation.failed", title: NO_SELLER_REASON, data: { category: mandate.category } }],
    };
  }
  return {
    status: "negotiating",
    patch: {},
    events: [
      {
        actor: "system",
        type: "seller.matched",
        title: `Matched with ${seller.name}`,
        detail: pinned ? "The scenario pins this seller agent." : "The most reliable seller agent offering this kind of work.",
        data: { sellerId: seller.id, trust: seller.trust, pinnedByScenario: pinned },
      },
    ],
  };
}

interface SellerChoice {
  seller: SellerProfile | undefined;
  /** True when the scenario's own seller was used. */
  pinned: boolean;
}

/**
 * A scenario pins its seller — for the kind of work that seller offers. The request text of a
 * scenario card can be edited before it is sent; if it then asks for other work, the pinned
 * seller has no rate for it (it would quote next to nothing), so the request is matched like
 * any free-form one.
 */
function chooseSeller(scenario: Scenario | undefined, category: Mandate["category"]): SellerChoice {
  const pinned = scenario === undefined ? undefined : getSeller(scenario.sellerId);
  if (pinned?.categories.includes(category)) return { seller: pinned, pinned: true };
  return { seller: matchSeller(category), pinned: false };
}

function intakeEvents(scenario: Scenario | undefined, mandate: Mandate, meta: AgentMeta): AuditEventInput[] {
  return [
    { actor: "human", type: "intent.received", title: "Request received", data: { scenarioId: scenario?.id ?? null } },
    {
      actor: "buyer_agent",
      type: "mandate.derived",
      title: `Mandate derived: ${mandate.summary}`,
      // The mandate's budget ceiling is private to the buyer and stays out of the public trail.
      data: { category: mandate.category, source: meta.source, model: meta.model },
    },
  ];
}

/**
 * Insert the deal with its first audit events. The short deal code is a display label drawn from
 * about a million combinations, so a collision is expected now and then: each attempt mints a new
 * id and code, in its own transaction (on Postgres a unique violation aborts the one it hit).
 */
async function insertWithFreshCode(
  ctx: ServiceContext,
  draft: Omit<DealInsert, "id" | "code">,
  events: AuditEventInput[],
  now: Date,
): Promise<DealRow> {
  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt += 1) {
    const row: DealInsert = { ...draft, id: newId("deal"), code: newDealCode() };
    try {
      return await withTransaction(ctx.db, async (tx) => {
        const deal = await insertDeal(tx, row);
        await appendAudit(tx, deal.id, events, now);
        return deal;
      });
    } catch (error) {
      if (!(error instanceof DuplicateError)) throw error;
      log.warn("deal.code_collision", { attempt, constraint: error.constraint });
    }
  }
  throw unavailable("Could not allocate a deal reference. Please try again.");
}

/**
 * Turn a human's request into a deal. The browser supplies words (and, optionally, which demo
 * scenario and its UTC offset); the mandate, the seller and the starting status are derived here.
 *
 * @throws ApiError 400 (request too short/long, unknown scenario), 429 (rate limited).
 */
export async function createDeal(ctx: ServiceContext, actor: Actor, input: CreateDealRequest): Promise<DealView> {
  const scenario = scenarioFor(input.scenarioId);
  // A scenario card may be submitted untouched: its own request text then stands in.
  const intent = sanitizeIntent(scenario && input.intent.trim() === "" ? scenario.intent : input.intent);
  await limitCreation(ctx, actor);

  const now = ctx.now();
  const { mandate, meta } = await ctx.agents.parseIntent(intent, now, input.tzOffsetMinutes);
  const { seller, pinned } = chooseSeller(scenario, mandate.category);
  const opening =
    mandate.category === "restricted"
      ? restrictedOpening(await effectivePolicy(ctx.db, actor.sessionId), mandate, now)
      : matchedOpening(mandate, seller, pinned);

  const draft: Omit<DealInsert, "id" | "code"> = {
    owner: actor.sessionId,
    scenarioId: scenario?.id ?? null,
    status: opening.status,
    intent,
    mandate,
    category: mandate.category,
    sellerId: seller?.id ?? null,
    aiDegraded: meta.degradedReason !== null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...opening.patch,
  };
  const events = [...intakeEvents(scenario, mandate, meta), ...opening.events, ...degradedEvents([], "intent", meta.degradedReason)];
  const deal = await insertWithFreshCode(ctx, draft, events, now);
  log.info("deal.created", { dealId: deal.id, code: deal.code, status: deal.status, scenarioId: deal.scenarioId });
  return getDealView(ctx, actor.sessionId, deal.id);
}

/* -------------------------------------------------------------------------- */
/*  Payment state learned elsewhere                                            */
/* -------------------------------------------------------------------------- */

/** The only statuses a payment record can force on a deal. */
export type PaymentDrivenStatus = Extract<DealStatus, "expired" | "completed" | "failed" | "authorized">;

/** Deal states in which money is held, or about to be, for work that is not settled yet. */
const WAITING_ON_FUNDS: ReadonlySet<DealStatus> = new Set<DealStatus>([
  "awaiting_payment",
  "authorized",
  "submitted",
  "revision_required",
  "in_review",
  "verified",
]);

/**
 * The status a deal must move to because of what its payment record says, or null when the
 * record asks for nothing.
 *
 * This is the ONE mapping from "PayPal's side changed" to a deal outcome, whoever learned it —
 * a verified webhook, a capture attempt, a reconciliation:
 *  - the hold is gone (voided or expired) while the deal still counts on it → "expired";
 *  - PayPal completed a capture PACT asked for → "completed";
 *  - PayPal refused the payment for good → "failed";
 *  - PayPal authorized an order the payer approved → "authorized".
 * A deal that is already releasing the hold ("rejecting") or has ended is never moved by it.
 */
export function dealStatusForPayment(status: DealStatus, payment: PaymentRecord): PaymentDrivenStatus | null {
  switch (payment.status) {
    case "voided":
    case "expired":
      return WAITING_ON_FUNDS.has(status) ? "expired" : null;
    case "captured":
      return status === "verified" ? "completed" : null;
    case "failed":
      return status === "verified" || status === "awaiting_payment" ? "failed" : null;
    case "authorized":
      return status === "awaiting_payment" ? "authorized" : null;
    case "none":
    case "created":
    case "approved":
      return null;
    default:
      return assertNever(payment.status);
  }
}

function completedEvent(payment: PaymentRecord): AuditEventInput {
  const releasedMinor = Math.max(0, payment.authorizedMinor - payment.capturedMinor);
  return {
    actor: "system",
    type: "deal.completed",
    title:
      releasedMinor > 0
        ? `Deal completed: ${formatMoney(payment.capturedMinor)} captured, ${formatMoney(releasedMinor)} released`
        : `Deal completed: ${formatMoney(payment.capturedMinor)} captured — the seller is paid`,
    data: { capturedMinor: payment.capturedMinor, releasedMinor, captureId: payment.captureId },
  };
}

/** The plain-language line that explains a status change the payment record forced. */
function paymentDrivenEvents(to: PaymentDrivenStatus, payment: PaymentRecord): AuditEventInput[] {
  const name = providerLabel(payment.provider);
  switch (to) {
    case "expired":
      return [
        {
          actor: "system",
          type: "deal.expired",
          title: `Deal expired: ${name} no longer holds the funds, so nothing can be captured`,
          detail: "The authorization was released or ran out before the deal settled. Nothing was captured.",
          data: { paymentStatus: payment.status, authorizationId: payment.authorizationId },
        },
      ];
    case "completed":
      return [completedEvent(payment)];
    case "failed":
      return [
        {
          actor: "system",
          type: "deal.failed",
          title: `Deal failed: ${name} refused the payment, nothing was captured`,
          data: { paymentStatus: payment.status, issue: payment.lastError?.issue ?? null },
        },
      ];
    case "authorized":
      // Already told by the payment.authorized event that produced the record.
      return [];
    default:
      return assertNever(to);
  }
}

/** Apply {@link dealStatusForPayment} to a deal read under its lease. True when the deal moved. */
async function followPayment(ctx: ServiceContext, graph: DealGraph, now: Date): Promise<boolean> {
  if (graph.payment === null) return false;
  const to = dealStatusForPayment(graph.deal.status, graph.payment);
  if (to === null) return false;
  await commit(ctx, graph.deal, { to, events: paymentDrivenEvents(to, graph.payment), patch: { lastError: null } }, now);
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Payment steps: shared outcomes                                             */
/* -------------------------------------------------------------------------- */

const ORDER_OPERATIONS: readonly PaymentOperationKind[] = ["create_order", "authorize"];
const CAPTURE_OPERATIONS: readonly PaymentOperationKind[] = ["capture"];
const VOID_OPERATIONS: readonly PaymentOperationKind[] = ["void"];

/** True once the ledger shows the operation behind this step has been tried as often as the engine allows. */
async function attemptsExhausted(ctx: ServiceContext, dealId: string, kinds: readonly PaymentOperationKind[]): Promise<boolean> {
  const operations = await listPaymentOperations(ctx.db, dealId);
  return operations.some((operation) => kinds.includes(operation.kind) && operation.attempts >= MAX_PAYMENT_ATTEMPTS);
}

function retryMessage(kind: ProviderKind, error: PaymentError): string {
  return `${providerLabel(kind)} could not complete this step yet (${error.issue}). Nothing changed — retry the step.`;
}

function failureMessage(kind: ProviderKind, error: PaymentError): string {
  return error.retryable
    ? `${providerLabel(kind)} could not complete this step after ${MAX_PAYMENT_ATTEMPTS} attempts (${error.issue}). The deal cannot continue.`
    : `${providerLabel(kind)} refused this step (${error.issue}). The deal cannot continue.`;
}

/**
 * The step stays where it is: keep what the orchestrator learned, tell the owner, change no status.
 * `also` adds what a follow-up attempt found out; `message` replaces the standard "retry" wording.
 */
async function stayPut(
  ctx: ServiceContext,
  graph: DealGraph,
  error: PaymentStepError,
  now: Date,
  also: { message?: string; events?: AuditEventInput[] } = {},
): Promise<void> {
  const message = also.message ?? retryMessage(ctx.provider.kind, error);
  const events = [...error.events, ...(also.events ?? []), problemEvent(message, { issue: error.issue, retryable: true })];
  await commit(
    ctx,
    graph.deal,
    {
      to: graph.deal.status,
      events: withoutRecorded(graph.audit, events),
      patch: { lastError: message },
      rows: (tx) => upsertPayment(tx, graph.deal.id, error.payment),
    },
    now,
  );
}

/**
 * A capture PACT requested was accepted by the provider but has not completed: the orchestrator
 * keeps its id on the record while the payment stays "authorized" with nothing captured. Asking
 * again — same idempotency key, so the provider answers for the capture it already has — is how
 * it is confirmed, and the settlement guard allows exactly that.
 */
function hasPendingCapture(payment: PaymentRecord): boolean {
  return payment.status === "authorized" && payment.capturedMinor === 0 && payment.captureId !== null;
}

/**
 * A deal that has just failed must not leave money on hold. Voids whatever is still voidable and
 * reports what happened; a PayPal problem here is recorded, never thrown, because the deal's
 * failure has to be written either way. When the release does not happen the record is returned
 * as it was — it still describes the hold — and the audit trail says why.
 */
async function releaseHold(ctx: ServiceContext, dealId: string, payment: PaymentRecord, reason: string): Promise<PaymentStepResult> {
  if (!checkVoidAllowed({ dealStatus: "failed", payment }).allowed) return { payment, events: [] };
  try {
    return await voidHeldFunds(paymentDeps(ctx), { dealId, payment, reason });
  } catch (error) {
    if (!(error instanceof PaymentStepError)) throw error;
    const notice = problemEvent(
      `The hold could not be released automatically (${error.issue}); it lapses when the authorization expires`,
      { issue: error.issue, retryable: error.retryable },
    );
    return { payment, events: [...error.events, notice] };
  }
}

interface PaymentFailure {
  payment: PaymentRecord;
  events: AuditEventInput[];
  /** Written to the deal as `lastError`. */
  message: string;
  /** Why the hold is being released, for the provider and the audit trail. Null when releasing it is what failed. */
  releaseReason: string | null;
}

/** Close a deal as failed after a payment problem, releasing whatever is still held. */
async function failDeal(ctx: ServiceContext, graph: DealGraph, failed: PaymentFailure, now: Date): Promise<void> {
  const released =
    failed.releaseReason === null
      ? { payment: failed.payment, events: [] }
      : await releaseHold(ctx, graph.deal.id, failed.payment, failed.releaseReason);
  await commit(
    ctx,
    graph.deal,
    {
      to: "failed",
      events: [...failed.events, ...released.events],
      patch: { lastError: failed.message },
      rows: (tx) => upsertPayment(tx, graph.deal.id, released.payment),
    },
    now,
  );
}

/**
 * A payment step threw. A transient problem leaves the deal where it is (false: nothing ran to
 * completion) until the same operation has been tried MAX_PAYMENT_ATTEMPTS times; anything else
 * closes the deal as failed and releases the hold (true: the deal moved).
 */
async function settlePaymentError(
  ctx: ServiceContext,
  graph: DealGraph,
  error: PaymentStepError,
  kinds: readonly PaymentOperationKind[],
  releaseReason: string | null,
  now: Date,
): Promise<boolean> {
  if (error.retryable && !(await attemptsExhausted(ctx, graph.deal.id, kinds))) {
    await stayPut(ctx, graph, error, now);
    return false;
  }
  const message = failureMessage(ctx.provider.kind, error);
  await failDeal(ctx, graph, { payment: error.payment, events: error.events, message, releaseReason }, now);
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Step: negotiate                                                            */
/* -------------------------------------------------------------------------- */

const MOVE_VERB: Record<MoveAction, string> = {
  offer: "offered",
  counter: "countered with",
  accept: "accepted",
  reject: "walked away",
};
const AGENT_FAILURE: Record<Party, string> = {
  seller: "The seller agent failed to make its move. Nothing changed — retry the step.",
  buyer: "The buyer agent failed to make its move. Nothing changed — retry the step.",
};
const SCRIPTED_META = { source: "scripted", model: null, latencyMs: null } as const;

interface Turn {
  state: NegotiationState;
  move: NegotiationMove;
  degradedReason: string | null;
}

/**
 * Ask the agent whose turn it is, then let the rules engine decide what is recorded. A proposal
 * that is not a legal move at all (malformed terms, accepting nothing) is replaced by the
 * scripted agent's move, which is always legal, and the deal is labelled degraded.
 */
async function takeTurn(ctx: ServiceContext, dealId: string, state: NegotiationState, rules: RulesContext): Promise<Turn> {
  const actor = nextActor(state);
  const proposal = await proposing(dealId, "negotiate", AGENT_FAILURE[actor], () =>
    actor === "seller"
      ? ctx.agents.sellerMove(sellerContextFor(state, rules))
      : ctx.agents.buyerMove(buyerContextFor(state, rules)),
  );
  try {
    return { ...applyMove(state, actor, proposal.move, proposal.meta, rules), degradedReason: proposal.meta.degradedReason };
  } catch (error) {
    if (!(error instanceof InvalidMoveError)) throw error;
    log.warn("step.invalid_move", { dealId, actor, error });
    const scripted =
      actor === "seller" ? scriptedSellerMove(sellerContextFor(state, rules)) : scriptedBuyerMove(buyerContextFor(state, rules));
    return { ...applyMove(state, actor, scripted, SCRIPTED_META, rules), degradedReason: "invalid_move" };
  }
}

function moveEvents(move: NegotiationMove, seller: SellerProfile): AuditEventInput[] {
  const who = move.actor === "seller" ? seller.name : "Buyer agent";
  const price = move.terms === null ? "" : ` ${formatMoney(move.terms.priceMinor)}`;
  const events: AuditEventInput[] = [
    {
      actor: move.actor === "seller" ? "seller_agent" : "buyer_agent",
      type: "negotiation.move",
      title: `${who} ${MOVE_VERB[move.action]}${price}`,
      detail: move.message,
      data: { seq: move.seq, action: move.action, priceMinor: move.terms?.priceMinor ?? null, source: move.source, model: move.model },
    },
  ];
  if (move.guardrails.length > 0) {
    events.push({
      actor: "system",
      type: "negotiation.guardrail",
      title: `Negotiation rules corrected the ${move.actor} agent's move`,
      detail: move.guardrails.map((note) => note.detail).join(" "),
      data: { seq: move.seq, codes: move.guardrails.map((note) => note.code) },
    });
  }
  return events;
}

/** What a recorded move means for the deal: still open, agreed, or over. */
function negotiationOutcome(state: NegotiationState): Pick<StepWrite, "to" | "events" | "patch"> {
  switch (state.status) {
    case "open":
      return { to: "negotiating", events: [], patch: {} };
    case "agreed": {
      if (state.agreedTerms === null) throw new Error("An agreed negotiation carries no terms");
      return {
        to: "agreed",
        events: [
          {
            actor: "system",
            type: "negotiation.agreed",
            title: `Terms agreed at ${formatMoney(state.agreedTerms.priceMinor)} in ${plural(state.moves.length, "move")}`,
            data: { ...state.agreedTerms, moves: state.moves.length },
          },
        ],
        patch: { negotiationStatus: "agreed", agreedTerms: state.agreedTerms },
      };
    }
    case "failed": {
      const reason = state.failureReason ?? "The agents could not agree";
      return {
        to: "negotiation_failed",
        events: [{ actor: "system", type: "negotiation.failed", title: `No agreement: ${reason}`, data: { moves: state.moves.length } }],
        patch: { negotiationStatus: "failed", negotiationFailure: reason },
      };
    }
    default:
      return assertNever(state.status);
  }
}

async function negotiateStep(ctx: ServiceContext, graph: DealGraph, now: Date): Promise<boolean> {
  const { deal } = graph;
  const seller = sellerOf(graph);
  // The agent is briefed, and its move judged, against the same mandate, seller and instant.
  const rules: RulesContext = { mandate: mandateOf(graph), seller, now };
  const state: NegotiationState = { status: "open", moves: graph.moves, agreedTerms: null, failureReason: null };
  const turn = await takeTurn(ctx, deal.id, state, rules);
  const outcome = negotiationOutcome(turn.state);
  await commit(
    ctx,
    deal,
    {
      to: outcome.to,
      events: [...moveEvents(turn.move, seller), ...outcome.events, ...degradedEvents(graph.audit, "negotiate", turn.degradedReason)],
      patch: { ...outcome.patch, aiDegraded: deal.aiDegraded || turn.degradedReason !== null, lastError: null },
      rows: (tx) => insertMove(tx, deal.id, turn.move),
    },
    now,
  );
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Step: contract                                                             */
/* -------------------------------------------------------------------------- */

async function contractStep(ctx: ServiceContext, graph: DealGraph, now: Date): Promise<boolean> {
  const { deal } = graph;
  if (deal.agreedTerms === null) throw broken(deal.id, "terms are agreed but not stored");
  const seller = sellerOf(graph);
  // The confidence thresholds in force now are copied into the contract; a later policy edit cannot change them.
  const policy = await effectivePolicy(ctx.db, deal.owner);
  let signed: SignedContract;
  try {
    signed = compileContract({ dealId: deal.id, contractId: newId("ctr"), mandate: mandateOf(graph), terms: deal.agreedTerms, seller, policy, now });
  } catch (error) {
    if (!(error instanceof ZodError) && !(error instanceof RangeError)) throw error;
    log.error("step.contract_failed", { dealId: deal.id, error });
    throw new StepFailure("The agreed terms could not be compiled into a valid contract.", { cause: error });
  }
  const { contract } = signed;
  await commit(
    ctx,
    deal,
    {
      to: "contracted",
      events: [
        {
          actor: "contract_engine",
          type: "contract.created",
          title: `Contract ${contract.contractId} compiled and hashed`,
          detail: `${formatMoney(contract.price.amountMinor)} to ${contract.seller.name}, payable only after ${plural(contract.verificationRules.length, "condition")} are verified.`,
          data: {
            contractId: contract.contractId,
            termsHash: signed.termsHash,
            priceMinor: contract.price.amountMinor,
            rules: contract.verificationRules.length,
          },
        },
      ],
      patch: { priceMinor: contract.price.amountMinor, deadline: contract.deadline, revisionLimit: contract.revisionLimit, lastError: null },
      rows: (tx) => insertContract(tx, signed),
    },
    now,
  );
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Step: policy                                                               */
/* -------------------------------------------------------------------------- */

const POLICY_HEADLINE: Record<PolicyEvaluation["outcome"], string> = {
  allow: "Spending policy: within every limit",
  needs_approval: "Spending policy: a human must approve this spend",
  block: "Spending policy: blocked",
};

function policyEvent(evaluation: PolicyEvaluation, headline = POLICY_HEADLINE[evaluation.outcome]): AuditEventInput {
  const flagged = evaluation.checks.filter((check) => check.outcome !== "pass");
  return {
    actor: "policy_engine",
    type: "policy.evaluated",
    title: headline,
    detail: flagged.length === 0 ? null : flagged.map((check) => check.detail).join(" "),
    data: { outcome: evaluation.outcome, flagged: flagged.map((check) => check.id), spentTodayMinor: evaluation.spentTodayMinor },
  };
}

function evaluateSpend(policy: Policy, signed: SignedContract, seller: SellerProfile, committedMinor: number, now: Date): PolicyEvaluation {
  const { contract } = signed;
  return evaluatePolicy(policy, {
    amountMinor: contract.price.amountMinor,
    category: contract.category,
    seller,
    spentTodayMinor: committedMinor,
    now,
  });
}

async function policyStep(ctx: ServiceContext, graph: DealGraph, now: Date): Promise<boolean> {
  const { deal } = graph;
  const policy = await effectivePolicy(ctx.db, deal.owner);
  const committedMinor = await committedSpendToday(ctx.db, deal.owner, now, { excludeDealId: deal.id });
  const evaluation = evaluateSpend(policy, signedOf(graph), sellerOf(graph), committedMinor, now);
  const patch = { policyEvaluation: evaluation, lastError: null };
  switch (evaluation.outcome) {
    case "allow":
      await commit(ctx, deal, { to: "payment_pending", events: [policyEvent(evaluation)], patch }, now);
      return true;
    case "needs_approval": {
      const request: AuditEventInput = {
        actor: "policy_engine",
        type: "policy.approval_requested",
        title: "Waiting for a human to approve this spend",
      };
      await commit(ctx, deal, { to: "awaiting_approval", events: [policyEvent(evaluation), request], patch }, now);
      return true;
    }
    case "block":
      await commit(ctx, deal, { to: "blocked", events: [policyEvent(evaluation)], patch }, now);
      return true;
    default:
      return assertNever(evaluation.outcome);
  }
}

/* -------------------------------------------------------------------------- */
/*  Step: order                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Where a deal goes when the daily limit, re-checked under the owner's lock immediately before
 * the order, no longer has room for it: blocked by policy, exactly as if the limit had refused
 * it at signing. The stored policy evaluation and the audit trail carry the figures.
 */
const SPEND_REFUSED_STATUS: DealStatus = "blocked";
const SPEND_REFUSED_MESSAGE = "Blocked by the daily spending limit: other deals committed the remaining budget first.";

/** The vault id of the wallet this owner's agent may pay from, or null for interactive approval. Never leaves the server. */
async function delegatedVaultId(ctx: ServiceContext, owner: string): Promise<string | null> {
  for (const walletOwner of [owner, DEMO_WALLET_OWNER]) {
    const wallet = await getWallet(ctx.db, walletOwner);
    // A vault id only means something to the provider that issued it.
    if (wallet?.status === "active" && wallet.vaultId !== null && wallet.provider === ctx.provider.kind) return wallet.vaultId;
  }
  return null;
}

/**
 * Check the daily limit and commit the spend as one indivisible action per owner.
 *
 * The policy was evaluated when the contract was signed, but money is only held now — and
 * another deal of the same owner may have taken the remaining budget in between. Under the
 * owner's lock the committed total is read again (including every other open order), the policy
 * engine is asked again, and either the deal is refused or a payment row is inserted as its
 * reservation. That row is what the next deal of this owner will count.
 *
 * Only the daily limit is re-judged: the other checks were settled at signing (and, where
 * needed, approved by a human), and a later policy edit does not reach back into a signed deal.
 *
 * @returns false when the deal was refused and closed.
 */
async function reserveSpend(ctx: ServiceContext, graph: DealGraph, mode: ApprovalMode, now: Date): Promise<boolean> {
  const { deal } = graph;
  const signed = signedOf(graph);
  const seller = sellerOf(graph);
  const policy = await effectivePolicy(ctx.db, deal.owner);
  return withTransaction(ctx.db, async (tx) => {
    await lockOwnerSpend(tx, deal.owner);
    const committedMinor = await committedSpendToday(tx, deal.owner, now, { excludeDealId: deal.id });
    const evaluation = evaluateSpend(policy, signed, seller, committedMinor, now);
    const overLimit = evaluation.checks.some((check) => check.id === "daily_limit" && check.outcome === "block");
    if (!overLimit) {
      if ((await getPayment(tx, deal.id)) === null) {
        await upsertPayment(tx, deal.id, newPaymentRecord(ctx.provider.kind, mode, signed.contract.price.amountMinor, now));
      }
      return true;
    }
    assertTransition(deal.status, SPEND_REFUSED_STATUS);
    await appendAudit(tx, deal.id, [policyEvent(evaluation, "Spending policy: blocked by the daily limit before the order")], now);
    const patch = { status: SPEND_REFUSED_STATUS, policyEvaluation: evaluation, lastError: SPEND_REFUSED_MESSAGE, updatedAt: now.toISOString() };
    if ((await updateDeal(tx, deal.id, deal.version, patch)) === null) throw staleDeal();
    return false;
  });
}

/** Where the deal stands once the order step has a definite answer from the provider. */
function statusAfterOrder(dealId: string, payment: PaymentRecord): DealStatus {
  switch (payment.status) {
    case "created":
    case "approved":
      return "awaiting_payment";
    case "authorized":
      return "authorized";
    case "failed":
    case "voided":
    case "expired":
      return "failed";
    case "none":
    case "captured":
      throw broken(dealId, `opening the order left the payment ${payment.status}`);
    default:
      return assertNever(payment.status);
  }
}

async function orderStep(ctx: ServiceContext, graph: DealGraph, appUrl: string, now: Date): Promise<boolean> {
  const { deal } = graph;
  const signed = signedOf(graph);
  const vaultId = await delegatedVaultId(ctx, deal.owner);
  if (!(await reserveSpend(ctx, graph, vaultId === null ? "interactive" : "delegated", now))) return true;

  let step: PaymentStepResult;
  try {
    step = await openOrder(paymentDeps(ctx), {
      dealId: deal.id,
      signed,
      // The return is never trusted: it only prompts PACT to ask the provider what happened.
      returnUrl: `${appUrl}/api/paypal/return?deal=${deal.id}`,
      cancelUrl: `${appUrl}/api/paypal/cancel?deal=${deal.id}`,
      ...(vaultId === null ? {} : { vaultId }),
    });
  } catch (error) {
    if (!(error instanceof PaymentStepError)) throw error;
    return settlePaymentError(ctx, graph, error, ORDER_OPERATIONS, "The order could not be completed, so it was abandoned.", now);
  }

  const to = statusAfterOrder(deal.id, step.payment);
  const lastError = to === "failed" ? `${providerLabel(ctx.provider.kind)} would not open the order. The deal cannot continue.` : null;
  await commit(ctx, deal, { to, events: step.events, patch: { lastError }, rows: (tx) => upsertPayment(tx, deal.id, step.payment) }, now);
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Step: fulfill                                                              */
/* -------------------------------------------------------------------------- */

const DELIVERY_FAILURE = "The seller agent failed to produce the delivery. Nothing changed — retry the step.";

/**
 * The files as they will be stored, shown and served, and how many of them had to be changed.
 *
 * A deliverable is seller-supplied content. The built-in studio sanitises what it produces, but
 * the engine does not take a seller's word for it: every SVG passes the allowlist again here, so
 * nothing with script, event handlers, external references or styles can reach storage whichever
 * agent delivered it. Verification then judges exactly the bytes the buyer will receive.
 *
 * @throws when a file is not usable SVG at all — an agent that returns such a file has not delivered.
 */
function sanitizeDelivered(artifacts: readonly Artifact[]): { artifacts: Artifact[]; altered: number } {
  let altered = 0;
  const safe = artifacts.map((artifact) => {
    if (artifact.kind !== "illustration") return artifact;
    const clean = sanitizeSvg(artifact.svg);
    if (!clean.ok) throw new Error(`Illustration #${artifact.index} (${artifact.aspectRatio}) is not usable SVG: ${clean.reason}`);
    if (clean.svg === artifact.svg) return artifact;
    altered += 1;
    return { ...artifact, svg: clean.svg };
  });
  return { artifacts: safe, altered };
}

async function fulfillStep(ctx: ServiceContext, graph: DealGraph, now: Date): Promise<boolean> {
  const { deal } = graph;
  const { contract } = signedOf(graph);
  const seller = sellerOf(graph);
  const round = graph.submissions.length + 1;

  const { submission, altered, degradedReason } = await proposing(deal.id, "fulfill", DELIVERY_FAILURE, async () => {
    const delivery = await ctx.agents.produceDelivery({
      contract,
      seller,
      round,
      previousReport: latest(graph.reports),
      previousSubmission: latest(graph.submissions),
      now,
    });
    // Parsing and sanitising belong to the same failure domain: an agent that returns unusable files has not delivered.
    const parsed: Submission = SubmissionSchema.parse({
      id: newId("sub"),
      dealId: deal.id,
      round,
      artifacts: delivery.artifacts,
      note: delivery.note,
      source: delivery.meta.source,
      model: delivery.meta.model,
      submittedAt: now.toISOString(),
    } satisfies Submission);
    const safe = sanitizeDelivered(parsed.artifacts);
    return { submission: { ...parsed, artifacts: safe.artifacts }, altered: safe.altered, degradedReason: delivery.meta.degradedReason };
  });

  const delivered: AuditEventInput = {
    actor: "seller_agent",
    type: "delivery.submitted",
    title: `${seller.name} delivered ${plural(submission.artifacts.length, "file")} (round ${round})`,
    // Said out loud: a seller whose files needed cleaning tried to deliver something PACT does not store.
    detail: altered === 0 ? null : `PACT removed active or unsupported content from ${plural(altered, "file")} before storing ${altered === 1 ? "it" : "them"}.`,
    data: {
      submissionId: submission.id,
      round,
      artifacts: submission.artifacts.length,
      sanitizedFiles: altered,
      source: submission.source,
      model: submission.model,
    },
  };
  await commit(
    ctx,
    deal,
    {
      to: "submitted",
      events: [delivered, ...degradedEvents(graph.audit, "fulfill", degradedReason)],
      patch: { aiDegraded: deal.aiDegraded || degradedReason !== null, lastError: null },
      rows: (tx) => insertSubmission(tx, submission),
    },
    now,
  );
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Step: verify                                                               */
/* -------------------------------------------------------------------------- */

const VERIFICATION_FAILURE = "Verification could not be completed. Nothing changed — retry the step.";

const STATUS_AFTER_VERIFICATION: Record<VerificationReport["decision"], DealStatus> = {
  capture_eligible: "verified",
  revision_required: "revision_required",
  human_review: "in_review",
  reject: "rejecting",
};

/** What follows from the computed decision, in the words the audit trail shows. */
function decisionEvents(report: VerificationReport, revisionsUsed: number, revisionLimit: number): AuditEventInput[] {
  switch (report.decision) {
    case "capture_eligible":
      return [];
    case "revision_required":
      return [
        {
          actor: "system",
          type: "revision.requested",
          title: `Sent back to the seller for revision ${revisionsUsed} of ${revisionLimit} — nothing is captured`,
          data: { reportId: report.id, failedRuleIds: report.failedRuleIds },
        },
      ];
    case "human_review":
      return [
        {
          actor: "system",
          type: "verification.review_requested",
          title: "A human must review this delivery — the funds stay held, nothing is captured",
          data: { reportId: report.id, degraded: report.degraded },
        },
      ];
    case "reject":
      return [];
    default:
      return assertNever(report.decision);
  }
}

async function verifyStep(ctx: ServiceContext, graph: DealGraph, now: Date): Promise<boolean> {
  const { deal } = graph;
  const signed = signedOf(graph);
  const submission = latest(graph.submissions);
  if (submission === null) throw broken(deal.id, "it is submitted but has no submission");

  const { report, degradedReason } = await proposing(deal.id, "verify", VERIFICATION_FAILURE, async () => {
    const aiRules = signed.contract.verificationRules.filter((rule) => rule.evaluator === "ai");
    const ai = await ctx.agents.evaluateAiRules({ contract: signed.contract, rules: aiRules, submission });
    // The model's checks are one input. The decision is computed by the verification engine.
    const built = buildReport({
      id: newId("rep"),
      signed,
      submission,
      checks: [...runDeterministicChecks(signed.contract, submission), ...ai.checks],
      revisionsUsed: submission.round - 1,
      manipulationSuspected: ai.flags.manipulationSuspected,
      degraded: ai.meta.degradedReason !== null,
      model: ai.meta.model,
      now,
    });
    return { report: built, degradedReason: ai.meta.degradedReason };
  });

  const revisionsUsed = deal.revisionsUsed + (report.decision === "revision_required" ? 1 : 0);
  const completed: AuditEventInput = {
    actor: "verifier",
    type: "verification.completed",
    title: report.summary,
    data: {
      reportId: report.id,
      round: report.round,
      decision: report.decision,
      failedRuleIds: report.failedRuleIds,
      confidence: report.confidence,
      degraded: report.degraded,
    },
  };
  await commit(
    ctx,
    deal,
    {
      to: STATUS_AFTER_VERIFICATION[report.decision],
      events: [
        completed,
        ...decisionEvents(report, revisionsUsed, signed.contract.revisionLimit),
        ...degradedEvents(graph.audit, "verify", degradedReason),
      ],
      patch: { revisionsUsed, aiDegraded: deal.aiDegraded || degradedReason !== null, lastError: null },
      rows: (tx) => insertReport(tx, report),
    },
    now,
  );
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Step: capture                                                              */
/* -------------------------------------------------------------------------- */

const CAPTURE_PENDING_MESSAGE = "The capture is pending at the payment provider. The seller is not paid yet — retry in a moment.";
const HOLD_RELEASED_AFTER_CAPTURE_FAILURE = "The capture could not be completed, so the authorization was released.";

function blockedEvent(violations: readonly GuardViolation[]): AuditEventInput {
  return {
    actor: "system",
    type: "payment.capture_blocked",
    title: `Capture blocked by the settlement guard: ${violations.map((violation) => violation.code).join(", ")}`,
    detail: violations.map((violation) => violation.detail).join(" "),
    data: { violations: violations.map((violation) => violation.code) },
  };
}

/**
 * The guard only objects to the authorization's age. Ask the provider: if it confirms the hold
 * is gone, the deal has expired — that is not a failure of anyone's making.
 */
async function expireIfLapsed(ctx: ServiceContext, graph: DealGraph, payment: PaymentRecord, now: Date): Promise<boolean | null> {
  let checked: PaymentStepResult;
  try {
    checked = await reconcile(paymentDeps(ctx), { dealId: graph.deal.id, payment });
  } catch (error) {
    if (!(error instanceof PaymentStepError)) throw error;
    if (!error.retryable) return null;
    await stayPut(ctx, graph, error, now);
    return false;
  }
  if (dealStatusForPayment(graph.deal.status, checked.payment) !== "expired") return null;
  await commit(
    ctx,
    graph.deal,
    {
      to: "expired",
      events: [...checked.events, ...paymentDrivenEvents("expired", checked.payment)],
      patch: { lastError: null },
      rows: (tx) => upsertPayment(tx, graph.deal.id, checked.payment),
    },
    now,
  );
  return true;
}

/** The settlement guard said no. Nothing is sent to the provider for a capture; the deal fails and the hold is released. */
async function refuseCapture(ctx: ServiceContext, graph: DealGraph, violations: GuardViolation[], now: Date): Promise<boolean> {
  const { deal, payment } = graph;
  const onlyExpiry = violations.length > 0 && violations.every((violation) => violation.code === "authorization_expired");
  if (payment !== null && onlyExpiry) {
    const expired = await expireIfLapsed(ctx, graph, payment, now);
    if (expired !== null) return expired;
  }
  const message = "Capture was blocked by the settlement guard. Nothing was captured.";
  if (payment === null) {
    await commit(ctx, deal, { to: "failed", events: [blockedEvent(violations)], patch: { lastError: message } }, now);
    return true;
  }
  const releaseReason = "Capture was blocked by the settlement guard, so the authorization was released.";
  await failDeal(ctx, graph, { payment, events: [blockedEvent(violations)], message, releaseReason }, now);
  return true;
}

/** The provider said the authorization was captured but does not show it: nobody knows yet whether money moved. */
const CAPTURE_STATE_UNKNOWN = "CAPTURE_STATE_UNKNOWN";

/**
 * A capture whose outcome is unknown — no attempt got an answer, or the answers contradict each
 * other — must not be written off as failed: one of those requests may have reached the provider,
 * and then the seller is paid. Releasing the hold is the test. If the provider voids the
 * authorization, nothing was captured and the deal has failed. If it refuses (a captured
 * authorization cannot be voided) or cannot be reached either, the deal stays verified: the next
 * attempt asks again with the same idempotency key, the provider answers for the capture it may
 * already hold, and its webhook says the same.
 */
async function abandonCapture(ctx: ServiceContext, graph: DealGraph, error: PaymentStepError, now: Date): Promise<boolean> {
  const { deal } = graph;
  const unconfirmed = (why: string): string =>
    `${providerLabel(ctx.provider.kind)} has not confirmed the capture and did not release the hold (${why}). Whether the seller was paid is not known yet — retry the step.`;
  // Judged as the release that would close the deal as failed, like every other release on failure.
  const guard = checkVoidAllowed({ dealStatus: "failed", payment: error.payment });
  if (!guard.allowed) {
    await stayPut(ctx, graph, error, now, { message: unconfirmed(guard.violations.map((violation) => violation.code).join(", ")) });
    return false;
  }
  let released: PaymentStepResult;
  try {
    released = await voidHeldFunds(paymentDeps(ctx), { dealId: deal.id, payment: error.payment, reason: HOLD_RELEASED_AFTER_CAPTURE_FAILURE });
  } catch (voidError) {
    if (!(voidError instanceof PaymentStepError)) throw voidError;
    await stayPut(ctx, graph, error, now, { message: unconfirmed(voidError.issue), events: voidError.events });
    return false;
  }
  await commit(
    ctx,
    deal,
    {
      to: "failed",
      events: [...error.events, ...released.events],
      patch: { lastError: failureMessage(ctx.provider.kind, error) },
      rows: (tx) => upsertPayment(tx, deal.id, released.payment),
    },
    now,
  );
  return true;
}

/** Persist what a capture attempt that returned (rather than threw) means for the deal. */
async function settleCapture(ctx: ServiceContext, graph: DealGraph, held: PaymentRecord, step: PaymentStepResult, now: Date): Promise<boolean> {
  const { deal } = graph;
  const to = dealStatusForPayment(deal.status, step.payment);
  const save = (tx: Db): Promise<void> => upsertPayment(tx, deal.id, step.payment);
  switch (to) {
    case "completed":
      await commit(ctx, deal, { to, events: [...step.events, completedEvent(step.payment)], patch: { lastError: null }, rows: save }, now);
      return true;
    case "expired":
      await commit(ctx, deal, { to, events: [...step.events, ...paymentDrivenEvents(to, step.payment)], patch: { lastError: null }, rows: save }, now);
      return true;
    case "failed": {
      // The provider refused the capture for good. The record the capture was made from is still the hold to release.
      const message = `${providerLabel(ctx.provider.kind)} refused the capture. Nothing was captured.`;
      const failure = { payment: held, events: step.events, message, releaseReason: HOLD_RELEASED_AFTER_CAPTURE_FAILURE };
      await failDeal(ctx, graph, failure, now);
      return true;
    }
    case null:
      if (step.payment.status !== "authorized") throw broken(deal.id, `a capture attempt left the payment ${step.payment.status}`);
      // Accepted but not completed: the funds stay authorized and the deal stays verified.
      await commit(
        ctx,
        deal,
        { to: deal.status, events: withoutRecorded(graph.audit, step.events), patch: { lastError: CAPTURE_PENDING_MESSAGE }, rows: save },
        now,
      );
      return false;
    case "authorized":
      throw broken(deal.id, "a capture attempt cannot return a deal to authorized");
    default:
      return assertNever(to);
  }
}

async function captureStep(ctx: ServiceContext, graph: DealGraph, now: Date): Promise<boolean> {
  const { deal } = graph;
  const report = latest(graph.reports);
  // Everything is re-read from storage and must agree independently, or no money moves.
  const guard = checkCaptureAllowed({
    dealStatus: deal.status,
    signed: graph.signed,
    payment: graph.payment,
    latestReport: report,
    humanDecision: deal.humanDecision,
    now,
  });
  if (!guard.allowed) return refuseCapture(ctx, graph, guard.violations, now);
  // The guard only allows a capture when contract, payment and report all exist.
  const signed = signedOf(graph);
  const payment = paymentOf(graph);
  if (report === null) throw broken(deal.id, "the guard allowed a capture without a report");
  let step: PaymentStepResult;
  try {
    step = await captureVerified(paymentDeps(ctx), {
      dealId: deal.id,
      signed,
      payment,
      // The amount comes from the guard (contract price, or the human's recorded partial release) — never from a caller.
      amountMinor: guard.amountMinor,
      reportId: report.id,
    });
  } catch (error) {
    if (!(error instanceof PaymentStepError)) throw error;
    if (error.retryable) {
      // No answer yet. Never give up on a capture the provider has already accepted — it may
      // still complete, and its webhook or a later retry will say so — nor before the attempts run out.
      if (hasPendingCapture(error.payment) || !(await attemptsExhausted(ctx, deal.id, CAPTURE_OPERATIONS))) {
        await stayPut(ctx, graph, error, now);
        return false;
      }
      return abandonCapture(ctx, graph, error, now);
    }
    if (error.issue === CAPTURE_STATE_UNKNOWN) return abandonCapture(ctx, graph, error, now);
    // The provider answered, and the answer is no: nothing was captured, so the hold is released.
    return settlePaymentError(ctx, graph, error, CAPTURE_OPERATIONS, HOLD_RELEASED_AFTER_CAPTURE_FAILURE, now);
  }
  return settleCapture(ctx, graph, payment, step, now);
}

/* -------------------------------------------------------------------------- */
/*  Step: void                                                                 */
/* -------------------------------------------------------------------------- */

function rejectionReason(graph: DealGraph): string {
  if (graph.deal.humanDecision?.kind === "reject_delivery") return "The delivery was rejected at human review.";
  const report = latest(graph.reports);
  return report ? `The delivery failed verification: ${report.summary}` : "The delivery was rejected.";
}

function rejectedEvent(detail: string): AuditEventInput {
  return { actor: "system", type: "deal.rejected", title: "Deal rejected: the hold is released, nothing was captured", detail };
}

async function voidStep(ctx: ServiceContext, graph: DealGraph, now: Date): Promise<boolean> {
  const { deal } = graph;
  const payment = paymentOf(graph);
  const reason = rejectionReason(graph);
  if (payment.status === "voided" || payment.status === "expired") {
    // The provider released the hold on its own; there is nothing left to void.
    await commit(ctx, deal, { to: "rejected", events: [rejectedEvent(reason)], patch: { lastError: null } }, now);
    return true;
  }
  const guard = checkVoidAllowed({ dealStatus: deal.status, payment });
  if (!guard.allowed) {
    const message = "The authorization could not be voided. The deal is closed without a release.";
    const refused = problemEvent(message, { violations: guard.violations.map((violation) => violation.code) });
    await commit(ctx, deal, { to: "failed", events: [refused], patch: { lastError: message } }, now);
    return true;
  }
  let step: PaymentStepResult;
  try {
    step = await voidHeldFunds(paymentDeps(ctx), { dealId: deal.id, payment, reason });
  } catch (error) {
    if (!(error instanceof PaymentStepError)) throw error;
    // Releasing the hold is the step that failed, so there is no second release to attempt.
    return settlePaymentError(ctx, graph, error, VOID_OPERATIONS, null, now);
  }
  await commit(
    ctx,
    deal,
    { to: "rejected", events: [...step.events, rejectedEvent(reason)], patch: { lastError: null }, rows: (tx) => upsertPayment(tx, deal.id, step.payment) },
    now,
  );
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Advancing                                                                  */
/* -------------------------------------------------------------------------- */

type StepRun = { step: StepKind; run: () => Promise<boolean> };

/** The one automatic step a deal's status calls for, or null at a human gate and at the end. */
function stepFor(ctx: ServiceContext, graph: DealGraph, appUrl: string, now: Date): StepRun | null {
  const { status } = graph.deal;
  switch (status) {
    case "negotiating":
      return { step: "negotiate", run: () => negotiateStep(ctx, graph, now) };
    case "agreed":
      return { step: "contract", run: () => contractStep(ctx, graph, now) };
    case "contracted":
      return { step: "policy", run: () => policyStep(ctx, graph, now) };
    case "payment_pending":
      return { step: "order", run: () => orderStep(ctx, graph, appUrl, now) };
    case "authorized":
    case "revision_required":
      return { step: "fulfill", run: () => fulfillStep(ctx, graph, now) };
    case "submitted":
      return { step: "verify", run: () => verifyStep(ctx, graph, now) };
    case "verified":
      return { step: "capture", run: () => captureStep(ctx, graph, now) };
    case "rejecting":
      return { step: "void", run: () => voidStep(ctx, graph, now) };
    case "awaiting_approval":
    case "awaiting_payment":
    case "in_review":
    case "completed":
    case "rejected":
    case "declined":
    case "blocked":
    case "negotiation_failed":
    case "cancelled":
    case "expired":
    case "failed":
      return null;
    default:
      return assertNever(status);
  }
}

/**
 * Run the step the deal calls for, on state read under the lease. Returns the step when it ran
 * to completion, null when nothing ran or the step could not move the deal on (the reason is
 * then in the deal's `lastError`, and the same call can simply be made again).
 */
async function runStep(ctx: ServiceContext, dealId: string, appUrl: string): Promise<StepKind | null> {
  const now = ctx.now();
  const graph = await loadGraph(ctx.db, dealId);
  // What the payment record already says comes first: a hold that is gone ends the deal here.
  if (await followPayment(ctx, graph, now)) return null;
  const step = stepFor(ctx, graph, appUrl, now);
  if (step === null) return null;
  try {
    return (await step.run()) ? step.step : null;
  } catch (error) {
    if (!(error instanceof StepFailure)) throw error;
    await recordFailure(ctx, graph, error.message, now);
    return null;
  }
}

/** PayPal is told to send the payer back here, so it has to be a web address — nothing else is assumed about it. */
function assertAppUrl(appUrl: string): void {
  if (!URL.canParse(appUrl) || !/^https?:$/.test(new URL(appUrl).protocol)) {
    throw invalid("The application URL is not a valid web address.");
  }
}

/**
 * Execute at most one automatic step of the deal.
 *
 * `executed` names the step that ran. It is null — with `busy: false` — at a human gate, at the
 * end of a deal, and when a step could not complete (see the deal's `lastError`; calling again
 * retries it). `busy: true` means another request holds the deal's lease: poll again.
 *
 * @throws ApiError 404 (unknown deal), 403 (not the owner), 429, 409 (the deal changed under the step).
 */
export async function advanceDeal(ctx: ServiceContext, sessionId: string, dealId: string, appUrl: string): Promise<AdvanceResponse> {
  const deal = await loadDeal(ctx.db, dealId);
  assertOwner(deal, sessionId);
  assertAppUrl(appUrl);
  await limitSession(ctx, RATE_LIMITS.advancePerSession, sessionId);

  // A cheap first look; the step itself re-reads everything once it holds the lease.
  if (!isAuto(deal.status)) return { deal: await getDealView(ctx, sessionId, dealId), executed: null, busy: false };
  const lockId = await takeLease(ctx, dealId);
  if (lockId === null) return { deal: await getDealView(ctx, sessionId, dealId), executed: null, busy: true };
  const executed = await underLease(ctx, dealId, lockId, () => runStep(ctx, dealId, appUrl));
  const view = await getDealView(ctx, sessionId, dealId);
  log.info("deal.step", { dealId, from: deal.status, executed, status: view.status });
  return { deal: view, executed, busy: false };
}

/* -------------------------------------------------------------------------- */
/*  Human decisions                                                            */
/* -------------------------------------------------------------------------- */

/** The decision as it is stored: kind checked, percentage only where it means something, reason cleaned. */
function parseDecision(decision: DecisionRequest, now: Date): HumanDecision {
  const kind = HumanDecisionKindSchema.safeParse(decision.kind);
  if (!kind.success) throw invalid("Unknown decision.");
  let percent: number | null = null;
  if (kind.data === "release_partial") {
    if (decision.percent === undefined || !Number.isInteger(decision.percent) || decision.percent < 1 || decision.percent > 99) {
      throw invalid("A partial release needs a whole percentage between 1 and 99.");
    }
    percent = decision.percent;
  }
  return { kind: kind.data, percent, reason: sanitizeReason(decision.reason), decidedAt: now.toISOString() };
}

/** A decision counts only at the gate it belongs to, and only while that gate is open. */
function assertGateOpen(graph: DealGraph, choice: HumanDecision): void {
  const { deal } = graph;
  const next = nextStepFor({
    status: deal.status,
    nextNegotiator: null,
    revisionsUsed: deal.revisionsUsed,
    revisionLimit: deal.revisionLimit ?? 0,
  });
  if (next.kind !== "human" || !next.options.includes(choice.kind)) {
    throw conflict("That decision is not available at this stage of the deal.");
  }
}

function humanEvent(type: AuditEventInput["type"], title: string, choice: HumanDecision, data: Record<string, unknown> = {}): AuditEventInput {
  return { actor: "human", type, title, detail: choice.reason, data: { kind: choice.kind, ...data } };
}

/** Releasing is only ever an answer to "a human must decide". A failed verification has no release. */
function releaseOutcome(graph: DealGraph, choice: HumanDecision): StepWrite {
  const report = latest(graph.reports);
  const signed = signedOf(graph);
  if (report === null || report.decision !== "human_review") {
    throw conflict("This delivery did not pass verification and cannot be released.");
  }
  const priceMinor = signed.contract.price.amountMinor;
  const title =
    choice.percent === null
      ? `You released the full payment of ${formatMoney(priceMinor)}`
      : `You released ${choice.percent}% of ${formatMoney(priceMinor)}; the rest returns to the payer`;
  return {
    to: "verified",
    events: [humanEvent("human.released_payment", title, choice, { percent: choice.percent, reportId: report.id })],
    patch: { humanDecision: choice, lastError: null },
  };
}

function revisionOutcome(graph: DealGraph, choice: HumanDecision): StepWrite {
  const revisionsUsed = graph.deal.revisionsUsed + 1;
  const limit = graph.deal.revisionLimit ?? 0;
  return {
    to: "revision_required",
    events: [
      humanEvent("human.requested_revision", "You sent the delivery back for a revision", choice),
      { actor: "system", type: "revision.requested", title: `Sent back to the seller for revision ${revisionsUsed} of ${limit} — nothing is captured` },
    ],
    patch: { humanDecision: choice, revisionsUsed, lastError: null },
  };
}

/**
 * The payer backs out before approving. The order is abandoned at the provider — which is asked
 * whether anything is held on it, and voids it if so — unless the record already says nothing can be.
 */
async function cancelOutcome(ctx: ServiceContext, graph: DealGraph, choice: HumanDecision): Promise<StepWrite> {
  const { deal, payment } = graph;
  const cancelled = humanEvent("payment.cancelled", "You cancelled the payment before approving it", choice);
  const patch = { humanDecision: choice, lastError: null };
  if (payment === null || !checkVoidAllowed({ dealStatus: deal.status, payment }).allowed) {
    return { to: "cancelled", events: [cancelled], patch };
  }
  // A PayPal problem surfaces to the caller as it is: nothing has been written, so the click can be repeated.
  const step = await voidHeldFunds(paymentDeps(ctx), { dealId: deal.id, payment, reason: "The payer cancelled before approving the order." });
  return { to: "cancelled", events: [cancelled, ...step.events], patch, rows: (tx) => upsertPayment(tx, deal.id, step.payment) };
}

async function decisionOutcome(ctx: ServiceContext, graph: DealGraph, choice: HumanDecision): Promise<StepWrite> {
  const patch = { humanDecision: choice, lastError: null };
  switch (choice.kind) {
    case "approve_spend":
      return { to: "payment_pending", events: [humanEvent("human.approved_spend", "You approved this spend", choice)], patch };
    case "decline_spend":
      return { to: "declined", events: [humanEvent("human.declined_spend", "You declined this spend — nothing was authorized", choice)], patch };
    case "cancel_payment":
      return cancelOutcome(ctx, graph, choice);
    case "release_payment":
    case "release_partial":
      return releaseOutcome(graph, choice);
    case "request_revision":
      return revisionOutcome(graph, choice);
    case "reject_delivery":
      return {
        to: "rejecting",
        events: [humanEvent("human.rejected_delivery", "You rejected the delivery — the hold will be released", choice)],
        patch,
      };
    default:
      return assertNever(choice.kind);
  }
}

/**
 * Record a human's decision at a gate. The decision carries a kind (and, for a partial release,
 * a percentage): no amount, no status. What it leads to is decided here, and a release still has
 * to pass the settlement guard before any money moves.
 *
 * @throws ApiError 404, 403 (not the owner), 400 (malformed), 409 (wrong gate, deal busy, or not releasable), 429.
 */
export async function decideDeal(ctx: ServiceContext, sessionId: string, dealId: string, decision: DecisionRequest): Promise<DealView> {
  assertOwner(await loadDeal(ctx.db, dealId), sessionId);
  await limitSession(ctx, RATE_LIMITS.decisionPerSession, sessionId);
  const now = ctx.now();
  const choice = parseDecision(decision, now);

  const lockId = await takeLeasePatiently(ctx, dealId);
  if (lockId === null) throw conflict("This deal is busy with another step. Try again in a moment.");
  await underLease(ctx, dealId, lockId, async () => {
    let graph = await loadGraph(ctx.db, dealId);
    // The gate may already be closed by what PayPal did (an order that lapsed, for instance).
    if (await followPayment(ctx, graph, now)) graph = await loadGraph(ctx.db, dealId);
    assertGateOpen(graph, choice);
    const outcome = await decisionOutcome(ctx, graph, choice);
    await commit(ctx, graph.deal, outcome, now);
    log.info("deal.decision", { dealId, kind: choice.kind, from: graph.deal.status, status: outcome.to });
  });
  return getDealView(ctx, sessionId, dealId);
}

/* -------------------------------------------------------------------------- */
/*  Return from PayPal                                                         */
/* -------------------------------------------------------------------------- */

export type ApprovalOutcome = "authorized" | "pending" | "failed";

/** What the deal page is told, in its query string, after the payer comes back. */
export type PayPalReturnResult = "approved" | "pending" | "cancelled" | "error";

/**
 * Where the browser is sent after PayPal (or the simulator). Always a path on this site: the
 * deal's page when the id from the URL is shaped like a deal id, the workspace otherwise — a
 * return link can therefore never be turned into a redirect to somewhere else.
 */
export function payPalReturnPath(dealId: string | null, result: PayPalReturnResult): string {
  return dealId !== null && isDealId(dealId) ? `/deals/${dealId}?paypal=${result}` : `/workspace?paypal=${result}`;
}

const ORDER_MISMATCH_NOTE = "A return from the payment provider named a different order than this deal's and was ignored";

/** Leave one trace of a return that named someone else's order. Changes nothing else. */
async function noteOrderMismatch(ctx: ServiceContext, graph: DealGraph): Promise<void> {
  const events = withoutRecorded(graph.audit, [problemEvent(ORDER_MISMATCH_NOTE)]);
  if (events.length === 0) return;
  await withTransaction(ctx.db, async (tx) => {
    await appendAudit(tx, graph.deal.id, events, ctx.now());
  });
}

/** Funds are (or were) authorized for this deal, so an approval has nothing left to do. */
function alreadyAuthorized(payment: PaymentRecord): boolean {
  return payment.status === "authorized" || payment.status === "captured";
}

/** The authorization attempt returned a definite payment state. */
async function settleApproval(ctx: ServiceContext, graph: DealGraph, step: PaymentStepResult, now: Date): Promise<ApprovalOutcome> {
  const { deal } = graph;
  const save = (tx: Db): Promise<void> => upsertPayment(tx, deal.id, step.payment);
  switch (step.payment.status) {
    case "authorized":
      await commit(ctx, deal, { to: "authorized", events: step.events, patch: { lastError: null }, rows: save }, now);
      return "authorized";
    case "voided":
      // The order was cancelled on the provider's side: nothing was ever held.
      await commit(ctx, deal, { to: "cancelled", events: step.events, patch: { lastError: null }, rows: save }, now);
      return "failed";
    case "failed": {
      const lastError = `${providerLabel(ctx.provider.kind)} declined the authorization. Nothing is held.`;
      await commit(ctx, deal, { to: "failed", events: step.events, patch: { lastError }, rows: save }, now);
      return "failed";
    }
    case "none":
    case "created":
    case "approved":
    case "captured":
    case "expired":
      throw broken(deal.id, `authorizing the order left the payment ${step.payment.status}`);
    default:
      return assertNever(step.payment.status);
  }
}

/** The authorization attempt threw: not approved yet, not reachable, or refused. */
async function settleApprovalError(ctx: ServiceContext, graph: DealGraph, error: PaymentStepError, now: Date): Promise<ApprovalOutcome> {
  // The payer has not approved (yet): exactly what a forged or premature return looks like. Nothing to record.
  if (error.issue === "ORDER_NOT_APPROVED") return "pending";
  if (error.retryable) {
    // The record may have moved to "approved" on the way; keep that, and let the next return finish the job.
    await stayPut(ctx, graph, error, now);
    return "pending";
  }
  const message = failureMessage(ctx.provider.kind, error);
  const releaseReason = "The order could not be authorized against this contract, so it was abandoned.";
  await failDeal(ctx, graph, { payment: error.payment, events: error.events, message, releaseReason }, now);
  return "failed";
}

async function authorizeUnderLease(ctx: ServiceContext, dealId: string, orderId: string | null): Promise<ApprovalOutcome> {
  const now = ctx.now();
  let graph = await loadGraph(ctx.db, dealId);
  if (await followPayment(ctx, graph, now)) graph = await loadGraph(ctx.db, dealId);
  const { deal, payment } = graph;
  if (payment === null || payment.orderId === null) return "failed";
  if (orderId !== null && orderId !== payment.orderId) return "failed";
  if (deal.status !== "awaiting_payment") return alreadyAuthorized(payment) ? "authorized" : "failed";
  try {
    const step = await authorizeApprovedOrder(paymentDeps(ctx), { dealId, signed: signedOf(graph), payment });
    return await settleApproval(ctx, graph, step, now);
  } catch (error) {
    if (!(error instanceof PaymentStepError)) throw error;
    return settleApprovalError(ctx, graph, error, now);
  }
}

/**
 * The payer came back from PayPal (or the simulator's approval page). The redirect proves
 * nothing: the order on record is the authority, and the orchestrator re-reads it from the
 * provider — status, amount and contract hash — before it authorizes.
 *
 *  - "authorized": funds are held (also when they already were);
 *  - "pending": the provider does not show an approval yet, or could not be asked — the deal waits;
 *  - "failed": wrong or unknown order, a deal that is not waiting for payment, or a refusal.
 *
 * @throws ApiError 404 for an unknown deal, 429 when a waiting deal's return is tried too often.
 */
export async function completePayPalApproval(
  ctx: ServiceContext,
  input: { dealId: string; orderId: string | null },
): Promise<{ dealId: string; outcome: ApprovalOutcome }> {
  const { dealId, orderId } = input;
  const graph = await loadGraph(ctx.db, dealId);
  const stored = graph.payment?.orderId ?? null;
  if (stored === null) return { dealId, outcome: "failed" };
  if (orderId !== null && orderId !== stored) {
    await noteOrderMismatch(ctx, graph);
    return { dealId, outcome: "failed" };
  }
  // Only a deal that waits for the payer has anything to authorize; the rest is answered from the record.
  if (graph.deal.status !== "awaiting_payment") {
    return { dealId, outcome: graph.payment !== null && alreadyAuthorized(graph.payment) ? "authorized" : "failed" };
  }
  // From here on the provider is asked. Anyone holding the deal's id can get this far, so it is bounded per deal.
  await enforceRule(ctx, RATE_LIMITS.approvalReturnPerDeal, dealId);
  const lockId = await takeLeasePatiently(ctx, dealId);
  if (lockId === null) return { dealId, outcome: "pending" };
  const outcome = await underLease(ctx, dealId, lockId, () => authorizeUnderLease(ctx, dealId, orderId));
  log.info("deal.approval_return", { dealId, outcome });
  return { dealId, outcome };
}

/* -------------------------------------------------------------------------- */
/*  Webhooks                                                                   */
/* -------------------------------------------------------------------------- */

export interface WebhookOutcome {
  /** False: the delivery must be answered with an error status, so nothing is acknowledged. */
  accepted: boolean;
  /** True when this event id had already been fully processed. */
  duplicate: boolean;
  /** Machine-readable note for logs and tests. Never sent to the caller of the webhook endpoint. */
  reason: string | null;
}

const REJECTION_LOG_INTERVAL_MS = 30_000;
const rejections = { lastLoggedAt: 0, suppressed: 0 };

/** Anyone can post to the webhook URL, so rejected deliveries are logged at most once per interval. */
function noteRejectedWebhook(reason: string): void {
  const nowMs = Date.now();
  if (nowMs - rejections.lastLoggedAt < REJECTION_LOG_INTERVAL_MS) {
    rejections.suppressed += 1;
    return;
  }
  log.warn("webhook.rejected", { reason, suppressedSinceLastLine: rejections.suppressed });
  rejections.lastLoggedAt = nowMs;
  rejections.suppressed = 0;
}

function rejected(reason: string): WebhookOutcome {
  noteRejectedWebhook(reason);
  return { accepted: false, duplicate: false, reason };
}

function parseJsonObject(rawBody: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The deal an event is about. Every id the event carries is tried: the capture or authorization
 * id may not be stored yet when PayPal's event overtakes the step that created it, but the
 * order id always is.
 */
async function findDealForEvent(db: Db, effect: WebhookEffect): Promise<string | null> {
  if (effect.orderId !== null) {
    const byOrder = await findDealIdByOrderId(db, effect.orderId);
    if (byOrder !== null) return byOrder;
  }
  if (effect.authorizationId !== null) {
    const byAuthorization = await findDealIdByAuthorizationId(db, effect.authorizationId);
    if (byAuthorization !== null) return byAuthorization;
  }
  return effect.captureId === null ? null : findDealIdByCaptureId(db, effect.captureId);
}

/**
 * Fold a verified event into the deal, under its lease and in one transaction: the payment row
 * is locked, the event applied (forward along the payment state machine or not at all), the
 * audit trail extended, the deal moved if the new payment state demands it, and the delivery
 * marked processed. Returns true when an earlier delivery had already done all this.
 */
async function applyEvent(ctx: ServiceContext, dealId: string, effect: WebhookEffect): Promise<boolean> {
  const now = ctx.now();
  return withTransaction(ctx.db, async (tx) => {
    if ((await getWebhookEvent(tx, effect.eventId))?.processed) return true;
    const payment = await getPayment(tx, dealId, { forUpdate: true });
    const deal = await getDeal(tx, dealId);
    if (payment !== null && deal !== null) {
      const applied = applyWebhookEffect(payment, effect, now);
      if (applied.changed) await upsertPayment(tx, dealId, applied.payment);
      const to = dealStatusForPayment(deal.status, applied.payment);
      const events = to === null ? applied.events : [...applied.events, ...paymentDrivenEvents(to, applied.payment)];
      await appendAudit(tx, dealId, events, now);
      if (to !== null) {
        assertTransition(deal.status, to);
        const patch = { status: to, lastError: null, updatedAt: now.toISOString() };
        if ((await updateDeal(tx, dealId, deal.version, patch)) === null) throw staleDeal();
      }
    }
    await markWebhookProcessed(tx, effect.eventId, dealId);
    return false;
  });
}

async function processEvent(ctx: ServiceContext, effect: WebhookEffect): Promise<WebhookOutcome> {
  const dealId = effect.kind === "ignored" ? null : await findDealForEvent(ctx.db, effect);
  if (dealId === null) {
    // Not one of ours, or not an event PACT acts on: acknowledged so PayPal stops redelivering it.
    await markWebhookProcessed(ctx.db, effect.eventId, null);
    return { accepted: true, duplicate: false, reason: effect.kind === "ignored" ? "ignored" : "no_matching_deal" };
  }
  const lockId = await takeLeasePatiently(ctx, dealId);
  // Not acknowledged and not marked processed: PayPal redelivers, and by then the running step has finished.
  if (lockId === null) return { accepted: false, duplicate: false, reason: "busy" };
  const duplicate = await underLease(ctx, dealId, lockId, () => applyEvent(ctx, dealId, effect));
  log.info("webhook.applied", { dealId, eventId: effect.eventId, eventType: effect.eventType, duplicate });
  return { accepted: true, duplicate, reason: null };
}

/**
 * Handle one delivery to the webhook endpoint. `rawBody` must be the exact bytes received: the
 * signature is computed over them.
 *
 * An event whose signature does not verify changes nothing and writes nothing. A verified event
 * is recorded under PayPal's event id (so a redelivery is recognised), interpreted, matched to a
 * deal by the PayPal ids PACT already holds, and applied once. `accepted: false` asks the route
 * to answer with an error status; with reason "busy" that is deliberate — the deal is in the
 * middle of a step, and PayPal's redelivery is how the event gets applied.
 */
export async function handlePayPalWebhook(ctx: ServiceContext, headers: Headers, rawBody: string): Promise<WebhookOutcome> {
  let verification: WebhookVerification;
  try {
    verification = await ctx.provider.verifyWebhook(headers, rawBody);
  } catch (error) {
    if (!(error instanceof PaymentError)) throw error;
    return rejected(`verification_unavailable:${error.issue}`);
  }
  if (!verification.verified) return rejected(verification.reason ?? "unverified");

  const payload = parseJsonObject(rawBody);
  if (payload === null) return rejected("invalid_json");
  const effect = interpretWebhookEvent(payload);
  if (effect.eventId === "") return rejected("missing_event_id");

  const delivery = await recordWebhookEvent(ctx.db, {
    id: effect.eventId,
    eventType: effect.eventType,
    resourceId: effect.resourceId,
    verified: true,
    verificationMethod: verification.method,
    payload,
    receivedAt: ctx.now().toISOString(),
  });
  if (delivery.processed) return { accepted: true, duplicate: true, reason: null };
  return processEvent(ctx, effect);
}

/* -------------------------------------------------------------------------- */
/*  Simulator-only operations                                                  */
/* -------------------------------------------------------------------------- */

/** The simulator stands in for PayPal only when no credentials exist; with real PayPal these operations do not exist. */
function simulatorOf(ctx: ServiceContext): SimulatedProvider {
  if (ctx.provider.kind !== "simulated" || !(ctx.provider instanceof SimulatedProvider)) throw notFound();
  return ctx.provider;
}

export interface SimulatedCheckoutView {
  orderId: string;
  /** The deal the order belongs to, or null when PACT holds no payment for it. */
  dealId: string | null;
  amountMinor: number;
  description: string;
  /** False once the order was approved, authorized or cancelled. */
  awaitingPayer: boolean;
}

/** What the simulated approval page shows. Null when the active provider is not the simulator or the order is unknown. */
export async function getSimulatedCheckout(ctx: ServiceContext, orderId: string): Promise<SimulatedCheckoutView | null> {
  if (ctx.provider.kind !== "simulated" || !(ctx.provider instanceof SimulatedProvider)) return null;
  if (!SIMULATED_ORDER_PATTERN.test(orderId)) return null;
  try {
    const { order, description } = await ctx.provider.checkout(orderId);
    return {
      orderId,
      dealId: await findDealIdByOrderId(ctx.db, orderId),
      amountMinor: order.amountMinor,
      description,
      awaitingPayer: order.approveUrl !== null,
    };
  } catch (error) {
    if (error instanceof PaymentError && error.issue === "INVALID_RESOURCE_ID") return null;
    throw error;
  }
}

/**
 * Approving or cancelling an order is the payer's act, so it takes the session that owns the deal.
 * Returns the deal and that session.
 */
async function ownedDealOfOrder(
  ctx: ServiceContext,
  sessionId: string | null,
  orderId: string,
): Promise<{ dealId: string; owner: string }> {
  const dealId = SIMULATED_ORDER_PATTERN.test(orderId) ? await findDealIdByOrderId(ctx.db, orderId) : null;
  if (dealId === null) throw notFound("Order");
  return { dealId, owner: await requireOwner(ctx, sessionId, dealId) };
}

/** An order that is already approved, authorized or cancelled: the click was a repeat, not an error. */
function isSettledOrder(error: unknown): boolean {
  return error instanceof PaymentError && error.issue === "ORDER_COMPLETED_OR_VOIDED";
}

/**
 * The simulated payer approves the order, then PACT authorizes it exactly as after a real
 * PayPal return.
 *
 * @throws ApiError 404 (real PayPal is active, or unknown order), 403 (not the deal's owner).
 */
export async function approveSimulatedOrder(
  ctx: ServiceContext,
  sessionId: string | null,
  orderId: string,
): Promise<{ dealId: string; outcome: ApprovalOutcome }> {
  const simulator = simulatorOf(ctx);
  const { dealId } = await ownedDealOfOrder(ctx, sessionId, orderId);
  await simulator.approve(orderId).catch((error: unknown) => {
    if (!isSettledOrder(error)) throw error;
  });
  return completePayPalApproval(ctx, { dealId, orderId });
}

/**
 * The simulated payer backs out. Unlike PayPal's cancel link, the simulator voids the order, so it
 * can never be approved later; the deal is therefore cancelled too, as the owner's own decision.
 *
 * @throws ApiError 404, 403, 409 (the order was already approved, or the deal no longer waits for payment).
 */
export async function cancelSimulatedOrder(
  ctx: ServiceContext,
  sessionId: string | null,
  orderId: string,
): Promise<{ dealId: string; outcome: "cancelled" }> {
  const simulator = simulatorOf(ctx);
  const { dealId, owner } = await ownedDealOfOrder(ctx, sessionId, orderId);
  try {
    await simulator.cancel(orderId);
  } catch (error) {
    if (!isSettledOrder(error)) throw error;
    throw conflict("This order has already been approved and can no longer be cancelled here.");
  }
  await decideDeal(ctx, owner, dealId, { kind: "cancel_payment", reason: "Cancelled on the simulated PayPal approval page." });
  return { dealId, outcome: "cancelled" };
}
