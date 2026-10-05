/**
 * Payment orchestrator — the ONLY code in PACT that moves money.
 *
 * It is deterministic and has no LLM anywhere near it: every function takes a signed contract
 * and a payment record, re-checks its own preconditions (even though callers ran the domain
 * guards), asks PayPal for PayPal's view of the order or authorization, and only then acts.
 *
 * Shared rules:
 *  - Every mutating PayPal call goes through the idempotency ledger under a deterministic key
 *    that is also sent as PayPal-Request-Id. A recorded success is replayed from the ledger; an
 *    interrupted or transiently failed attempt is resent with the SAME key; a terminal failure
 *    is never re-attempted.
 *  - Records are never mutated: each function returns a NEW PaymentRecord, and every status
 *    change is validated against the payment state machine.
 *  - Outcome contract. A function RETURNS when the payment reached (or already was in) a
 *    definite state for that step — including the terminal "failed" and "expired". It THROWS a
 *    PaymentStepError when the step could not complete and the payment did not move on: the
 *    error carries the record (with lastError set) and the audit events, so the caller can
 *    persist both, and `retryable` says whether calling again with the same input is useful.
 *  - Audit events are plain language and carry ids, amounts and idempotency keys — never secrets.
 */
import { paypalCustomId, paypalDescription, paypalInvoiceId, verifyContractHash } from "../domain/contract";
import { assertNever, truncate } from "../domain/format";
import { CURRENCY, assertMinor, formatMoney, isMinor } from "../domain/money";
import type { AuditActor, AuditEventInput, AuditEventType, SignedContract } from "../domain/schemas";
import { assertPaymentTransition, type PaymentStatus } from "../domain/status";
import { log } from "../observability/logger";
import { idempotencyKey } from "./idempotency";
import { CaptureInfoSchema, OrderInfoSchema } from "./info-schemas";
import {
  PaymentError,
  type ApprovalMode,
  type AuthorizationInfo,
  type CaptureInfo,
  type OrderInfo,
  type PaymentLedger,
  type PaymentOperationKind,
  type PaymentProvider,
  type PaymentRecord,
  type ProviderKind,
} from "./types";

export interface OrchestratorDeps {
  provider: PaymentProvider;
  ledger: PaymentLedger;
  now?: () => Date;
}

export interface PaymentStepResult {
  payment: PaymentRecord;
  events: AuditEventInput[];
}

/**
 * A payment step that could not complete. `payment` is the record to persist (its status is
 * unchanged or an intermediate legal one, with lastError set unless it is already settled) and
 * `events` are the audit events to append. Still a PaymentError: `issue`, `debugId` and
 * `retryable` describe what went wrong.
 */
export class PaymentStepError extends PaymentError {
  readonly payment: PaymentRecord;
  readonly events: AuditEventInput[];

  constructor(error: PaymentError, payment: PaymentRecord, events: AuditEventInput[]) {
    super({
      issue: error.issue,
      message: error.message,
      httpStatus: error.httpStatus,
      debugId: error.debugId,
      retryable: error.retryable,
      cause: error,
    });
    this.name = "PaymentStepError";
    this.payment = payment;
    this.events = events;
  }
}

/* -------------------------------------------------------------------------- */
/*  Records                                                                    */
/* -------------------------------------------------------------------------- */

const AUDIT_TITLE_MAX = 200;
const AUDIT_DETAIL_MAX = 800;
const NOTE_TO_PAYER_MAX = 255;

/** Statuses after which nothing about the payment can change any more. */
const SETTLED: ReadonlySet<PaymentStatus> = new Set<PaymentStatus>(["captured", "voided", "expired", "failed"]);

export function newPaymentRecord(provider: ProviderKind, mode: ApprovalMode, amountMinor: number, now: Date): PaymentRecord {
  assertMinor(amountMinor, "payment amount");
  return {
    provider,
    mode,
    status: "none",
    orderId: null,
    authorizationId: null,
    captureId: null,
    amountMinor,
    authorizedMinor: 0,
    capturedMinor: 0,
    currency: CURRENCY,
    approveUrl: null,
    authorizationExpiresAt: null,
    payerEmailMasked: null,
    lastError: null,
    webhookConfirmed: { authorized: false, captured: false, voided: false },
    updatedAt: now.toISOString(),
  };
}

function clock(deps: OrchestratorDeps): Date {
  return deps.now ? deps.now() : new Date();
}

type RecordPatch = Partial<Omit<PaymentRecord, "status" | "updatedAt">>;

/** A new record in a new status. Throws IllegalTransitionError if the state machine forbids the move. */
function move(payment: PaymentRecord, to: PaymentStatus, patch: RecordPatch, now: Date): PaymentRecord {
  assertPaymentTransition(payment.status, to);
  return { ...payment, ...patch, status: to, updatedAt: now.toISOString() };
}

/** A new record in the same status. */
function amend(payment: PaymentRecord, patch: RecordPatch, now: Date): PaymentRecord {
  return { ...payment, ...patch, updatedAt: now.toISOString() };
}

function lastErrorOf(error: PaymentError, now: Date): NonNullable<PaymentRecord["lastError"]> {
  return { issue: error.issue, message: error.message, debugId: error.debugId, at: now.toISOString() };
}

function refusal(issue: string, message: string, retryable = false): PaymentError {
  return new PaymentError({ issue, message, retryable });
}

/** The step failed and the payment stays where it is. Settled records are never annotated after the fact. */
function stepError(payment: PaymentRecord, error: PaymentError, events: AuditEventInput[], now: Date): PaymentStepError {
  const record = SETTLED.has(payment.status) ? payment : amend(payment, { lastError: lastErrorOf(error, now) }, now);
  return new PaymentStepError(error, record, events);
}

/* -------------------------------------------------------------------------- */
/*  Audit events                                                               */
/* -------------------------------------------------------------------------- */

function providerName(kind: ProviderKind): string {
  switch (kind) {
    case "paypal_sandbox":
      return "PayPal";
    case "simulated":
      // Simulated payments are labelled as such everywhere a human can read them.
      return "Simulated PayPal";
    default:
      return assertNever(kind);
  }
}

function audit(
  now: Date,
  actor: AuditActor,
  type: AuditEventType,
  title: string,
  data: Record<string, unknown>,
  detail: string | null = null,
): AuditEventInput {
  return {
    actor,
    type,
    title: truncate(title, AUDIT_TITLE_MAX),
    detail: detail === null ? null : truncate(detail, AUDIT_DETAIL_MAX),
    data,
    at: now.toISOString(),
  };
}

function ids(payment: PaymentRecord): Record<string, unknown> {
  return {
    provider: payment.provider,
    mode: payment.mode,
    orderId: payment.orderId,
    authorizationId: payment.authorizationId,
    captureId: payment.captureId,
  };
}

function errorData(error: PaymentError): Record<string, unknown> {
  return { issue: error.issue, debugId: error.debugId, httpStatus: error.httpStatus };
}

