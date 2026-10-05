/**
 * The core modules wired together the way the step engine wires them, with nothing mocked and
 * nothing external: the scripted agents and seller studio, the negotiation / contract / policy /
 * verification / settlement engines, the payment orchestrator against the labelled simulator,
 * and the Postgres repositories (PGlite) including the idempotency ledger and the audit chain.
 *
 * Every stage reads its input back from the database, so a value that does not survive storage
 * (a contract hash, a timestamp, an audit event) fails here rather than in production. After
 * every status change the settlement guard is asked whether a capture would be allowed: the
 * answer must be "no" at every stage except "verified".
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgents } from "@/lib/ai";
import { AiUnavailableError, type CallStructured } from "@/lib/ai/gateway";
import type { Agents } from "@/lib/ai/types";
import {
  closeDb,
  createDbLedger,
  createDbSimulatedStore,
  createTestDb,
  findDealIdByCaptureId,
  getLastAuditEvent,
  getPayment,
  getWallet,
  insertAuditEvent,
  insertContract,
  insertDeal,
  insertMove,
  insertReport,
  insertSubmission,
  listPaymentOperations,
  loadDealGraphs,
  markWebhookProcessed,
  recordWebhookEvent,
  sumAuthorizedSince,
  updateDeal,
  upsertPayment,
  upsertWallet,
  withTransaction,
  type Db,
  type DealGraph,
  type DealInsert,
} from "@/lib/db";
import { auditEvents } from "@/lib/db/schema";
import { buildAuditEvent, verifyAuditChain } from "@/lib/domain/audit";
import { compileContract, paypalCustomId, verifyContractHash } from "@/lib/domain/contract";
import { newDealCode, newId } from "@/lib/domain/ids";
import { formatMoney, percentOf, toPayPalValue } from "@/lib/domain/money";
import { applyMove, buyerContextFor, nextActor, sellerContextFor } from "@/lib/domain/negotiation";
import { evaluatePolicy } from "@/lib/domain/policy";
import { getScenario, type ScenarioId } from "@/lib/domain/scenarios";
import {
  DEFAULT_POLICY,
  MandateSchema,
  PolicyEvaluationSchema,
  SubmissionSchema,
  type AuditEventInput,
  type AuditEventType,
  type HumanDecision,
  type HumanDecisionKind,
  type Mandate,
  type NegotiationState,
  type PolicyEvaluation,
  type SignedContract,
  type Submission,
  type VerificationReport,
} from "@/lib/domain/schemas";
import { getSeller, type SellerProfile } from "@/lib/domain/sellers";
import { checkCaptureAllowed, checkVoidAllowed } from "@/lib/domain/settlement";
import { DealStatusSchema, assertTransition, type DealStatus } from "@/lib/domain/status";
import { buildReport, runDeterministicChecks } from "@/lib/domain/verification";
import {
  PaymentStepError,
  SimulatedProvider,
  applyWebhookEffect,
  authorizeApprovedOrder,
  captureVerified,
  idempotencyKey,
  interpretWebhookEvent,
  openOrder,
  simulatedApprovePath,
  voidHeldFunds,
  type OrchestratorDeps,
  type PaymentRecord,
} from "@/lib/payments";

/** 14:00 in Tokyo. "Tomorrow at 6 PM" is then 2026-10-07T09:00Z, 28 hours away. */
const START_MS = Date.parse("2026-10-06T05:00:00.000Z");
const START_OF_DAY = "2026-10-06T00:00:00.000Z";
/** Date#getTimezoneOffset() for UTC+9. */
const TOKYO_OFFSET_MINUTES = -540;
const APP_URL = "https://pact.test";
const DAY_MS = 24 * 60 * 60 * 1000;

const modelMustNotBeCalled: CallStructured = async () => {
  throw new Error("the scripted agents reached the model gateway");
};
/** Every model call times out, as during a gateway outage. */
const modelOutage: CallStructured = async () => {
  throw new AiUnavailableError("timeout", "AI call failed (timeout)");
};

let db: Db;
let nowMs = START_MS;
const now = (): Date => new Date(nowMs);
/** Agents and PayPal take time; moving the clock keeps every recorded timestamp in a realistic order. */
const elapse = (seconds: number): void => {
  nowMs += seconds * 1000;
};

const scriptedAgents = createAgents({ mode: "scripted", call: modelMustNotBeCalled });
let provider: SimulatedProvider;
let payments: OrchestratorDeps;

beforeAll(async () => {
  db = await createTestDb();
  // The simulator keeps its orders in the same database, exactly as it does behind the real routes.
  provider = new SimulatedProvider(createDbSimulatedStore(db), { now });
  payments = { provider, ledger: createDbLedger(db), now };
});

afterAll(async () => {
  await closeDb(db);
});

beforeEach(() => {
  nowMs = START_MS;
});

/* -------------------------------------------------------------------------- */
/*  A deal in flight                                                           */
/* -------------------------------------------------------------------------- */

interface Run {
  dealId: string;
  owner: string;
  seller: SellerProfile;
  agents: Agents;
  /** Every status the deal has been in, in order. */
  path: DealStatus[];
  /** Guard verdict recorded on entering each status: the violation codes, or "allowed". */
  captureGuard: (string[] | "allowed")[];
}

/** A deal graph read back from the database, with its status and mandate narrowed to their domain types. */
interface Loaded extends DealGraph {
  status: DealStatus;
  mandate: Mandate;
}

async function load(run: Run): Promise<Loaded> {
  const graph = (await loadDealGraphs(db, [run.dealId])).get(run.dealId);
  if (!graph) throw new Error(`deal ${run.dealId} is not in the database`);
  return { ...graph, status: DealStatusSchema.parse(graph.deal.status), mandate: MandateSchema.parse(graph.deal.mandate) };
}

function signedOf(deal: Loaded): SignedContract {
  if (!deal.signed) throw new Error("the deal has no contract yet");
  return deal.signed;
}

