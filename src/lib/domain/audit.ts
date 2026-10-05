/**
 * Tamper-evident audit trail.
 *
 * Every event carries the hash of the event before it, so the log for a deal forms a chain:
 * editing, reordering or removing any event changes a hash that a later event has already
 * committed to. The chain proves internal consistency; it is re-verified on every read and
 * the result is shown in the UI.
 */
import { canonicalJson, sha256Hex } from "./canonical";
import { parseTimestamp, truncate } from "./format";
import type { AuditEvent, AuditEventInput } from "./schemas";

/** prevHash of the first event in a chain. */
export const GENESIS_HASH: string = "0".repeat(64);

const TITLE_MAX = 200;
const DETAIL_MAX = 800;
/** Deeper structures than this are not "facts about an event"; they are cut rather than hashed. */
const MAX_DATA_DEPTH = 8;

/** Postgres text and jsonb cannot store NUL, and an audit write must never be what fails a step. */
function withoutNul(text: string): string {
  return text.replace(/\u0000/g, "");
}

/**
 * Reduce arbitrary caller data to plain JSON that survives a database round trip unchanged:
 * undefined members are dropped, Dates become ISO strings, and anything JSON cannot represent
 * becomes null. The hash is computed over exactly this value, so what is stored is what was hashed.
 */
function toJsonSafe(value: unknown, depth: number): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      return withoutNul(value);
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "bigint":
      return value.toString();
    case "object":
      break;
    default:
      return null;
  }
  if (depth >= MAX_DATA_DEPTH) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (member !== undefined && typeof member !== "function" && typeof member !== "symbol") {
      out[withoutNul(key)] = toJsonSafe(member, depth + 1);
    }
  }
  return out;
}

function eventHash(prevHash: string, body: Omit<AuditEvent, "prevHash" | "hash">): string {
  const { id, dealId, seq, at, actor, type, title, detail, data } = body;
  return sha256Hex(prevHash + canonicalJson({ id, dealId, seq, at, actor, type, title, detail, data }));
}

/**
 * Build the next event of a deal's audit chain.
 *
 * @param prev  The current last event of the chain (only seq and hash are needed), or null for the first.
 * @throws RangeError when `input.at` is supplied but is not a valid timestamp.
 */
export function buildAuditEvent(
  prev: Pick<AuditEvent, "seq" | "hash"> | null,
  dealId: string,
  input: AuditEventInput,
  opts: { id: string; now: Date },
): AuditEvent {
  let at = opts.now.toISOString();
  if (input.at !== undefined) {
    const ms = parseTimestamp(input.at);
    if (ms === null) throw new RangeError(`buildAuditEvent: "at" is not a valid timestamp: ${JSON.stringify(input.at)}`);
    at = new Date(ms).toISOString();
  }

  const body: Omit<AuditEvent, "prevHash" | "hash"> = {
    id: opts.id,
    dealId,
    seq: prev === null ? 1 : prev.seq + 1,
    at,
    actor: input.actor,
    type: input.type,
    title: truncate(withoutNul(input.title), TITLE_MAX),
    detail: input.detail === undefined || input.detail === null ? null : truncate(withoutNul(input.detail), DETAIL_MAX),
    data:
      input.data === undefined || input.data === null ? null : (toJsonSafe(input.data, 0) as Record<string, unknown>),
  };
  const prevHash = prev === null ? GENESIS_HASH : prev.hash;
  return { ...body, prevHash, hash: eventHash(prevHash, body) };
}

/** Null when the stored event cannot even be canonicalised (it was not produced by buildAuditEvent). */
function recomputeHash(event: AuditEvent): string | null {
  try {
    return eventHash(event.prevHash, event);
  } catch {
    return null;
  }
}

/**
 * Verify a deal's full chain, given in order: sequence numbers start at 1 with no gaps, every
 * event belongs to the same deal and points at its predecessor's hash, and every stored hash
 * matches the event's content.
 *
 * `brokenAtSeq` is the position (1-based) of the first event that fails, i.e. the sequence
 * number that event SHOULD have had.
 */
export function verifyAuditChain(events: AuditEvent[]): { valid: boolean; brokenAtSeq: number | null } {
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const expectedSeq = i + 1;
    const intact =
      event.seq === expectedSeq &&
      event.dealId === events[0].dealId &&
      event.prevHash === prevHash &&
      event.hash === recomputeHash(event);
    if (!intact) return { valid: false, brokenAtSeq: expectedSeq };
    prevHash = event.hash;
  }
  return { valid: true, brokenAtSeq: null };
}