/* -------------------------------------------------------------------------- */
/*  Guards                                                                     */
/* -------------------------------------------------------------------------- */

interface Violation {
  issue: string;
  /** Lower-case clause that completes "<Action> blocked: …". */
  message: string;
  data: Record<string, unknown>;
}

/** The contract itself must be intact and belong to this deal before any money is committed to it. */
function contractViolation(dealId: string, signed: SignedContract): Violation | null {
  if (!verifyContractHash(signed)) {
    return {
      issue: "CONTRACT_HASH_INVALID",
      message: "the contract no longer matches its terms hash",
      data: { termsHash: signed.termsHash },
    };
  }
  if (signed.contract.dealId !== dealId) {
    return {
      issue: "CONTRACT_DEAL_MISMATCH",
      message: "the contract belongs to a different deal",
      data: { contractDealId: signed.contract.dealId },
    };
  }
  return null;
}

/** PayPal's own record must name this contract's terms hash and exactly its price. */
function bindingViolation(
  what: "order" | "authorization",
  actual: { amountMinor: number; customId: string | null },
  signed: SignedContract,
): Violation | null {
  const expectedCustomId = paypalCustomId(signed);
  const priceMinor = signed.contract.price.amountMinor;
  if (actual.customId !== expectedCustomId) {
    return {
      issue: "ORDER_CONTRACT_MISMATCH",
      message: `PayPal's ${what} is not bound to this contract's terms hash`,
      data: { expectedCustomId, actualCustomId: actual.customId },
    };
  }
  if (actual.amountMinor !== priceMinor) {
    return {
      issue: "ORDER_CONTRACT_MISMATCH",
      message: `PayPal's ${what} is for ${formatMoney(actual.amountMinor)} but the contract price is ${formatMoney(priceMinor)}`,
      data: { expectedMinor: priceMinor, actualMinor: actual.amountMinor },
    };
  }
  return null;
}

function captureAmountViolation(payment: PaymentRecord, signed: SignedContract, amountMinor: number): Violation | null {
  const priceMinor = signed.contract.price.amountMinor;
  if (payment.capturedMinor !== 0) {
    return {
      issue: "ALREADY_CAPTURED",
      message: `${formatMoney(payment.capturedMinor)} has already been captured for this payment`,
      data: { capturedMinor: payment.capturedMinor },
    };
  }
  if (!isMinor(amountMinor) || amountMinor === 0) {
    return {
      issue: "INVALID_CAPTURE_AMOUNT",
      message: "the capture amount must be a positive whole number of cents",
      data: { amountMinor },
    };
  }
  if (amountMinor > payment.authorizedMinor) {
    return {
      issue: "CAPTURE_EXCEEDS_AUTHORIZATION",
      message: `${formatMoney(amountMinor)} is more than the ${formatMoney(payment.authorizedMinor)} that was authorized`,
      data: { amountMinor, authorizedMinor: payment.authorizedMinor },
    };
  }
  if (amountMinor > priceMinor) {
    return {
      issue: "CAPTURE_EXCEEDS_CONTRACT",
      message: `${formatMoney(amountMinor)} is more than the contract price of ${formatMoney(priceMinor)}`,
      data: { amountMinor, priceMinor },
    };
  }
  return null;
}

/** A guard refused the step. Nothing was sent to PayPal for it; the payment stays where it is. */
function blocked(
  payment: PaymentRecord,
  action: "Order creation" | "Authorization" | "Capture",
  violation: Violation,
  now: Date,
  priorEvents: AuditEventInput[] = [],
): PaymentStepError {
  const sentence = `${action} blocked: ${violation.message}`;
  const event = audit(now, "payment_orchestrator", "payment.capture_blocked", sentence, {
    reason: violation.issue,
    ...ids(payment),
    ...violation.data,
  });
  return stepError(payment, refusal(violation.issue, sentence), [...priorEvents, event], now);
}

/* -------------------------------------------------------------------------- */
/*  Idempotency ledger                                                         */
/* -------------------------------------------------------------------------- */

interface LedgeredOperation<T> {
  key: string;
  dealId: string;
  kind: PaymentOperationKind;
  /** What is being asked for — recorded for the audit trail, so never a credential. */
  request: Record<string, unknown>;
  call: () => Promise<T>;
  store: (value: T) => Record<string, unknown>;
  restore: (stored: Record<string, unknown>) => T;
  /**
   * Non-null when PayPal accepted the call but its outcome is not final yet. The key is then kept
   * retryable, so the next attempt asks PayPal again (same key) instead of replaying a stale answer.
   */
  unsettled?: (value: T) => string | null;
}

interface Ledgered<T> {
  value: T;
  /** True when the value came from the ledger and PayPal was not called. */
  replayed: boolean;
}

async function ledgered<T>(ledger: PaymentLedger, operation: LedgeredOperation<T>): Promise<Ledgered<T>> {
  const { key, dealId, kind } = operation;
  const begun = await ledger.begin({ key, dealId, kind, request: operation.request });
  switch (begun.state) {
    case "succeeded":
      return { value: operation.restore(begun.response), replayed: true };
    case "failed":
      // A terminal failure stays terminal for this key: surface it without touching PayPal again.
      throw new PaymentError({ ...begun.error, retryable: false });
    case "new":
    case "retry":
      break;
    default:
      return assertNever(begun);
  }

  let value: T;
  try {
    value = await operation.call();
  } catch (error) {
    // Anything that is not a PaymentError is a bug with an unknown outcome: the entry stays
    // "started", which a later begin() reports as "retry" — safe, because the key is resent.
    if (error instanceof PaymentError) {
      const { issue, message, debugId, retryable } = error;
      await record(key, kind, () => ledger.fail(key, { issue, message, debugId }, { retryable }));
    }
    throw error;
  }

  const pendingIssue = operation.unsettled?.(value) ?? null;
  if (pendingIssue === null) {
    await record(key, kind, () => ledger.succeed(key, operation.store(value)));
  } else {
    const pending = { issue: pendingIssue, message: "PayPal has not settled this operation yet", debugId: null };
    await record(key, kind, () => ledger.fail(key, pending, { retryable: true }));
  }
  return { value, replayed: false };
}

/**
 * Writing the outcome must not mask the outcome itself: PayPal has already answered. If the
 * write fails the entry stays "started", and the next attempt replays through PayPal-Request-Id.
 */
async function record(key: string, kind: PaymentOperationKind, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    log.error("payment.ledger_write_failed", { idempotencyKey: key, kind, error });
  }
}

/** Vault ids are credentials and stay out of the ledger; PACT keeps them only in the wallet record. */
function storeOrder(order: OrderInfo): Record<string, unknown> {
  return { ...order, vaultId: null };
}

function restoreOrder(stored: Record<string, unknown>): OrderInfo {
  return OrderInfoSchema.parse(stored);
}

const VOID_DONE = { voided: true } as const;