function paymentOf(deal: Loaded): PaymentRecord {
  if (!deal.payment) throw new Error("the deal has no payment yet");
  return deal.payment;
}

function latest<T>(items: readonly T[]): T | null {
  return items[items.length - 1] ?? null;
}

async function appendAudit(tx: Db, dealId: string, inputs: readonly AuditEventInput[]): Promise<void> {
  let head = await getLastAuditEvent(tx, dealId);
  for (const input of inputs) {
    const event = buildAuditEvent(head, dealId, input, { id: newId("evt"), now: now() });
    await insertAuditEvent(tx, event);
    head = event;
  }
}

/** What the settlement guard says about capturing right now, judged on what the database holds. */
async function captureGuard(run: Run): Promise<ReturnType<typeof checkCaptureAllowed>> {
  const deal = await load(run);
  return checkCaptureAllowed({
    dealStatus: deal.status,
    signed: deal.signed,
    payment: deal.payment,
    latestReport: latest(deal.reports),
    humanDecision: deal.deal.humanDecision,
    now: now(),
  });
}

async function recordGuard(run: Run, status: DealStatus): Promise<void> {
  const guard = await captureGuard(run);
  run.path.push(status);
  run.captureGuard.push(guard.allowed ? "allowed" : guard.violations.map((violation) => violation.code));
  if (!guard.allowed) expect(guard.amountMinor).toBe(0);
}

/**
 * One step's writes — child rows, audit events and the status change — commit together or not at
 * all, and the status change must be one the deal state machine allows.
 */
async function commit(
  run: Run,
  to: DealStatus,
  events: readonly AuditEventInput[],
  patch: Partial<DealInsert> = {},
  write: (tx: Db) => Promise<void> = async () => {},
): Promise<void> {
  const { deal, status } = await load(run);
  assertTransition(status, to);
  await withTransaction(db, async (tx) => {
    await write(tx);
    await appendAudit(tx, run.dealId, events);
    const updated = await updateDeal(tx, run.dealId, deal.version, { ...patch, status: to });
    if (!updated) throw new Error(`deal ${run.dealId} changed underneath the step`);
  });
  await recordGuard(run, to);
}

/* -------------------------------------------------------------------------- */
/*  Stages                                                                     */
/* -------------------------------------------------------------------------- */

async function startDeal(scenarioId: ScenarioId, agents: Agents = scriptedAgents): Promise<Run> {
  const scenario = getScenario(scenarioId);
  const seller = scenario ? getSeller(scenario.sellerId) : undefined;
  if (!scenario || !seller) throw new Error(`scenario ${scenarioId} or its seller is missing from the catalogue`);

  const { mandate, meta } = await agents.parseIntent(scenario.intent, now(), TOKYO_OFFSET_MINUTES);
  expect(meta).toMatchObject({ source: "scripted", model: null });

  const run: Run = { dealId: newId("deal"), owner: `session-${newId("sess")}`, seller, agents, path: [], captureGuard: [] };
  await withTransaction(db, async (tx) => {
    await insertDeal(tx, {
      id: run.dealId,
      code: newDealCode(),
      owner: run.owner,
      scenarioId,
      status: "negotiating",
      intent: scenario.intent,
      mandate,
      category: mandate.category,
      sellerId: seller.id,
    });
    await appendAudit(tx, run.dealId, [
      { actor: "human", type: "intent.received", title: "Request received", data: { scenarioId } },
      { actor: "buyer_agent", type: "mandate.derived", title: `Mandate derived: ${mandate.summary}`, data: { source: meta.source } },
      { actor: "system", type: "seller.matched", title: `Matched with ${seller.name}`, data: { sellerId: seller.id } },
    ]);
  });
  await recordGuard(run, "negotiating");
  return run;
}

/** One move per step, with the negotiation rebuilt from the stored moves every time. */
async function negotiate(run: Run): Promise<NegotiationState> {
  for (;;) {
    const { mandate, moves } = await load(run);
    const state: NegotiationState = { status: "open", moves, agreedTerms: null, failureReason: null };
    const actor = nextActor(state);
    elapse(20);
    // The agent is briefed, and its move judged, against the same mandate, seller and instant.
    const rules = { mandate, seller: run.seller, now: now() };
    const proposal =
      actor === "seller"
        ? await run.agents.sellerMove(sellerContextFor(state, rules))
        : await run.agents.buyerMove(buyerContextFor(state, rules));
    const applied = applyMove(state, actor, proposal.move, proposal.meta, rules);
    const moveEvent: AuditEventInput = {
      actor: actor === "seller" ? "seller_agent" : "buyer_agent",
      type: "negotiation.move",
      title: applied.move.message,
      data: { seq: applied.move.seq, action: applied.move.action, priceMinor: applied.move.terms?.priceMinor ?? null },
    };
    const write = (tx: Db): Promise<void> => insertMove(tx, run.dealId, applied.move);

    if (applied.state.status === "open") {
      await commit(run, "negotiating", [moveEvent], {}, write);
    } else if (applied.state.status === "agreed" && applied.state.agreedTerms) {
      const agreed: AuditEventInput = {
        actor: "system",
        type: "negotiation.agreed",
        title: `Terms agreed at ${formatMoney(applied.state.agreedTerms.priceMinor)}`,
        data: { ...applied.state.agreedTerms },
      };
      await commit(run, "agreed", [moveEvent, agreed], { negotiationStatus: "agreed", agreedTerms: applied.state.agreedTerms }, write);
      return applied.state;
    } else {
      throw new Error(`the scripted agents failed to agree: ${applied.state.failureReason ?? "unknown reason"}`);
    }
  }
}

