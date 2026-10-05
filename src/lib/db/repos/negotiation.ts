/** Negotiation moves, append-only and ordered by `seq` within a deal. */
import "server-only";
import { asc, eq } from "drizzle-orm";
import { NegotiationMoveSchema, type NegotiationMove } from "../../domain/schemas";
import type { Db } from "../client";
import { dbCall } from "../errors";
import { negotiationMoves, type NegotiationMoveRow } from "../schema";
import { toIsoUtc } from "../time";
import { parseForWrite, parseStored } from "../validation";

export function toNegotiationMove(row: NegotiationMoveRow): NegotiationMove {
  return parseStored(
    NegotiationMoveSchema,
    {
      seq: row.seq,
      actor: row.actor,
      action: row.action,
      terms: row.terms,
      message: row.message,
      guardrails: row.guardrails,
      source: row.source,
      model: row.model,
      latencyMs: row.latencyMs,
      createdAt: toIsoUtc(row.createdAt),
    },
    `negotiation move ${row.seq} of deal ${row.dealId}`,
  );
}

/**
 * Appends a move. The primary key (deal_id, seq) makes the database the arbiter when two
 * requests try to write the same turn: the loser gets a DuplicateError.
 */
export function insertMove(db: Db, dealId: string, move: NegotiationMove): Promise<void> {
  return dbCall("insertMove", async () => {
    const valid = parseForWrite(NegotiationMoveSchema, move, `negotiation move ${move.seq} of deal ${dealId}`);
    await db.insert(negotiationMoves).values({
      dealId,
      seq: valid.seq,
      actor: valid.actor,
      action: valid.action,
      terms: valid.terms,
      message: valid.message,
      guardrails: valid.guardrails,
      source: valid.source,
      model: valid.model,
      latencyMs: valid.latencyMs,
      createdAt: toIsoUtc(valid.createdAt),
    });
  });
}

/** Moves in the order they were made. */
export function listMoves(db: Db, dealId: string): Promise<NegotiationMove[]> {
  return dbCall("listMoves", async () => {
    const rows = await db
      .select()
      .from(negotiationMoves)
      .where(eq(negotiationMoves.dealId, dealId))
      .orderBy(asc(negotiationMoves.seq));
    return rows.map(toNegotiationMove);
  });
}