/* -------------------------------------------------------------------------- */
/*  Shared outcomes                                                            */
/* -------------------------------------------------------------------------- */

/** PayPal refused for good: the payment is over. */
function failed(
  payment: PaymentRecord,
  error: PaymentError,
  attempted: string,
  data: Record<string, unknown>,
  events: AuditEventInput[],
  now: Date,
): PaymentStepResult {
  const record = move(payment, "failed", { lastError: lastErrorOf(error, now), approveUrl: null }, now);
  const event = audit(
    now,
    "paypal",
    "payment.failed",
    `Payment failed: ${providerName(payment.provider)} would not ${attempted} (${error.issue})`,
    { ...ids(record), ...errorData(error), ...data },
    error.message,
  );
  return { payment: record, events: [...events, event] };
}

/** PayPal no longer holds the funds although PACT never captured or voided them. */
function lapsed(payment: PaymentRecord, error: PaymentError, now: Date): PaymentStepResult {
  const record = move(payment, "expired", { lastError: lastErrorOf(error, now) }, now);
  const event = audit(
    now,
    "paypal",
    "payment.expired",
    `${providerName(payment.provider)} no longer holds the ${formatMoney(payment.authorizedMinor)} authorization (${error.issue})`,
    { ...ids(record), ...errorData(error), amountMinor: payment.authorizedMinor },
    error.message,
  );
  return { payment: record, events: [event] };
}

async function readOrder(
  deps: OrchestratorDeps,
  payment: PaymentRecord,
  orderId: string,
  events: AuditEventInput[],
  now: Date,
): Promise<OrderInfo> {
  try {
    return await deps.provider.getOrder(orderId);
  } catch (error) {
    if (!(error instanceof PaymentError)) throw error;
    throw stepError(payment, error, events, now);
  }
}

async function readAuthorization(
  deps: OrchestratorDeps,
  payment: PaymentRecord,
  authorizationId: string,
  now: Date,
): Promise<AuthorizationInfo> {
  try {
    return await deps.provider.getAuthorization(authorizationId);
  } catch (error) {
    if (!(error instanceof PaymentError)) throw error;
    throw stepError(payment, error, [], now);
  }
}

/* -------------------------------------------------------------------------- */
/*  Authorization                                                              */
/* -------------------------------------------------------------------------- */

interface AuthorizationOutcome {
  signed: SignedContract;
  /** Record in "created" or "approved". */
  payment: PaymentRecord;
  order: OrderInfo;
  authorization: AuthorizationInfo;
  /** Key of the call that produced the authorization, or null when it was found on PayPal's order. */
  idempotencyKey: string | null;
  events: AuditEventInput[];
}

/** Turn an authorization PayPal reports for the order into the payment's next state. */
function settleAuthorization(outcome: AuthorizationOutcome, now: Date): PaymentStepResult {
  const { payment, order, authorization, events } = outcome;
  const mismatch = bindingViolation("authorization", authorization, outcome.signed);
  if (mismatch !== null) throw blocked(payment, "Authorization", mismatch, now, events);

  const name = providerName(payment.provider);
  switch (authorization.status) {
    case "CREATED": {
      const record = move(
        payment,
        "authorized",
        {
          authorizationId: authorization.authorizationId,
          authorizedMinor: authorization.amountMinor,
          authorizationExpiresAt: authorization.expiresAt,
          payerEmailMasked: order.payerEmailMasked ?? payment.payerEmailMasked,
          // The approval link has served its purpose; keeping it would invite a second approval.
          approveUrl: null,
          lastError: null,
        },
        now,
      );
      const event = audit(
        now,
        "paypal",
        "payment.authorized",
        `${name} authorized ${formatMoney(authorization.amountMinor)} — the funds are held, not captured`,
        {
          ...ids(record),
          amountMinor: authorization.amountMinor,
          expiresAt: authorization.expiresAt,
          customId: authorization.customId,
          idempotencyKey: outcome.idempotencyKey,
          adoptedFromPayPal: outcome.idempotencyKey === null,
        },
        payment.mode === "delegated"
          ? "Authorized against the delegated agent wallet; no payer interaction was needed."
          : null,
      );
      return { payment: record, events: [...events, event] };
    }
    case "PENDING":
      // PayPal accepted the request but is still reviewing it: nothing is held yet. Calling the
      // same step again later re-reads the order and picks up the final answer.
      throw stepError(
        payment,
        refusal("AUTHORIZATION_PENDING", `${name} is still reviewing the authorization; no funds are held yet.`, true),
        events,
        now,
      );
    case "DENIED":
    case "VOIDED":
      return failed(
        payment,
        refusal(`AUTHORIZATION_${authorization.status}`, `${name} reports the authorization as ${authorization.status.toLowerCase()}.`),
        "authorize the payment",
        { rejectedAuthorizationId: authorization.authorizationId },
        events,
        now,
      );
    case "CAPTURED":
    case "PARTIALLY_CAPTURED":
      // Funds moved on an order PACT never recorded as authorized. Nothing here may guess at
      // that: stop, keep the record as it is, and let reconciliation surface the difference.
      throw stepError(
        payment,
        refusal("AUTHORIZATION_ALREADY_CAPTURED", `${name} reports this order's authorization as already captured.`),
        events,
        now,
      );
    default:
      return assertNever(authorization.status);
  }
}

interface AuthorizeArgs {
  dealId: string;
  signed: SignedContract;
  /** Record in "created" or "approved", with `order.orderId` as its order. */
  payment: PaymentRecord;
  /** PayPal's current view of the order. */
  order: OrderInfo;
  events: AuditEventInput[];
}