async function compile(run: Run): Promise<SignedContract> {
  const { deal, mandate } = await load(run);
  if (!deal.agreedTerms) throw new Error("no agreed terms to compile");
  elapse(1);
  const signed = compileContract({
    dealId: run.dealId,
    contractId: newId("ctr"),
    mandate,
    terms: deal.agreedTerms,
    seller: run.seller,
    policy: DEFAULT_POLICY,
    now: now(),
  });
  const { contract } = signed;
  await commit(
    run,
    "contracted",
    [
      {
        actor: "contract_engine",
        type: "contract.created",
        title: `Contract ${contract.contractId} compiled and hashed`,
        data: { contractId: contract.contractId, termsHash: signed.termsHash, priceMinor: contract.price.amountMinor },
      },
    ],
    { priceMinor: contract.price.amountMinor, deadline: contract.deadline, revisionLimit: contract.revisionLimit },
    (tx) => insertContract(tx, signed),
  );
  return signed;
}

async function evaluateSpend(run: Run): Promise<PolicyEvaluation> {
  const deal = await load(run);
  const { contract } = signedOf(deal);
  elapse(1);
  const evaluation = evaluatePolicy(DEFAULT_POLICY, {
    amountMinor: contract.price.amountMinor,
    category: contract.category,
    seller: run.seller,
    spentTodayMinor: await sumAuthorizedSince(db, run.owner, START_OF_DAY),
    now: now(),
  });
  expect(PolicyEvaluationSchema.safeParse(evaluation).success).toBe(true);
  const evaluated: AuditEventInput = {
    actor: "policy_engine",
    type: "policy.evaluated",
    title: `Spending policy: ${evaluation.outcome}`,
    data: { outcome: evaluation.outcome, flagged: evaluation.checks.filter((check) => check.outcome !== "pass").map((check) => check.id) },
  };
  switch (evaluation.outcome) {
    case "allow":
      await commit(run, "payment_pending", [evaluated], { policyEvaluation: evaluation });
      break;
    case "needs_approval":
      await commit(
        run,
        "awaiting_approval",
        [evaluated, { actor: "policy_engine", type: "policy.approval_requested", title: "A human must approve this spend" }],
        { policyEvaluation: evaluation },
      );
      break;
    case "block":
      await commit(run, "blocked", [evaluated], { policyEvaluation: evaluation });
      break;
  }
  return evaluation;
}

async function humanDecides(
  run: Run,
  kind: HumanDecisionKind,
  to: DealStatus,
  type: AuditEventType,
  percent: number | null = null,
): Promise<HumanDecision> {
  elapse(45);
  const decision: HumanDecision = { kind, percent, reason: "Decided in the integration test", decidedAt: now().toISOString() };
  await commit(run, to, [{ actor: "human", type, title: `Human decision: ${kind}`, data: { kind, percent } }], { humanDecision: decision });
  return decision;
}

/** Persist what a payment step produced: the new payment record, its audit events and the deal's next status. */
async function settlePaymentStep(
  run: Run,
  to: DealStatus,
  step: { payment: PaymentRecord; events: AuditEventInput[] },
  extra: AuditEventInput[] = [],
): Promise<void> {
  await commit(run, to, [...step.events, ...extra], {}, (tx) => upsertPayment(tx, run.dealId, step.payment));
}

/** Create the order, let the simulated payer approve it, then authorize — never trusting the redirect. */
async function authorizeFunds(run: Run): Promise<PaymentRecord> {
  const signed = signedOf(await load(run));
  elapse(2);
  const opened = await openOrder(payments, {
    dealId: run.dealId,
    signed,
    returnUrl: `${APP_URL}/api/paypal/return?deal=${run.dealId}`,
    cancelUrl: `${APP_URL}/api/paypal/cancel?deal=${run.dealId}`,
  });
  expect(opened.payment).toMatchObject({ status: "created", provider: "simulated", mode: "interactive", authorizedMinor: 0 });
  expect(opened.payment.approveUrl).toBe(simulatedApprovePath(opened.payment.orderId ?? ""));
  await settlePaymentStep(run, "awaiting_payment", opened);

  // A forged or premature "return from PayPal" achieves nothing: PayPal's own record says not approved.
  const created = paymentOf(await load(run));
  const premature = await authorizeApprovedOrder(payments, { dealId: run.dealId, signed, payment: created }).catch((error: unknown) => error);
  expect(premature).toBeInstanceOf(PaymentStepError);
  expect(premature).toMatchObject({ issue: "ORDER_NOT_APPROVED", payment: { status: "created", authorizedMinor: 0 } });

  elapse(30);
  await provider.approve(created.orderId ?? "");
  const authorized = await authorizeApprovedOrder(payments, { dealId: run.dealId, signed, payment: created });
  expect(authorized.payment).toMatchObject({
    status: "authorized",
    amountMinor: signed.contract.price.amountMinor,
    authorizedMinor: signed.contract.price.amountMinor,
    capturedMinor: 0,
  });
  await settlePaymentStep(run, "authorized", authorized);
  return authorized.payment;
}

async function deliver(run: Run): Promise<Submission> {
  const deal = await load(run);
  const round = deal.submissions.length + 1;
  elapse(90);
  const delivery = await run.agents.produceDelivery({
    contract: signedOf(deal).contract,
    seller: run.seller,
    round,
    previousReport: latest(deal.reports),
    previousSubmission: latest(deal.submissions),
    now: now(),
  });
  const submission = SubmissionSchema.parse({
    id: newId("sub"),
    dealId: run.dealId,
    round,
    artifacts: delivery.artifacts,
    note: delivery.note,
    source: delivery.meta.source,
    model: delivery.meta.model,
    submittedAt: now().toISOString(),
  } satisfies Submission);
  await commit(
    run,
    "submitted",
    [
      {
        actor: "seller_agent",
        type: "delivery.submitted",
        title: `${run.seller.name} delivered ${submission.artifacts.length} files (round ${round})`,
        data: { submissionId: submission.id, round, artifacts: submission.artifacts.length },
      },
    ],
    {},
    (tx) => insertSubmission(tx, submission),
  );
  return submission;
}

