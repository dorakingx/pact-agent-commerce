/**
 * Valid sample records for tests that need rows in the database. Every builder returns a
 * record that passes its domain schema; pass `overrides` for the fields a test cares about.
 *
 * Test support only — nothing in the application imports this file.
 */
import { createHash } from "node:crypto";
import type { SQL } from "drizzle-orm";
import type {
  AuditEvent,
  Contract,
  NegotiationMove,
  SignedContract,
  Submission,
  VerificationReport,
} from "../domain/schemas";
import type { PaymentRecord } from "../payments/types";
import type { Db } from "./client";
import type { DealInsert } from "./schema";

let sequence = 0;

/** A process-unique, lowercase alphanumeric suffix (also valid inside a contract id). */
function nextSuffix(): string {
  sequence += 1;
  return sequence.toString(36).padStart(10, "0");
}

export function uniqueId(prefix: string): string {
  return `${prefix}_${nextSuffix()}`;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function dealFixture(overrides: Partial<DealInsert> = {}): DealInsert {
  const suffix = nextSuffix();
  return {
    id: `deal_${suffix}`,
    code: `PACT-${suffix.toUpperCase()}`,
    owner: "session-a",
    status: "negotiating",
    intent: "Three launch illustrations in 16:9 and 1:1 by tomorrow evening, budget $120.",
    ...overrides,
  };
}

export function moveFixture(seq: number, overrides: Partial<NegotiationMove> = {}): NegotiationMove {
  return {
    seq,
    actor: seq % 2 === 1 ? "buyer" : "seller",
    action: seq === 1 ? "offer" : "counter",
    terms: { priceMinor: 9_000 + seq * 500, deadline: "2026-10-08T09:00:00.000Z", revisionLimit: 1, count: 3 },
    message: `Proposal ${seq}.`,
    guardrails: [],
    source: "scripted",
    model: null,
    latencyMs: null,
    createdAt: new Date(Date.UTC(2026, 9, 6, 1, 0, seq)).toISOString(),
    ...overrides,
  };
}

export function contractFixture(dealId: string, overrides: Partial<Contract> = {}): SignedContract {
  const contract: Contract = {
    contractId: `ctr_${nextSuffix()}`,
    schemaVersion: 1,
    dealId,
    createdAt: "2026-10-06T01:10:00.000Z",
    title: "Three launch illustrations",
    category: "illustration",
    buyer: { id: "buyer-agent", name: "Buyer agent" },
    seller: { id: "seller-studio", name: "Northlight Studio" },
    price: { amountMinor: 10_500, currency: "USD" },
    deadline: "2026-10-08T09:00:00.000Z",
    revisionLimit: 1,
    deliverables: [
      { kind: "illustration", count: 3, aspectRatios: ["16:9", "1:1"], subject: "Product launch", style: null },
    ],
    verificationRules: [
      {
        id: "R1",
        kind: "deliverable_count",
        description: "3 illustrations delivered",
        required: true,
        evaluator: "deterministic",
      },
    ],
    settlement: {
      trigger: "verified_delivery",
      autoCaptureMinConfidence: 0.85,
      humanReviewMinConfidence: 0.5,
      onExhaustedRevisions: "void_authorization",
    },
    ...overrides,
  };
  return { contract, termsHash: sha256Hex(JSON.stringify(contract)) };
}

export function paymentFixture(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    provider: "simulated",
    mode: "interactive",
    status: "authorized",
    orderId: uniqueId("ORDER"),
    authorizationId: uniqueId("AUTH"),
    captureId: null,
    amountMinor: 10_500,
    authorizedMinor: 10_500,
    capturedMinor: 0,
    currency: "USD",
    approveUrl: null,
    authorizationExpiresAt: "2026-11-04T01:20:00.000Z",
    payerEmailMasked: "sb****@personal.example.com",
    lastError: null,
    webhookConfirmed: { authorized: false, captured: false, voided: false },
    updatedAt: "2026-10-06T01:20:00.000Z",
    ...overrides,
  };
}

export function submissionFixture(dealId: string, round: number, overrides: Partial<Submission> = {}): Submission {
  const id = uniqueId("sub");
  return {
    id,
    dealId,
    round,
    artifacts: [
      {
        id: `${id}_a1`,
        kind: "illustration",
        index: 1,
        title: "Launch hero",
        aspectRatio: "16:9",
        width: 1600,
        height: 900,
        format: "svg",
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><rect width="1600" height="900"/></svg>',
        description: "A wide hero illustration.",
      },
      {
        id: `${id}_a2`,
        kind: "copy",
        index: 1,
        title: "Launch tagline",
        language: "en",
        text: "Ship the launch with confidence.",
      },
    ],
    note: `Delivery for round ${round}.`,
    source: "scripted",
    model: null,
    submittedAt: new Date(Date.UTC(2026, 9, 6, 2, round, 0)).toISOString(),
    ...overrides,
  };
}

export function reportFixture(
  dealId: string,
  round: number,
  overrides: Partial<VerificationReport> = {},
): VerificationReport {
  return {
    id: uniqueId("rep"),
    dealId,
    submissionId: uniqueId("sub"),
    round,
    contractHash: sha256Hex(`${dealId}:${round}`),
    checks: [
      {
        ruleId: "R1",
        kind: "deliverable_count",
        condition: "3 illustrations delivered",
        required: true,
        evaluator: "deterministic",
        result: "pass",
        confidence: 1,
        evidence: "3 supplied",
        explanation: "The delivery contains the agreed number of illustrations.",
        artifactIds: [],
      },
    ],
    decision: "capture_eligible",
    confidence: 0.92,
    summary: "All required rules passed.",
    failedRuleIds: [],
    degraded: false,
    model: null,
    createdAt: new Date(Date.UTC(2026, 9, 6, 3, round, 0)).toISOString(),
    ...overrides,
  };
}

/** `prevHash` / `hash` are stand-ins: real chaining is the audit module's job and is tested there. */
export function auditFixture(dealId: string, seq: number, overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: uniqueId("evt"),
    dealId,
    seq,
    at: new Date(Date.UTC(2026, 9, 6, 4, 0, seq)).toISOString(),
    actor: "system",
    type: "intent.received",
    title: `Event ${seq}`,
    detail: null,
    data: { seq },
    prevHash: sha256Hex(`${dealId}:${seq - 1}`),
    hash: sha256Hex(`${dealId}:${seq}`),
    ...overrides,
  };
}

/**
 * Runs raw SQL and returns its rows. Both drivers answer `execute` with an object that has a
 * `rows` array; the row shape is whatever the statement selects, hence the caller-supplied type.
 */
export async function queryRows<T extends Record<string, unknown>>(db: Db, query: SQL): Promise<T[]> {
  const result: unknown = await db.execute(query);
  if (typeof result !== "object" || result === null || !("rows" in result) || !Array.isArray(result.rows)) {
    throw new Error("The database driver did not return a rows array");
  }
  return result.rows as T[];
}