async function authorizeFromOrder(deps: OrchestratorDeps, args: AuthorizeArgs, now: Date): Promise<PaymentStepResult> {
  const { dealId, signed, payment, order } = args;
  const name = providerName(payment.provider);

  const mismatch = bindingViolation("order", order, signed);
  if (mismatch !== null) throw blocked(payment, "Authorization", mismatch, now, args.events);

  switch (order.status) {
    case "APPROVED":
    case "COMPLETED":
      break;
    case "CREATED":
    case "SAVED":
    case "PAYER_ACTION_REQUIRED":
      throw stepError(
        payment,
        refusal("ORDER_NOT_APPROVED", `The payer has not approved this order in ${name} yet.`),
        args.events,
        now,
      );
    case "VOIDED": {
      const record = move(payment, "voided", { approveUrl: null, lastError: null }, now);
      const event = audit(
        now,
        "paypal",
        "payment.voided",
        `${name} reports the order as voided — no funds are held`,
        ids(record),
      );
      return { payment: record, events: [...args.events, event] };
    }
    default:
      return assertNever(order.status);
  }

  // An interactive order reaching this point means the payer consented in PayPal just now. A
  // delegated order carries the wallet's standing consent, so there is no approval to record.
  const payerApproved = payment.status === "created" && payment.mode === "interactive";
  const approved = payerApproved
    ? move(payment, "approved", { payerEmailMasked: order.payerEmailMasked ?? payment.payerEmailMasked, lastError: null }, now)
    : payment;
  const events = payerApproved
    ? [...args.events, audit(now, "paypal", "payment.approved", `The payer approved the order in ${name}`, ids(approved))]
    : args.events;

  if (order.status === "COMPLETED") {
    // Already authorized at PayPal (an earlier attempt got through, or a double submit): adopt
    // PayPal's authorization instead of asking for a second one.
    if (order.authorization === null) {
      throw stepError(
        approved,
        refusal("AUTHORIZATION_MISSING", `${name} shows the order as completed but returned no authorization.`, true),
        events,
        now,
      );
    }
    return settleAuthorization(
      { signed, payment: approved, order, authorization: order.authorization, idempotencyKey: null, events },
      now,
    );
  }

  const key = idempotencyKey("authorize", dealId, order.orderId);
  let authorizedOrder: OrderInfo;
  let adopted = false;
  try {
    const result = await ledgered(deps.ledger, {
      key,
      dealId,
      kind: "authorize",
      request: { orderId: order.orderId, amountMinor: order.amountMinor },
      call: () => deps.provider.authorizeOrder(order.orderId, key),
      store: storeOrder,
      restore: restoreOrder,
    });
    authorizedOrder = result.value;
  } catch (error) {
    if (!(error instanceof PaymentError)) throw error;
    if (error.retryable) throw stepError(approved, error, events, now);
    if (error.issue !== "ORDER_ALREADY_AUTHORIZED") {
      return failed(approved, error, "authorize the order", { idempotencyKey: key }, events, now);
    }
    // PayPal says an authorization already exists: read it back rather than fail a paid-for hold.
    authorizedOrder = await readOrder(deps, approved, order.orderId, events, now);
    adopted = true;
  }
  if (authorizedOrder.authorization === null) {
    throw stepError(
      approved,
      refusal("AUTHORIZATION_MISSING", `${name} accepted the authorization but returned no authorization id.`, true),
      events,
      now,
    );
  }
  return settleAuthorization(
    {
      signed,
      payment: approved,
      order: authorizedOrder,
      authorization: authorizedOrder.authorization,
      idempotencyKey: adopted ? null : key,
      events,
    },
    now,
  );
}

/* -------------------------------------------------------------------------- */
/*  1. Open the order                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Create the PayPal order for EXACTLY the contract price, bound to the terms hash via custom_id.
 *
 * Returns
 *  - "created" with an approveUrl (interactive; also when a delegated wallet turns out to need
 *    the payer's approval, in which case mode becomes "interactive");
 *  - "authorized" (delegated wallet: PayPal authorizes in the same call);
 *  - "failed" when PayPal refuses the order for good.
 * Throws PaymentStepError when PayPal could not be reached (retryable), when the contract or
 * PayPal's echo of the order fails a binding check (blocked), or while a delegated authorization
 * is still pending review (retryable; calling again re-reads the order).
 * If the thrown record is "created", an order exists: pass it to voidHeldFunds to abandon it.
 */
export async function openOrder(
  deps: OrchestratorDeps,
  input: { dealId: string; signed: SignedContract; returnUrl: string; cancelUrl: string; vaultId?: string },
): Promise<PaymentStepResult> {
  const now = clock(deps);
  const { dealId, signed, vaultId } = input;
  const delegated = vaultId !== undefined;
  // The amount is read from the contract here and nowhere else: no caller can supply a price.
  const amountMinor = signed.contract.price.amountMinor;
  const fresh = newPaymentRecord(deps.provider.kind, delegated ? "delegated" : "interactive", amountMinor, now);
  const name = providerName(fresh.provider);

  const violation = contractViolation(dealId, signed);
  if (violation !== null) throw blocked(fresh, "Order creation", violation, now);

  const key = idempotencyKey("create_order", dealId, signed.termsHash);
  const contractId = paypalInvoiceId(signed);
  let created: Ledgered<OrderInfo>;
  try {
    created = await ledgered(deps.ledger, {
      key,
      dealId,
      kind: "create_order",
      request: { contractId, termsHash: signed.termsHash, amountMinor, delegated },
      call: () =>
        deps.provider.createOrder({
          dealId,
          contractId,
          contractHash: signed.termsHash,
          amountMinor,
          currency: CURRENCY,
          description: paypalDescription(signed),
          returnUrl: input.returnUrl,
          cancelUrl: input.cancelUrl,
          idempotencyKey: key,
          ...(delegated ? { vaultId } : {}),
        }),
      store: storeOrder,
      restore: restoreOrder,
    });
  } catch (error) {
    if (!(error instanceof PaymentError)) throw error;
    if (error.retryable) throw stepError(fresh, error, [], now);
    // PayPal refused the order itself; the same key would only be refused again.
    return failed(fresh, error, "create the order", { idempotencyKey: key, amountMinor }, [], now);
  }

  const opened = move(
    fresh,
    "created",
    { orderId: created.value.orderId, approveUrl: created.value.approveUrl, payerEmailMasked: created.value.payerEmailMasked },
    now,
  );
  const events = [
    audit(
      now,
      "payment_orchestrator",
      "payment.order_created",
      delegated
        ? `${name} order created for ${formatMoney(amountMinor)} against the delegated agent wallet`
        : `${name} order created for ${formatMoney(amountMinor)} — waiting for the payer's approval`,
      {
        ...ids(opened),
        amountMinor,
        currency: CURRENCY,
        customId: paypalCustomId(signed),
        invoiceId: contractId,
        idempotencyKey: key,
        idempotentReplay: created.replayed,
      },
      "The order is for the exact contract price and carries the contract's terms hash, so PayPal's record is bound to this contract.",
    ),
  ];

  // The ledger remembers WHICH order was created; only PayPal knows what state it is in now.
  const order = created.replayed ? await readOrder(deps, opened, created.value.orderId, events, now) : created.value;

  const mismatch = bindingViolation("order", order, signed);
  if (mismatch !== null) throw blocked(opened, "Order creation", mismatch, now, events);

  if (order.authorization !== null) {
    return settleAuthorization(
      { signed, payment: opened, order, authorization: order.authorization, idempotencyKey: key, events },
      now,
    );
  }
  if (order.status === "APPROVED") {
    // Consent is already on the order (vaulted wallet, or a replay after the payer approved).
    return authorizeFromOrder(deps, { dealId, signed, payment: opened, order, events }, now);
  }
  if (order.approveUrl !== null) {
    if (!delegated) return { payment: amend(opened, { approveUrl: order.approveUrl }, now), events };
    // PayPal wants the payer in the loop despite the vaulted wallet (e.g. consent was revoked).
    const interactive = amend(opened, { mode: "interactive", approveUrl: order.approveUrl }, now);
    const notice = audit(
      now,
      "paypal",
      "payment.order_created",
      `${name} requires the payer's approval for this order — the delegated wallet could not be used on its own`,
      ids(interactive),
    );
    return { payment: interactive, events: [...events, notice] };
  }
  return failed(
    opened,
    refusal("UNEXPECTED_ORDER_STATE", `${name} returned the order in status ${order.status} with no way to approve it.`),
    "open the order for approval",
    { idempotencyKey: key, orderStatus: order.status },
    events,
    now,
  );
}

