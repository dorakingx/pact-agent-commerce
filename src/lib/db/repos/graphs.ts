/**
 * Batch read of whole deals. Both the deal view and the operations snapshot need a deal
 * together with everything hanging off it; loading that per deal would be an N+1 across seven
 * tables. This issues exactly one query per table, however many deals are requested.
 */
import "server-only";
import { asc, inArray } from "drizzle-orm";
import type {
  AuditEvent,
  NegotiationMove,
  SignedContract,
  Submission,
  VerificationReport,
} from "../../domain/schemas";
import type { PaymentRecord } from "../../payments/types";
import type { Db } from "../client";
import { dbCall } from "../errors";
import {
  auditEvents,
  contracts,
  deals,
  negotiationMoves,
  payments,
  submissions,
  verificationReports,
  type DealRow,
} from "../schema";
import { toAuditEvent } from "./audit";
import { toSignedContract } from "./contracts";
import { toDealRow } from "./deals";
import { artifactsWithoutBodies, toSubmission, toVerificationReport } from "./deliveries";
import { toNegotiationMove } from "./negotiation";
import { toPaymentRecord } from "./payments";

export interface DealGraph {
  deal: DealRow;
  moves: NegotiationMove[];
  signed: SignedContract | null;
  payment: PaymentRecord | null;
  submissions: Submission[];
  reports: VerificationReport[];
  audit: AuditEvent[];
}

export interface LoadDealGraphsOptions {
  /**
   * Default true. Pass false for list views: every artifact is still returned with its
   * metadata, but its heavy body (`svg` / `text`) is the empty string and is never read
   * from the database.
   */
  artifacts?: boolean;
}

/** Number of statements loadDealGraphs issues for any non-empty request. */
export const DEAL_GRAPH_QUERY_COUNT = 7;

function loadSubmissions(db: Db, ids: string[], includeBodies: boolean): Promise<Submission[]> {
  const order = [asc(submissions.dealId), asc(submissions.round)] as const;
  if (includeBodies) {
    return db
      .select()
      .from(submissions)
      .where(inArray(submissions.dealId, ids))
      .orderBy(...order)
      .then((rows) => rows.map((row) => toSubmission(row)));
  }
  return db
    .select({
      id: submissions.id,
      dealId: submissions.dealId,
      round: submissions.round,
      artifacts: artifactsWithoutBodies,
      note: submissions.note,
      source: submissions.source,
      model: submissions.model,
      submittedAt: submissions.submittedAt,
    })
    .from(submissions)
    .where(inArray(submissions.dealId, ids))
    .orderBy(...order)
    .then((rows) => rows.map((row) => toSubmission(row, { bodiesStripped: true })));
}

/**
 * Loads complete graphs for the given deals. The map is keyed by deal id and iterates in the
 * order the ids were given; ids that do not exist are simply absent. Children are ordered the
 * way the product reads them: moves and audit events by seq, submissions and reports by round.
 */
export function loadDealGraphs(
  db: Db,
  dealIds: string[],
  options: LoadDealGraphsOptions = {},
): Promise<Map<string, DealGraph>> {
  // Sequential on purpose: a transaction handle owns a single connection, and seven parallel
  // statements from one request would monopolise the small production pool.
  return dbCall("loadDealGraphs", async () => {
    const graphs = new Map<string, DealGraph>();
    const ids = [...new Set(dealIds)];
    if (ids.length === 0) return graphs;

    const dealRows = await db.select().from(deals).where(inArray(deals.id, ids));
    const moveRows = await db
      .select()
      .from(negotiationMoves)
      .where(inArray(negotiationMoves.dealId, ids))
      .orderBy(asc(negotiationMoves.dealId), asc(negotiationMoves.seq));
    const contractRows = await db.select().from(contracts).where(inArray(contracts.dealId, ids));
    const paymentRows = await db.select().from(payments).where(inArray(payments.dealId, ids));
    const submissionList = await loadSubmissions(db, ids, options.artifacts ?? true);
    const reportRows = await db
      .select()
      .from(verificationReports)
      .where(inArray(verificationReports.dealId, ids))
      .orderBy(asc(verificationReports.dealId), asc(verificationReports.round));
    const auditRows = await db
      .select()
      .from(auditEvents)
      .where(inArray(auditEvents.dealId, ids))
      .orderBy(asc(auditEvents.dealId), asc(auditEvents.seq));

    const found = new Map(dealRows.map((row) => [row.id, toDealRow(row)]));
    for (const id of ids) {
      const deal = found.get(id);
      if (deal) {
        graphs.set(id, { deal, moves: [], signed: null, payment: null, submissions: [], reports: [], audit: [] });
      }
    }
    // Every child row belongs to a requested deal that exists (foreign keys), so the lookups cannot miss.
    for (const row of moveRows) graphs.get(row.dealId)?.moves.push(toNegotiationMove(row));
    for (const row of contractRows) {
      const graph = graphs.get(row.dealId);
      if (graph) graph.signed = toSignedContract(row);
    }
    for (const row of paymentRows) {
      const graph = graphs.get(row.dealId);
      if (graph) graph.payment = toPaymentRecord(row);
    }
    for (const submission of submissionList) graphs.get(submission.dealId)?.submissions.push(submission);
    for (const row of reportRows) graphs.get(row.dealId)?.reports.push(toVerificationReport(row));
    for (const row of auditRows) graphs.get(row.dealId)?.audit.push(toAuditEvent(row));
    return graphs;
  });
}
