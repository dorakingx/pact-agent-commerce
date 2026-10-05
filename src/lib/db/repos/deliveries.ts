/** Seller submissions and the verification reports written about them: one of each per (deal, round). */
import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import {
  SubmissionSchema,
  VerificationReportSchema,
  type Artifact,
  type Submission,
  type VerificationReport,
} from "../../domain/schemas";
import type { Db } from "../client";
import { dbCall } from "../errors";
import { submissions, verificationReports, type SubmissionRow, type VerificationReportRow } from "../schema";
import { toIsoUtc } from "../time";
import { parseForWrite, parseStored } from "../validation";

/**
 * Artifacts without their heavy bodies, stripped by Postgres so that megabytes of SVG never
 * cross the wire for a list view. `WITH ORDINALITY` keeps the artifacts in delivery order.
 */
export const artifactsWithoutBodies = sql<Artifact[]>`coalesce((
  select jsonb_agg(item.value - 'svg' - 'text' order by item.position)
  from jsonb_array_elements(${submissions.artifacts}) with ordinality as item(value, position)
), '[]'::jsonb)`.mapWith(submissions.artifacts);

/** A stripped artifact still has to be a valid Artifact, so its body becomes the empty string. */
function withEmptyBody(artifact: Artifact): Artifact {
  switch (artifact.kind) {
    case "illustration":
      return { ...artifact, svg: "" };
    case "copy":
      return { ...artifact, text: "" };
    default: {
      const unknownKind: never = artifact;
      throw new Error(`Unknown artifact kind: ${JSON.stringify(unknownKind)}`);
    }
  }
}

export function toSubmission(row: SubmissionRow, options: { bodiesStripped?: boolean } = {}): Submission {
  return parseStored(
    SubmissionSchema,
    {
      id: row.id,
      dealId: row.dealId,
      round: row.round,
      artifacts: options.bodiesStripped ? row.artifacts.map(withEmptyBody) : row.artifacts,
      note: row.note,
      source: row.source,
      model: row.model,
      submittedAt: toIsoUtc(row.submittedAt),
    },
    `submission ${row.id} of deal ${row.dealId}`,
  );
}

/** Throws DuplicateError when the deal already has a submission for this round. */
export function insertSubmission(db: Db, submission: Submission): Promise<void> {
  return dbCall("insertSubmission", async () => {
    const valid = parseForWrite(SubmissionSchema, submission, "submission");
    await db.insert(submissions).values({
      id: valid.id,
      dealId: valid.dealId,
      round: valid.round,
      artifacts: valid.artifacts,
      note: valid.note,
      source: valid.source,
      model: valid.model,
      submittedAt: toIsoUtc(valid.submittedAt),
    });
  });
}

/** Submissions by round, first delivery first. */
export function listSubmissions(db: Db, dealId: string): Promise<Submission[]> {
  return dbCall("listSubmissions", async () => {
    const rows = await db
      .select()
      .from(submissions)
      .where(eq(submissions.dealId, dealId))
      .orderBy(asc(submissions.round));
    return rows.map((row) => toSubmission(row));
  });
}

export function toVerificationReport(row: VerificationReportRow): VerificationReport {
  return parseStored(
    VerificationReportSchema,
    {
      id: row.id,
      dealId: row.dealId,
      submissionId: row.submissionId,
      round: row.round,
      contractHash: row.contractHash,
      checks: row.checks,
      decision: row.decision,
      confidence: row.confidence,
      summary: row.summary,
      failedRuleIds: row.failedRuleIds,
      degraded: row.degraded,
      model: row.model,
      createdAt: toIsoUtc(row.createdAt),
    },
    `verification report ${row.id} of deal ${row.dealId}`,
  );
}

/** Throws DuplicateError when the round has already been verified: a report is never overwritten. */
export function insertReport(db: Db, report: VerificationReport): Promise<void> {
  return dbCall("insertReport", async () => {
    const valid = parseForWrite(VerificationReportSchema, report, "verification report");
    await db.insert(verificationReports).values({
      id: valid.id,
      dealId: valid.dealId,
      submissionId: valid.submissionId,
      round: valid.round,
      contractHash: valid.contractHash,
      checks: valid.checks,
      decision: valid.decision,
      confidence: valid.confidence,
      summary: valid.summary,
      failedRuleIds: valid.failedRuleIds,
      degraded: valid.degraded,
      model: valid.model,
      createdAt: toIsoUtc(valid.createdAt),
    });
  });
}

/** Reports by round, first delivery first. */
export function listReports(db: Db, dealId: string): Promise<VerificationReport[]> {
  return dbCall("listReports", async () => {
    const rows = await db
      .select()
      .from(verificationReports)
      .where(eq(verificationReports.dealId, dealId))
      .orderBy(asc(verificationReports.round));
    return rows.map(toVerificationReport);
  });
}