/* -------------------------------------------------------------------------- */
/*  2. Authorize an approved order                                             */
/* -------------------------------------------------------------------------- */

/**
 * Authorize the order after the payer came back from PayPal. The redirect itself is never
 * trusted: the order is read from PayPal first and must be APPROVED, for the contract price,
 * and bound to this contract's terms hash.
 *
 * Returns
 *  - "authorized" (also when PayPal already holds an authorization for the order — it is
 *    adopted, never duplicated — and unchanged with no events when the record already is);
 *  - "voided" when PayPal reports the order itself as voided;
 *  - "failed" when PayPal refuses the authorization for good (e.g. INSTRUMENT_DECLINED).
 * Throws PaymentStepError, leaving the payment in "created"/"approved", when the payer has not
 * approved yet (ORDER_NOT_APPROVED), when the order does not match the contract
 * (ORDER_CONTRACT_MISMATCH, with a payment.capture_blocked event — if an authorization exists,
 * voidHeldFunds releases it), when PayPal is unreachable or the authorization is pending
 * (retryable), and for a record in any other status (INVALID_PAYMENT_STATE).
 */
export async function authorizeApprovedOrder(
  deps: OrchestratorDeps,
  input: { dealId: string; signed: SignedContract; payment: PaymentRecord },
): Promise<PaymentStepResult> {
  const now = clock(deps);
  const { dealId, signed, payment } = input;
  // The return redirect can be submitted twice; the second time there is nothing left to do.
  if (payment.status === "authorized") return { payment, events: [] };
  if ((payment.status !== "created" && payment.status !== "approved") || payment.orderId === null) {
    throw stepError(
      payment,
      refusal("INVALID_PAYMENT_STATE", `A payment that is ${payment.status} has no order waiting to be authorized.`),
      [],
      now,
    );
  }
  const violation = contractViolation(dealId, signed);
  if (violation !== null) throw blocked(payment, "Authorization", violation, now);

  const order = await readOrder(deps, payment, payment.orderId, [], now);
  return authorizeFromOrder(deps, { dealId, signed, payment, order, events: [] }, now);
}

/* -------------------------------------------------------------------------- */
/*  3. Capture                                                                 */
/* -------------------------------------------------------------------------- */

function captureNote(signed: SignedContract): string {
  return truncate(`PACT: delivery verified against contract ${signed.contract.contractId}.`, NOTE_TO_PAYER_MAX);
}

interface CaptureContext {
  payment: PaymentRecord;
  authorizationId: string;
  requestedMinor: number;
  reportId: string;
  idempotencyKey: string;
}

function captured(
  context: CaptureContext,
  capture: { captureId: string | null; amountMinor: number },
  extra: Record<string, unknown>,
  now: Date,
): PaymentStepResult {
  const { payment } = context;
  const name = providerName(payment.provider);
  const record = move(
    payment,
    "captured",
    { captureId: capture.captureId ?? payment.captureId, capturedMinor: capture.amountMinor, lastError: null },
    now,
  );
  const releasedMinor = Math.max(0, payment.authorizedMinor - capture.amountMinor);
  const event = audit(
    now,
    "paypal",
    "payment.captured",
    releasedMinor > 0
      ? `${name} captured ${formatMoney(capture.amountMinor)} of the ${formatMoney(payment.authorizedMinor)} authorized — ` +
          `${formatMoney(releasedMinor)} is released back to the payer`
      : `${name} captured ${formatMoney(capture.amountMinor)} — the seller is paid`,
    {
      ...ids(record),
      amountMinor: capture.amountMinor,
      requestedMinor: context.requestedMinor,
      authorizedMinor: payment.authorizedMinor,
      releasedMinor,
      finalCapture: true,
      reportId: context.reportId,
      idempotencyKey: context.idempotencyKey,
      ...extra,
    },
  );
  return { payment: record, events: [event] };
}

function settleCapture(context: CaptureContext, capture: CaptureInfo, replayed: boolean, now: Date): PaymentStepResult {
  const { payment } = context;
  const name = providerName(payment.provider);
  switch (capture.status) {
    case "COMPLETED":
      return captured(context, capture, { idempotentReplay: replayed }, now);
    case "REFUNDED":
    case "PARTIALLY_REFUNDED":
      // Seen only on a replay: the capture completed earlier and was refunded since. The capture
      // still happened, and that is what this record tracks.
      return captured(context, capture, { idempotentReplay: replayed, refundStatus: capture.status }, now);
    case "PENDING": {
      // PayPal created the capture but has not moved the money. Not paid yet: stay authorized.
      const pending = refusal(
        "CAPTURE_PENDING",
        `${name} accepted the capture but it is still pending; the seller has not been paid yet.`,
        true,
      );
      const record = amend(payment, { captureId: capture.captureId, lastError: lastErrorOf(pending, now) }, now);
      // Its own event type: "PayPal has not settled yet" must not be counted as "PACT refused to capture".
      const event = audit(
        now,
        "paypal",
        "payment.capture_pending",
        `Capture of ${formatMoney(capture.amountMinor)} is pending at ${name} — not paid yet`,
        {
          ...ids(record),
          reason: pending.issue,
          amountMinor: capture.amountMinor,
          reportId: context.reportId,
          idempotencyKey: context.idempotencyKey,
        },
        "The funds stay authorized. The capture is confirmed by asking again with the same idempotency key, or by PayPal's webhook.",
      );
      return { payment: record, events: [event] };
    }
    case "DECLINED":
    case "FAILED":
      return failed(
        amend(payment, { captureId: capture.captureId }, now),
        refusal(`CAPTURE_${capture.status}`, `${name} reports the capture as ${capture.status.toLowerCase()}.`),
        "capture the authorization",
        { amountMinor: capture.amountMinor, reportId: context.reportId, idempotencyKey: context.idempotencyKey },
        [],
        now,
      );
    default:
      return assertNever(capture.status);
  }
}

/**
 * PayPal says the authorization was captured by an earlier request we have no result for
 * (a crash after a successful capture whose idempotency record is gone). Read the authorization
 * back and adopt the capture — a second capture is never attempted.
 */