const STATUS_AFTER: Record<VerificationReport["decision"], DealStatus> = {
  capture_eligible: "verified",
  revision_required: "revision_required",
  human_review: "in_review",
  reject: "rejecting",
};

/** Deterministic checks plus the (scripted) verifier's AI-judged rules, decided by the deterministic core. */
async function verify(run: Run): Promise<VerificationReport> {
  const deal = await load(run);
  const signed = signedOf(deal);
  const submission = latest(deal.submissions);
  if (!submission) throw new Error("nothing has been delivered yet");
  elapse(15);
  const aiRules = signed.contract.verificationRules.filter((rule) => rule.evaluator === "ai");
  const ai = await run.agents.evaluateAiRules({ contract: signed.contract, rules: aiRules, submission });
  const report = buildReport({
    id: newId("rep"),
    signed,
    submission,
    checks: [...runDeterministicChecks(signed.contract, submission), ...ai.checks],
    revisionsUsed: submission.round - 1,
    manipulationSuspected: ai.flags.manipulationSuspected,
    degraded: ai.meta.degradedReason !== null,
    model: ai.meta.model,
    now: now(),
  });
  const events: AuditEventInput[] = [
    {
      actor: "verifier",
      type: "verification.completed",
      title: report.summary,
      data: { reportId: report.id, decision: report.decision, failedRuleIds: report.failedRuleIds, confidence: report.confidence },
    },
  ];
  if (report.decision === "revision_required") {
    events.push({ actor: "system", type: "revision.requested", title: "Sent back to the seller for a revision" });
  }
  if (report.decision === "human_review") {
    events.push({ actor: "system", type: "verification.review_requested", title: "A human must review this delivery" });
  }
  if (report.degraded) {
    events.push({
      actor: "system",
      type: "system.degraded",
      title: "The AI verifier was unavailable, so the AI-judged conditions were not evaluated",
      data: { reason: ai.meta.degradedReason },
    });
  }
  const patch: Partial<DealInsert> = {
    revisionsUsed: deal.deal.revisionsUsed + (report.decision === "revision_required" ? 1 : 0),
    aiDegraded: deal.deal.aiDegraded || report.degraded,
  };
  await commit(run, STATUS_AFTER[report.decision], events, patch, (tx) => insertReport(tx, report));
  return report;
}

function captureInputFor(run: Run, deal: Loaded, amountMinor: number) {
  const report = latest(deal.reports);
  if (!report) throw new Error("no report to capture against");
  return { dealId: run.dealId, signed: signedOf(deal), payment: paymentOf(deal), amountMinor, reportId: report.id };
}

/** Capture exactly what the guard allows, and nothing unless it allows it. */
async function capture(run: Run): Promise<PaymentRecord> {
  const deal = await load(run);
  const guard = await captureGuard(run);
  expect(guard.violations).toEqual([]);
  expect(guard.allowed).toBe(true);
  elapse(3);
  const step = await captureVerified(payments, captureInputFor(run, deal, guard.amountMinor));
  await settlePaymentStep(run, "completed", step, [{ actor: "system", type: "deal.completed", title: "Deal completed: the seller is paid" }]);
  return step.payment;
}

async function voidFunds(run: Run, reason: string): Promise<PaymentRecord> {
  const deal = await load(run);
  expect(checkVoidAllowed({ dealStatus: deal.status, payment: deal.payment })).toEqual({ allowed: true, violations: [] });
  elapse(3);
  const step = await voidHeldFunds(payments, { dealId: run.dealId, payment: paymentOf(deal), reason });
  await settlePaymentStep(run, "rejected", step, [{ actor: "system", type: "deal.rejected", title: "Deal rejected: the authorization was voided" }]);
  return step.payment;
}

/* -------------------------------------------------------------------------- */
/*  Assertions shared by the scenarios                                         */
/* -------------------------------------------------------------------------- */

/** Audit event types in chain order, with the per-move negotiation events collapsed to a count. */
function trailOf(deal: Loaded): { moves: number; steps: string[] } {
  const types = deal.audit.map((event) => event.type);
  return { moves: types.filter((type) => type === "negotiation.move").length, steps: types.filter((type) => type !== "negotiation.move") };
}

async function expectIntactRecord(run: Run): Promise<Loaded> {
  const deal = await load(run);
  const signed = signedOf(deal);
  // The contract came back from JSONB byte-for-byte equivalent: its fingerprint still matches.
  expect(verifyContractHash(signed)).toBe(true);
  // The audit trail read from the database is gapless and its hash chain verifies.
  expect(deal.audit.map((event) => event.seq)).toEqual(deal.audit.map((_, index) => index + 1));
  expect(verifyAuditChain(deal.audit)).toEqual({ valid: true, brokenAtSeq: null });
  // Every report is bound to this contract, and the stored path is the one the test walked.
  for (const report of deal.reports) expect(report.contractHash).toBe(signed.termsHash);
  expect(deal.status).toBe(run.path[run.path.length - 1]);
  return deal;
}

async function operationsOf(run: Run): Promise<string[]> {
  return (await listPaymentOperations(db, run.dealId)).map((operation) => `${operation.kind}:${operation.status}:${operation.attempts}`);
}

const NEGOTIATING = (moves: number): DealStatus[] => Array.from({ length: moves }, () => "negotiating");

/** The audit trail every deal shares up to the policy decision, and around the PayPal authorization. */
const OPENING_TRAIL = ["intent.received", "mandate.derived", "seller.matched", "negotiation.agreed", "contract.created", "policy.evaluated"];
const APPROVAL_TRAIL = ["policy.approval_requested", "human.approved_spend"];
const AUTHORIZATION_TRAIL = ["payment.order_created", "payment.approved", "payment.authorized"];

/* -------------------------------------------------------------------------- */
/*  Scenarios                                                                  */
/* -------------------------------------------------------------------------- */