async function adoptExistingCapture(
  deps: OrchestratorDeps,
  context: CaptureContext,
  cause: PaymentError,
  now: Date,
): Promise<PaymentStepResult> {
  const { payment } = context;
  const authorization = await readAuthorization(deps, payment, context.authorizationId, now);
  const adoption = { adoptedFromPayPal: true, paypalAuthorizationStatus: authorization.status, ...errorData(cause) };
  if (authorization.status === "CAPTURED") {
    // PayPal's definition of CAPTURED: the captures cover the full authorized amount.
    return captured(context, { captureId: null, amountMinor: authorization.amountMinor }, adoption, now);
  }
  if (authorization.status === "PARTIALLY_CAPTURED" && context.requestedMinor < authorization.amountMinor) {
    // PayPal confirms a partial capture but not its size; the only capture PACT ever requests
    // for this authorization is the one being retried, so its amount is recorded and flagged.
    return captured(context, { captureId: null, amountMinor: context.requestedMinor }, { ...adoption, amountInferred: true }, now);
  }
  throw stepError(
    payment,
    refusal(
      "CAPTURE_STATE_UNKNOWN",
      `${providerName(payment.provider)} refused the capture as already captured, but reports the authorization as ${authorization.status}.`,
    ),
    [],
    now,
  );
}

/**
 * Capture a verified delivery. `amountMinor` is the full contract price, or less for a
 * human-approved partial release; the capture is always final, so any remainder is released.
 *
 * Returns
 *  - "captured" with capturedMinor / captureId (also when an earlier capture is adopted);
 *  - "authorized" with lastError CAPTURE_PENDING (and a payment.capture_pending event) when PayPal
 *    accepted the capture but has not completed it — not paid yet; call again later (same key)
 *    or wait for the webhook;
 *  - "failed" when PayPal declines the capture or reports the authorization as denied;
 *  - "expired" when PayPal no longer holds the authorization (voided or expired on its side).
 * Throws PaymentStepError, leaving the payment "authorized", when a precondition or binding
 * check fails (payment.capture_blocked event; nothing is sent to PayPal), when PayPal is
 * unreachable (retryable), or when PayPal refuses the capture for another reason (the funds are
 * still held: the caller decides whether to void).
 */
export async function captureVerified(
  deps: OrchestratorDeps,
  input: { dealId: string; signed: SignedContract; payment: PaymentRecord; amountMinor: number; reportId: string },
): Promise<PaymentStepResult> {
  const now = clock(deps);
  const { dealId, signed, payment, amountMinor, reportId } = input;
  const name = providerName(payment.provider);

  // 1. Local preconditions, re-checked here even though the caller ran the domain guard.
  if (payment.status !== "authorized" || payment.authorizationId === null) {
    throw blocked(
      payment,
      "Capture",
      { issue: "INVALID_PAYMENT_STATE", message: `the payment is ${payment.status}, not authorized`, data: { status: payment.status } },
      now,
    );
  }
  const { authorizationId } = payment;
  const violation = contractViolation(dealId, signed) ?? captureAmountViolation(payment, signed, amountMinor);
  if (violation !== null) throw blocked(payment, "Capture", { ...violation, data: { ...violation.data, reportId } }, now);

  // 2. PayPal's own record of the authorization must still be bound to this contract.
  const authorization = await readAuthorization(deps, payment, authorizationId, now);
  const expectedCustomId = paypalCustomId(signed);
  if (authorization.customId !== expectedCustomId) {
    throw blocked(
      payment,
      "Capture",
      {
        issue: "ORDER_CONTRACT_MISMATCH",
        message: "PayPal's authorization is not bound to this contract's terms hash",
        data: { expectedCustomId, actualCustomId: authorization.customId, reportId },
      },
      now,
    );
  }
  if (authorization.amountMinor < amountMinor) {
    throw blocked(
      payment,
      "Capture",
      {
        issue: "CAPTURE_EXCEEDS_AUTHORIZATION",
        message: `PayPal holds ${formatMoney(authorization.amountMinor)}, less than the ${formatMoney(amountMinor)} to capture`,
        data: { amountMinor, paypalAuthorizedMinor: authorization.amountMinor, reportId },
      },
      now,
    );
  }
  switch (authorization.status) {
    case "CREATED":
      break;
    case "CAPTURED":
    case "PARTIALLY_CAPTURED":
      // Already captured at PayPal. The capture call below resolves it without capturing twice:
      // the same key replays our own earlier capture, anything else is answered with
      // AUTHORIZATION_ALREADY_CAPTURED and adopted.
      break;
    case "VOIDED":
      return lapsed(payment, refusal("AUTHORIZATION_VOIDED", `${name} reports the authorization as voided.`), now);
    case "DENIED":
      return failed(
        payment,
        refusal("AUTHORIZATION_DENIED", `${name} reports the authorization as denied.`),
        "capture the authorization",
        { reportId },
        [],
        now,
      );
    case "PENDING":
      throw stepError(payment, refusal("AUTHORIZATION_PENDING", `${name} is still reviewing the authorization.`, true), [], now);
    default:
      return assertNever(authorization.status);
  }

  // 3. Capture — once. The key depends only on the deal and the authorization, so no retry,
  //    double click or concurrent request can ever produce a second capture.
  const key = idempotencyKey("capture", dealId, authorizationId);
  const context: CaptureContext = { payment, authorizationId, requestedMinor: amountMinor, reportId, idempotencyKey: key };
  try {
    const result = await ledgered(deps.ledger, {
      key,
      dealId,
      kind: "capture",
      request: { authorizationId, amountMinor, invoiceId: paypalInvoiceId(signed), reportId, finalCapture: true },
      call: () =>
        deps.provider.captureAuthorization({
          authorizationId,
          amountMinor,
          currency: CURRENCY,
          finalCapture: true,
          invoiceId: paypalInvoiceId(signed),
          noteToPayer: captureNote(signed),
          idempotencyKey: key,
        }),
      store: (capture) => ({ ...capture }),
      restore: (stored) => CaptureInfoSchema.parse(stored),
      unsettled: (capture) => (capture.status === "PENDING" ? "CAPTURE_PENDING" : null),
    });
    return settleCapture(context, result.value, result.replayed, now);
  } catch (error) {
    if (!(error instanceof PaymentError) || error instanceof PaymentStepError) throw error;
    if (error.issue === "AUTHORIZATION_ALREADY_CAPTURED") return adoptExistingCapture(deps, context, error, now);
    if (error.issue === "AUTHORIZATION_VOIDED" || error.issue === "AUTHORIZATION_EXPIRED") return lapsed(payment, error, now);
    if (error.retryable) throw stepError(payment, error, [], now);
    // PayPal refused, but the authorization may well still be open: the funds stay held and the
    // payment stays "authorized", so the caller can still void it.
    const event = audit(
      now,
      "paypal",
      "payment.failed",
      `Capture attempt refused by ${name} (${error.issue}) — the funds remain authorized, nothing was captured`,
      { ...ids(payment), ...errorData(error), amountMinor, reportId, idempotencyKey: key },
      error.message,
    );
    throw stepError(payment, error, [event], now);
  }
}

/* -------------------------------------------------------------------------- */
/*  4. Void                                                                    */
/* -------------------------------------------------------------------------- */

interface ReleaseArgs {
  dealId: string;
  payment: PaymentRecord;
  authorizationId: string;
  heldMinor: number;
  reason: string;
}

async function releaseAuthorization(deps: OrchestratorDeps, args: ReleaseArgs, now: Date): Promise<PaymentStepResult> {
  const { dealId, payment, authorizationId, heldMinor, reason } = args;
  const name = providerName(payment.provider);
  const key = idempotencyKey("void", dealId, authorizationId);
  let alreadyVoided = false;
  try {
    await ledgered(deps.ledger, {
      key,
      dealId,
      kind: "void",
      request: { authorizationId, reason },
      call: async () => {
        await deps.provider.voidAuthorization(authorizationId, key);
        return VOID_DONE;
      },
      store: (done) => ({ ...done }),
      restore: () => VOID_DONE,
    });
  } catch (error) {
    if (!(error instanceof PaymentError)) throw error;
    if (error.issue === "PREVIOUSLY_VOIDED" || error.issue === "AUTHORIZATION_VOIDED") {
      // PayPal already considers the hold released — the outcome that was asked for.
      alreadyVoided = true;
    } else if (error.retryable) {
      throw stepError(payment, error, [], now);
    } else {
      // Includes PREVIOUSLY_CAPTURED: captured funds cannot be voided, and PACT must not pretend they were.
      const event = audit(
        now,
        "paypal",
        "payment.failed",
        `Void refused by ${name} (${error.issue}) — the authorization was not released`,
        { ...ids(payment), ...errorData(error), authorizationId, idempotencyKey: key, reason },
        error.message,
      );
      throw stepError(payment, error, [event], now);
    }
  }
  const record = move(payment, "voided", { authorizationId, approveUrl: null, lastError: null }, now);
  const event = audit(
    now,
    "payment_orchestrator",
    "payment.voided",
    `Authorization voided — ${formatMoney(heldMinor)} released back to the payer, nothing was captured`,
    { ...ids(record), amountMinor: heldMinor, idempotencyKey: key, reason, alreadyVoidedAtPayPal: alreadyVoided },
    reason,
  );
  return { payment: record, events: [event] };
}

/**
 * Release whatever is held for the deal.
 *
 * Returns "voided": for an authorized payment after voiding the authorization at PayPal
 * (PREVIOUSLY_VOIDED / AUTHORIZATION_VOIDED count as success); for an order that was never
 * authorized after confirming with PayPal that nothing is held — and if an authorization PACT
 * never recorded turns out to exist (an interrupted authorize), it is voided first. A record
 * that is already "voided" is returned unchanged with no events.
 * Throws PaymentStepError, leaving the payment as it is, when PayPal is unreachable (retryable),
 * when PayPal refuses the void — notably PREVIOUSLY_CAPTURED: captured funds cannot be voided —
 * and for a record with nothing to void (none / captured / expired / failed: INVALID_PAYMENT_STATE).
 */
export async function voidHeldFunds(
  deps: OrchestratorDeps,
  input: { dealId: string; payment: PaymentRecord; reason: string },
): Promise<PaymentStepResult> {
  const now = clock(deps);
  const { dealId, payment, reason } = input;
  switch (payment.status) {
    case "voided":
      return { payment, events: [] };
    case "authorized":
      if (payment.authorizationId === null) {
        throw stepError(payment, refusal("INVALID_PAYMENT_STATE", "The authorized payment has no authorization id to void."), [], now);
      }
      return releaseAuthorization(
        deps,
        { dealId, payment, authorizationId: payment.authorizationId, heldMinor: payment.authorizedMinor, reason },
        now,
      );
    case "created":
    case "approved":
      return abandonOrder(deps, { dealId, payment, reason }, now);
    case "captured":
      throw stepError(payment, refusal("INVALID_PAYMENT_STATE", "Captured funds cannot be voided."), [], now);
    case "none":
    case "expired":
    case "failed":
      throw stepError(payment, refusal("INVALID_PAYMENT_STATE", `A payment that is ${payment.status} holds nothing to void.`), [], now);
    default:
      return assertNever(payment.status);
  }
}

async function abandonOrder(
  deps: OrchestratorDeps,
  args: { dealId: string; payment: PaymentRecord; reason: string },
  now: Date,
): Promise<PaymentStepResult> {
  const { dealId, payment, reason } = args;
  // PACT has not recorded an authorization, but an authorize call may have reached PayPal without
  // its answer ever being stored. Ask PayPal instead of assuming nothing is held.
  if (payment.orderId !== null) {
    let order: OrderInfo | null;
    try {
      order = await deps.provider.getOrder(payment.orderId);
    } catch (error) {
      if (!(error instanceof PaymentError)) throw error;
      if (error.issue !== "INVALID_RESOURCE_ID") throw stepError(payment, error, [], now);
      // PayPal no longer knows the order (it lapsed unapproved), so nothing can be held on it.
      order = null;
    }
    const held = order?.authorization ?? null;
    if (held !== null && (held.status === "CREATED" || held.status === "PENDING")) {
      return releaseAuthorization(
        deps,
        { dealId, payment, authorizationId: held.authorizationId, heldMinor: held.amountMinor, reason },
        now,
      );
    }
    if (held !== null && (held.status === "CAPTURED" || held.status === "PARTIALLY_CAPTURED")) {
      // Money has moved on this order. Calling it "voided" would be false; reconciliation must surface it.
      throw stepError(
        payment,
        refusal("PREVIOUSLY_CAPTURED", `${providerName(payment.provider)} reports this order's authorization as captured; it cannot be voided.`),
        [],
        now,
      );
    }
  }
  const record = move(payment, "voided", { approveUrl: null, lastError: null }, now);
  const event = audit(
    now,
    "payment_orchestrator",
    "payment.voided",
    "Order abandoned before authorization — no funds were ever held",
    { ...ids(record), amountMinor: 0, reason },
    reason,
  );
  return { payment: record, events: [event] };
}

/* -------------------------------------------------------------------------- */
/*  5. Reconcile                                                               */
/* -------------------------------------------------------------------------- */

export type ReconcileResult = PaymentStepResult & {
  /** One plain-language sentence per difference between PACT's record and PayPal's. Empty when in sync. */
  drift: string[];
};

/** PayPal authorization statuses that are consistent with each PACT payment status. */
const CONSISTENT_AUTHORIZATION: Record<PaymentStatus, readonly AuthorizationInfo["status"][]> = {
  none: [],
  created: [],
  approved: [],
  authorized: ["CREATED"],
  captured: ["CAPTURED", "PARTIALLY_CAPTURED"],
  voided: ["VOIDED"],
  expired: ["VOIDED"],
  failed: ["DENIED", "VOIDED"],
};

function isPast(iso: string | null, now: Date): boolean {
  if (iso === null) return false;
  const ms = Date.parse(iso);
  return !Number.isNaN(ms) && ms <= now.getTime();
}