describe("core flow: the four demo scenarios, end to end on the real modules", () => {
  it("happy path: negotiated, authorized, delivered, verified, then captured in full", async () => {
    const run = await startDeal("happy-path");
    const negotiation = await negotiate(run);
    expect(negotiation.agreedTerms).toEqual({ priceMinor: 4700, deadline: "2026-10-07T09:00:00.000Z", revisionLimit: 1, count: 3 });
    expect(negotiation.moves.flatMap((move) => move.guardrails)).toEqual([]);

    const signed = await compile(run);
    expect(await evaluateSpend(run)).toMatchObject({ outcome: "allow", spentTodayMinor: 0 });

    const authorized = await authorizeFunds(run);
    // PayPal's record is bound to the contract, and the held amount now counts as today's spend.
    const order = await provider.getOrder(authorized.orderId ?? "");
    expect(order).toMatchObject({ customId: paypalCustomId(signed), invoiceId: signed.contract.contractId, amountMinor: 4700 });
    expect(await sumAuthorizedSince(db, run.owner, START_OF_DAY)).toBe(4700);

    const submission = await deliver(run);
    expect(submission.artifacts).toHaveLength(6);
    const report = await verify(run);
    expect(report).toMatchObject({ decision: "capture_eligible", failedRuleIds: [], degraded: false, round: 1 });
    expect(report.checks.map((check) => check.result)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass"]);

    const captured = await capture(run);
    expect(captured).toMatchObject({ status: "captured", capturedMinor: 4700, authorizedMinor: 4700, lastError: null });
    expect(captured.captureId).toMatch(/^SIM-C-/);

    const deal = await expectIntactRecord(run);
    expect(deal.payment).toEqual(captured);
    expect(run.path).toEqual([
      ...NEGOTIATING(negotiation.moves.length),
      "agreed",
      "contracted",
      "payment_pending",
      "awaiting_payment",
      "authorized",
      "submitted",
      "verified",
      "completed",
    ]);
    // Capture was refused at every stage but one, and is refused again once the money has moved.
    expect(run.captureGuard.map((verdict) => verdict === "allowed")).toEqual(run.path.map((status) => status === "verified"));
    expect(run.captureGuard[run.captureGuard.length - 1]).toEqual(["status_not_verified", "already_captured"]);
    expect(trailOf(deal)).toEqual({
      moves: 6,
      steps: [...OPENING_TRAIL, ...AUTHORIZATION_TRAIL, "delivery.submitted", "verification.completed", "payment.captured", "deal.completed"],
    });
    expect(await operationsOf(run)).toEqual(["create_order:succeeded:1", "authorize:succeeded:1", "capture:succeeded:1"]);
    expect((await provider.getAuthorization(captured.authorizationId ?? "")).status).toBe("CAPTURED");
    expect(await sumAuthorizedSince(db, run.owner, START_OF_DAY)).toBe(4700);
  });

  it("happy path: a repeated capture request can never move money twice", async () => {
    const run = await startDeal("happy-path");
    await negotiate(run);
    await compile(run);
    await evaluateSpend(run);
    await authorizeFunds(run);
    await deliver(run);
    await verify(run);

    // The authorization's expiry survives storage, and the guard stops honouring it once it has passed.
    const verified = await load(run);
    const authorizedAt = verified.audit.find((event) => event.type === "payment.authorized")?.at ?? "";
    expect(paymentOf(verified).authorizationExpiresAt).toBe(new Date(Date.parse(authorizedAt) + 29 * DAY_MS).toISOString());
    const tooLate = checkCaptureAllowed({
      dealStatus: verified.status,
      signed: verified.signed,
      payment: verified.payment,
      latestReport: latest(verified.reports),
      humanDecision: verified.deal.humanDecision,
      now: new Date(nowMs + 30 * DAY_MS),
    });
    expect(tooLate).toMatchObject({ allowed: false, amountMinor: 0 });
    expect(tooLate.violations.map((violation) => violation.code)).toEqual(["authorization_expired"]);

    // Two requests read the same "authorized" record before either has written its result.
    const stale = await load(run);
    const input = captureInputFor(run, stale, 4700);
    const first = await captureVerified(payments, input);
    const second = await captureVerified(payments, input);
    expect(second.payment).toMatchObject({ status: "captured", capturedMinor: 4700, captureId: first.payment.captureId });
    expect(second.events[0]).toMatchObject({ type: "payment.captured", data: { idempotentReplay: true } });
    expect(await operationsOf(run)).toEqual(["create_order:succeeded:1", "authorize:succeeded:1", "capture:succeeded:1"]);

    // Once the captured record is stored, both the guard and the orchestrator refuse outright.
    await settlePaymentStep(run, "completed", first);
    const after = await load(run);
    expect((await captureGuard(run)).allowed).toBe(false);
    const again = await captureVerified(payments, captureInputFor(run, after, 4700)).catch((error: unknown) => error);
    expect(again).toMatchObject({ issue: "INVALID_PAYMENT_STATE", payment: { status: "captured", capturedMinor: 4700 } });
    expect(checkVoidAllowed({ dealStatus: after.status, payment: after.payment }).allowed).toBe(false);
  });

  it("revision: a missing 1:1 version blocks capture until the seller fixes it", async () => {
    const run = await startDeal("revision");
    const negotiation = await negotiate(run);
    expect(negotiation.agreedTerms).toMatchObject({ priceMinor: 2700, revisionLimit: 1, count: 2 });
    await compile(run);
    expect((await evaluateSpend(run)).outcome).toBe("allow");
    await authorizeFunds(run);

    const first = await deliver(run);
    expect(first.artifacts).toHaveLength(3);
    const failed = await verify(run);
    expect(failed).toMatchObject({ decision: "revision_required", round: 1, failedRuleIds: ["R2"] });
    expect(failed.summary).toBe("1 condition failed: 1:1 missing on illustration #2.");
    expect(failed.checks.find((check) => check.ruleId === "R2")).toMatchObject({ kind: "aspect_ratio_coverage", result: "fail", confidence: 1 });
    // The money stays held: nothing is captured, and nothing is voided either.
    expect(paymentOf(await load(run))).toMatchObject({ status: "authorized", capturedMinor: 0 });

    const second = await deliver(run);
    expect(second).toMatchObject({ round: 2 });
    expect(second.artifacts).toHaveLength(4);
    expect(second.note).toContain("Added the missing 1:1 version of illustration #2.");
    // A revision answers the report: the three sound files come back unchanged, one is added.
    expect(second.artifacts.filter((artifact) => first.artifacts.some((kept) => kept.id === artifact.id))).toEqual(first.artifacts);

    const passed = await verify(run);
    expect(passed).toMatchObject({ decision: "capture_eligible", round: 2, failedRuleIds: [] });
    const captured = await capture(run);
    expect(captured).toMatchObject({ status: "captured", capturedMinor: 2700 });

    const deal = await expectIntactRecord(run);
    expect(deal.deal).toMatchObject({ status: "completed", revisionsUsed: 1, revisionLimit: 1, priceMinor: 2700 });
    expect(deal.reports.map((report) => report.decision)).toEqual(["revision_required", "capture_eligible"]);
    expect(run.path.slice(negotiation.moves.length)).toEqual([
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
    expect(run.captureGuard.map((verdict) => verdict === "allowed")).toEqual(run.path.map((status) => status === "verified"));
    expect(run.captureGuard[run.path.indexOf("revision_required")]).toEqual(["status_not_verified", "verification_not_passed"]);
    expect(trailOf(deal).steps).toEqual([
      ...OPENING_TRAIL,
      ...AUTHORIZATION_TRAIL,
      "delivery.submitted",
      "verification.completed",
      "revision.requested",
      "delivery.submitted",
      "verification.completed",
      "payment.captured",
      "deal.completed",
    ]);
    expect(await operationsOf(run)).toEqual(["create_order:succeeded:1", "authorize:succeeded:1", "capture:succeeded:1"]);
  });

  it("approval: a price above the autonomous limit waits for a human, then settles normally", async () => {
    const run = await startDeal("approval");
    const negotiation = await negotiate(run);
    expect(negotiation.agreedTerms).toMatchObject({ priceMinor: 18_000, revisionLimit: 2, count: 6 });
    const signed = await compile(run);
    expect(signed.contract.price.amountMinor).toBeGreaterThan(DEFAULT_POLICY.autonomousLimitMinor);

    const policy = await evaluateSpend(run);
    expect(policy.outcome).toBe("needs_approval");
    expect(policy.checks.filter((check) => check.outcome !== "pass").map((check) => check.id)).toEqual(["autonomous_limit"]);
    // Nothing has been asked of PayPal while the human has not answered.
    expect((await load(run)).payment).toBeNull();
    expect(await operationsOf(run)).toEqual([]);

    await humanDecides(run, "approve_spend", "payment_pending", "human.approved_spend");
    await authorizeFunds(run);
    const submission = await deliver(run);
    expect(submission.artifacts).toHaveLength(12);
    const report = await verify(run);
    expect(report).toMatchObject({ decision: "capture_eligible", failedRuleIds: [] });
    const captured = await capture(run);
    expect(captured).toMatchObject({ status: "captured", capturedMinor: 18_000, authorizedMinor: 18_000 });

    const deal = await expectIntactRecord(run);
    expect(deal.deal.policyEvaluation).toEqual(policy);
    expect(deal.deal.humanDecision).toMatchObject({ kind: "approve_spend" });
    expect(run.path.slice(negotiation.moves.length)).toEqual([
      "agreed",
      "contracted",
      "awaiting_approval",
      "payment_pending",
      "awaiting_payment",
      "authorized",
      "submitted",
      "verified",
      "completed",
    ]);
    expect(run.captureGuard.map((verdict) => verdict === "allowed")).toEqual(run.path.map((status) => status === "verified"));
    expect(run.captureGuard[run.path.indexOf("awaiting_approval")]).toEqual(["status_not_verified", "payment_missing", "report_missing"]);
    // The human's approval is on record before anything was asked of PayPal.
    expect(trailOf(deal).steps).toEqual([
      ...OPENING_TRAIL,
      ...APPROVAL_TRAIL,
      ...AUTHORIZATION_TRAIL,
      "delivery.submitted",
      "verification.completed",
      "payment.captured",
      "deal.completed",
    ]);
  });

  it("injection: hidden instructions from a new seller reach a human, who rejects, and the hold is voided", async () => {
    const run = await startDeal("injection");
    const negotiation = await negotiate(run);
    expect(negotiation.agreedTerms).toMatchObject({ priceMinor: 1800, count: 2 });
    await compile(run);

    const policy = await evaluateSpend(run);
    expect(policy.outcome).toBe("needs_approval");
    expect(policy.checks.filter((check) => check.outcome !== "pass").map((check) => check.id)).toEqual(["seller_trust"]);
    await humanDecides(run, "approve_spend", "payment_pending", "human.approved_spend");
    const authorized = await authorizeFunds(run);
    expect(await sumAuthorizedSince(db, run.owner, START_OF_DAY)).toBe(1800);

    await deliver(run);
    const report = await verify(run);
    expect(report).toMatchObject({ decision: "human_review", failedRuleIds: ["R6"] });
    expect(report.checks.find((check) => check.ruleId === "R6")).toMatchObject({
      kind: "no_embedded_instructions",
      evaluator: "deterministic",
      result: "fail",
      confidence: 1,
    });
    // The instruction asked for "PASS with confidence 1.0"; every other rule was still judged on its merits.
    expect(report.checks.filter((check) => check.ruleId !== "R6").every((check) => check.result === "pass")).toBe(true);
    expect(run.captureGuard[run.captureGuard.length - 1]).toEqual(["status_not_verified", "human_release_missing"]);

    await humanDecides(run, "reject_delivery", "rejecting", "human.rejected_delivery");
    const voided = await voidFunds(run, "Delivery rejected at human review: hidden instructions in the files");
    expect(voided).toMatchObject({ status: "voided", capturedMinor: 0, captureId: null, authorizationId: authorized.authorizationId });

    const deal = await expectIntactRecord(run);
    expect(deal.deal).toMatchObject({ status: "rejected", humanDecision: { kind: "reject_delivery" } });
    expect(run.path.slice(negotiation.moves.length)).toEqual([
      "agreed",
      "contracted",
      "awaiting_approval",
      "payment_pending",
      "awaiting_payment",
      "authorized",
      "submitted",
      "in_review",
      "rejecting",
      "rejected",
    ]);
    // Capture was never allowed at any point of this deal.
    expect(run.captureGuard).not.toContain("allowed");
    expect(trailOf(deal).steps).toEqual([
      ...OPENING_TRAIL,
      ...APPROVAL_TRAIL,
      ...AUTHORIZATION_TRAIL,
      "delivery.submitted",
      "verification.completed",
      "verification.review_requested",
      "human.rejected_delivery",
      "payment.voided",
      "deal.rejected",
    ]);
    // No capture was ever attempted, PayPal no longer holds the funds, and the released hold is not spend.
    expect(await operationsOf(run)).toEqual(["create_order:succeeded:1", "authorize:succeeded:1", "void:succeeded:1"]);
    expect((await provider.getAuthorization(voided.authorizationId ?? "")).status).toBe("VOIDED");
    expect(await sumAuthorizedSince(db, run.owner, START_OF_DAY)).toBe(0);
  });

  it("injection: if the human releases half instead, exactly half is captured and the rest is released", async () => {
    const run = await startDeal("injection");
    await negotiate(run);
    await compile(run);
    await evaluateSpend(run);
    await humanDecides(run, "approve_spend", "payment_pending", "human.approved_spend");
    await authorizeFunds(run);
    await deliver(run);
    expect((await verify(run)).decision).toBe("human_review");

    await humanDecides(run, "release_partial", "verified", "human.released_payment", 50);
    const guard = await captureGuard(run);
    expect(guard).toEqual({ allowed: true, violations: [], amountMinor: percentOf(1800, 50) });
    const captured = await capture(run);
    expect(captured).toMatchObject({ status: "captured", authorizedMinor: 1800, capturedMinor: 900 });

    const deal = await expectIntactRecord(run);
    expect(latest(deal.audit.filter((event) => event.type === "payment.captured"))?.data).toMatchObject({
      amountMinor: 900,
      releasedMinor: 900,
      finalCapture: true,
    });
    expect((await provider.getAuthorization(captured.authorizationId ?? "")).status).toBe("PARTIALLY_CAPTURED");
  });
});

describe("core flow: delegated agent wallet", () => {
  it("authorizes an in-policy deal without a payer redirect, and the vault id never leaves the wallet table", async () => {
    const run = await startDeal("happy-path");

    // One-time consent: setup token -> vault id, stored server-side only.
    const setup = await provider.createVaultSetup({
      returnUrl: `${APP_URL}/api/paypal/vault-return`,
      cancelUrl: `${APP_URL}/policies`,
      idempotencyKey: idempotencyKey("vault_setup", run.owner),
    });
    await upsertWallet(db, { owner: run.owner, provider: provider.kind, status: "pending", setupTokenId: setup.setupTokenId, vaultId: null, payerEmailMasked: null });
    const token = await provider.exchangeVaultSetup(setup.setupTokenId, idempotencyKey("vault_exchange", setup.setupTokenId));
    await upsertWallet(db, { owner: run.owner, provider: provider.kind, status: "active", setupTokenId: null, vaultId: token.vaultId, payerEmailMasked: token.payerEmailMasked });

    await negotiate(run);
    const signed = await compile(run);
    expect((await evaluateSpend(run)).outcome).toBe("allow");

    const wallet = await getWallet(db, run.owner);
    if (!wallet?.vaultId) throw new Error("the wallet was not stored");
    elapse(2);
    const opened = await openOrder(payments, {
      dealId: run.dealId,
      signed,
      returnUrl: `${APP_URL}/api/paypal/return?deal=${run.dealId}`,
      cancelUrl: `${APP_URL}/api/paypal/cancel?deal=${run.dealId}`,
      vaultId: wallet.vaultId,
    });
    // Order and authorization in one PayPal call: no approval link, no redirect, funds already held.
    expect(opened.payment).toMatchObject({ status: "authorized", mode: "delegated", authorizedMinor: 4700, approveUrl: null });
    await settlePaymentStep(run, "authorized", opened);

    await deliver(run);
    await verify(run);
    const captured = await capture(run);
    expect(captured).toMatchObject({ status: "captured", mode: "delegated", capturedMinor: 4700 });

    const deal = await expectIntactRecord(run);
    expect(run.path.slice(-6)).toEqual(["contracted", "payment_pending", "authorized", "submitted", "verified", "completed"]);
    expect(run.captureGuard.map((verdict) => verdict === "allowed")).toEqual(run.path.map((status) => status === "verified"));
    expect(trailOf(deal).steps).toEqual([
      ...OPENING_TRAIL,
      "payment.order_created",
      "payment.authorized",
      "delivery.submitted",
      "verification.completed",
      "payment.captured",
      "deal.completed",
    ]);
    expect(await operationsOf(run)).toEqual(["create_order:succeeded:1", "capture:succeeded:1"]);
    // The vault id is a credential: it must not surface in the audit trail, the ledger or the payment record.
    const exposed = JSON.stringify([deal.audit, deal.payment, await listPaymentOperations(db, run.dealId)]);
    expect(exposed).not.toContain(wallet.vaultId);
    expect(exposed).not.toContain(setup.setupTokenId);
  });
});

describe("core flow: failures and confirmations around the money path", () => {
  it("model outage: the agents fall back, verification degrades to human review, and only a human release captures", async () => {
    const run = await startDeal("happy-path", createAgents({ mode: "ai", call: modelOutage }));
    const negotiation = await negotiate(run);
    // The scripted stand-ins negotiated the same deal the scripted mode does.
    expect(negotiation.agreedTerms).toMatchObject({ priceMinor: 4700 });
    expect(negotiation.moves.every((move) => move.source === "scripted" && move.model === null)).toBe(true);
    await compile(run);
    await evaluateSpend(run);
    await authorizeFunds(run);

    const submission = await deliver(run);
    expect(submission).toMatchObject({ source: "scripted", model: null });
    const report = await verify(run);
    // The work is complete, but nobody judged the brief: that is never enough to move money.
    expect(report).toMatchObject({ decision: "human_review", degraded: true, failedRuleIds: [], confidence: 0 });
    const aiCheck = report.checks.find((check) => check.evaluator === "ai");
    expect(aiCheck).toMatchObject({ kind: "brief_adherence", result: "uncertain", confidence: 0 });
    expect(aiCheck?.explanation).toContain("The AI verifier was unavailable (timeout)");
    expect(report.checks.filter((check) => check.evaluator === "deterministic").every((check) => check.result === "pass")).toBe(true);
    expect(run.captureGuard[run.captureGuard.length - 1]).toEqual(["status_not_verified", "human_release_missing"]);

    await humanDecides(run, "release_payment", "verified", "human.released_payment");
    const captured = await capture(run);
    expect(captured).toMatchObject({ status: "captured", capturedMinor: 4700 });

    const deal = await expectIntactRecord(run);
    expect(deal.deal).toMatchObject({ status: "completed", aiDegraded: true, humanDecision: { kind: "release_payment" } });
    expect(trailOf(deal).steps.slice(-6)).toEqual([
      "verification.completed",
      "verification.review_requested",
      "system.degraded",
      "human.released_payment",
      "payment.captured",
      "deal.completed",
    ]);
  });

  it("webhook: PayPal's capture confirmation is matched to the deal, applied once, and a contradicting one changes nothing", async () => {
    const run = await startDeal("happy-path");
    await negotiate(run);
    const signed = await compile(run);
    await evaluateSpend(run);
    await authorizeFunds(run);
    await deliver(run);
    await verify(run);
    const captured = await capture(run);

    const captureCompleted = (eventId: string, amountMinor: number) => ({
      id: eventId,
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: captured.captureId,
        status: "COMPLETED",
        amount: { currency_code: "USD", value: toPayPalValue(amountMinor) },
        custom_id: paypalCustomId(signed),
        invoice_id: signed.contract.contractId,
        final_capture: true,
        supplementary_data: { related_ids: { order_id: captured.orderId, authorization_id: captured.authorizationId } },
      },
    });

    /** What the webhook route does after the signature has been verified. */
    async function receive(payload: ReturnType<typeof captureCompleted>): Promise<"applied" | "duplicate" | "not_applied"> {
      elapse(5);
      const effect = interpretWebhookEvent(payload);
      const delivery = await recordWebhookEvent(db, {
        id: effect.eventId,
        eventType: effect.eventType,
        resourceId: effect.resourceId,
        verified: true,
        verificationMethod: "simulated",
        payload,
      });
      if (delivery.processed) return "duplicate";
      const dealId = effect.captureId === null ? null : await findDealIdByCaptureId(db, effect.captureId);
      if (dealId === null) throw new Error("the webhook could not be matched to a deal");
      const changed = await withTransaction(db, async (tx) => {
        // The row lock keeps a webhook and a step from overwriting each other's payment record.
        const payment = await getPayment(tx, dealId, { forUpdate: true });
        if (!payment) throw new Error("the matched deal has no payment");
        const application = applyWebhookEffect(payment, effect, now());
        if (application.changed) await upsertPayment(tx, dealId, application.payment);
        await appendAudit(tx, dealId, application.events);
        await markWebhookProcessed(tx, effect.eventId, dealId);
        return application.changed;
      });
      return changed ? "applied" : "not_applied";
    }

    expect(await receive(captureCompleted("WH-CORE-FLOW-0001", 4700))).toBe("applied");
    expect(paymentOf(await load(run))).toMatchObject({
      status: "captured",
      capturedMinor: 4700,
      webhookConfirmed: { authorized: false, captured: true, voided: false },
    });
    // PayPal redelivers until it gets a 2xx; the second delivery must be a no-op.
    expect(await receive(captureCompleted("WH-CORE-FLOW-0001", 4700))).toBe("duplicate");
    // A confirmation for a different amount is recorded as a mismatch and applied to nothing.
    expect(await receive(captureCompleted("WH-CORE-FLOW-0002", 9900))).toBe("not_applied");

    const deal = await expectIntactRecord(run);
    expect(deal.payment).toMatchObject({ capturedMinor: 4700, webhookConfirmed: { captured: true } });
    const webhooks = deal.audit.filter((event) => event.type === "payment.webhook");
    expect(webhooks.map((event) => event.data)).toMatchObject([
      { eventId: "WH-CORE-FLOW-0001", confirmed: "captured" },
      { eventId: "WH-CORE-FLOW-0002", mismatch: true },
    ]);
  });
});

describe("core flow: the stored audit trail is tamper-evident", () => {
  it("detects an event rewritten directly in the database", async () => {
    const run = await startDeal("happy-path");
    await negotiate(run);
    await compile(run);
    const before = await expectIntactRecord(run);
    const agreed = before.audit.find((event) => event.type === "negotiation.agreed");
    if (!agreed) throw new Error("the negotiation.agreed event is missing");

    await db
      .update(auditEvents)
      .set({ title: "Terms agreed at $4.70" })
      .where(and(eq(auditEvents.dealId, run.dealId), eq(auditEvents.seq, agreed.seq)));

    const after = await load(run);
    expect(verifyAuditChain(after.audit)).toEqual({ valid: false, brokenAtSeq: agreed.seq });
  });
});