function reconciled(before: PaymentRecord, after: PaymentRecord, drift: string[], now: Date): ReconcileResult {
  // No difference, no event: reconciliation runs often and must not flood the audit trail.
  if (drift.length === 0) return { payment: after, events: [], drift };
  const name = providerName(before.provider);
  const events = [
    audit(
      now,
      "payment_orchestrator",
      "payment.reconciled",
      `Reconciled with ${name}: ${drift.length === 1 ? "1 difference" : `${drift.length} differences`} found`,
      { ...ids(after), drift, statusBefore: before.status, statusAfter: after.status },
      drift.join(" "),
    ),
  ];
  if (after.status === "expired" && before.status !== "expired") {
    events.push(
      audit(
        now,
        "paypal",
        "payment.expired",
        before.status === "authorized"
          ? `${name} no longer holds the ${formatMoney(before.authorizedMinor)} authorization — the payment is marked expired`
          : `${name} no longer has the unapproved order — the payment is marked expired`,
        { ...ids(after), amountMinor: before.authorizedMinor },
      ),
    );
  }
  return { payment: after, events, drift };
}

async function reconcileAuthorization(
  deps: OrchestratorDeps,
  payment: PaymentRecord,
  authorizationId: string,
  now: Date,
): Promise<ReconcileResult> {
  const name = providerName(payment.provider);
  let authorization: AuthorizationInfo;
  try {
    authorization = await deps.provider.getAuthorization(authorizationId);
  } catch (error) {
    if (!(error instanceof PaymentError)) throw error;
    // A failed read says nothing about the payment, so the record is passed back untouched.
    if (error.issue !== "INVALID_RESOURCE_ID") throw new PaymentStepError(error, payment, []);
    return reconciled(payment, payment, [`${name} has no record of authorization ${authorizationId}.`], now);
  }

  const drift: string[] = [];
  // After its expiry time PayPal may keep listing a dead authorization as CREATED for a while.
  const lapsedButListed =
    payment.status === "expired" && authorization.status === "CREATED" && isPast(authorization.expiresAt ?? payment.authorizationExpiresAt, now);
  if (!CONSISTENT_AUTHORIZATION[payment.status].includes(authorization.status) && !lapsedButListed) {
    drift.push(`PACT records the payment as ${payment.status}, but ${name} reports the authorization as ${authorization.status}.`);
  }
  if (payment.authorizedMinor > 0 && authorization.amountMinor !== payment.authorizedMinor) {
    drift.push(`${name} holds ${formatMoney(authorization.amountMinor)}, PACT recorded ${formatMoney(payment.authorizedMinor)}.`);
  }
  if (payment.status !== "authorized") return reconciled(payment, payment, drift, now);

  const expiresAt = authorization.expiresAt ?? payment.authorizationExpiresAt;
  const expiredByTime = authorization.status === "CREATED" && isPast(expiresAt, now);
  if (expiredByTime) drift.push(`The authorization expired at ${expiresAt}.`);
  if (authorization.status === "VOIDED" || expiredByTime) {
    // PACT did not void it (the record would say so): PayPal released the hold, so it can no longer be captured.
    return reconciled(payment, move(payment, "expired", { authorizationExpiresAt: expiresAt }, now), drift, now);
  }
  if (expiresAt !== payment.authorizationExpiresAt) {
    drift.push(`The authorization expiry was updated from ${name}'s record.`);
    return reconciled(payment, amend(payment, { authorizationExpiresAt: expiresAt }, now), drift, now);
  }
  return reconciled(payment, payment, drift, now);
}

async function reconcileOrder(deps: OrchestratorDeps, payment: PaymentRecord, orderId: string, now: Date): Promise<ReconcileResult> {
  const name = providerName(payment.provider);
  const awaiting = payment.status === "created" || payment.status === "approved";
  let order: OrderInfo;
  try {
    order = await deps.provider.getOrder(orderId);
  } catch (error) {
    if (!(error instanceof PaymentError)) throw error;
    if (error.issue !== "INVALID_RESOURCE_ID") throw new PaymentStepError(error, payment, []);
    const drift = [`${name} no longer has order ${orderId}.`];
    // Unapproved orders lapse after a few hours; one PayPal has forgotten can never be authorized.
    return reconciled(payment, awaiting ? move(payment, "expired", { approveUrl: null }, now) : payment, awaiting ? drift : [], now);
  }

  const drift: string[] = [];
  if (order.amountMinor !== payment.amountMinor) {
    drift.push(`${name}'s order is for ${formatMoney(order.amountMinor)}, PACT recorded ${formatMoney(payment.amountMinor)}.`);
  }
  const held = order.authorization;
  if (held !== null && (held.status === "CREATED" || held.status === "PENDING")) {
    drift.push(`${name} holds authorization ${held.authorizationId} for this order, which PACT has not recorded.`);
  }
  if (!awaiting) return reconciled(payment, payment, drift, now);

  switch (order.status) {
    case "CREATED":
    case "SAVED":
    case "PAYER_ACTION_REQUIRED":
      if (payment.status === "approved") drift.push(`PACT records the order as approved, but ${name} reports it as ${order.status}.`);
      return reconciled(payment, payment, drift, now);
    case "APPROVED":
      if (payment.status === "created") drift.push(`The payer has approved the order in ${name}; it has not been authorized yet.`);
      return reconciled(payment, payment, drift, now);
    case "COMPLETED":
      if (held === null) drift.push(`${name} reports the order as completed, but PACT has not recorded an authorization.`);
      return reconciled(payment, payment, drift, now);
    case "VOIDED":
      drift.push(`${name} reports the order as voided.`);
      return reconciled(payment, move(payment, "expired", { approveUrl: null }, now), drift, now);
    default:
      return assertNever(order.status);
  }
}

/**
 * Compare the record with PayPal's view (the authorization if one is recorded, otherwise the
 * order) and report every difference in plain language. Read-only at PayPal.
 *
 * The record only changes in one direction: a payment PACT still counts on ("authorized", or an
 * order awaiting approval) is marked "expired" when PayPal says it can no longer be completed —
 * the authorization was voided or expired on PayPal's side, or the order no longer exists.
 * Every other difference is reported in `drift` and left for the owning step to resolve
 * (authorize adopts an existing authorization, capture adopts an existing capture).
 * A payment.reconciled event is returned only when something differs.
 * Throws PaymentStepError (record untouched) when PayPal cannot be read.
 */
export async function reconcile(
  deps: OrchestratorDeps,
  input: { dealId: string; payment: PaymentRecord },
): Promise<ReconcileResult> {
  const now = clock(deps);
  const { payment } = input;
  if (payment.authorizationId !== null) return reconcileAuthorization(deps, payment, payment.authorizationId, now);
  if (payment.orderId !== null) return reconcileOrder(deps, payment, payment.orderId, now);
  return { payment, events: [], drift: [] };
}
