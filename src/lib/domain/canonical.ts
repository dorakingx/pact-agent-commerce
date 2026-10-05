/**
 * Canonical JSON and hashing — the basis of every fingerprint in PACT (contract terms hash,
 * audit chain). Two values that are semantically the same JSON document always serialise to
 * the same bytes, regardless of the order in which their keys were inserted or which database
 * round trip they went through.
 *
 * The output follows the same rules as RFC 8785 (JCS): keys sorted by UTF-16 code units,
 * ECMAScript number formatting, no insignificant whitespace.
 */
import { createHash } from "node:crypto";

function describe(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object") return Object.prototype.toString.call(value);
  return typeof value;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serialise(value: unknown, path: string, ancestors: Set<object>): string {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      }
      // JSON.stringify gives the shortest round-trip form and folds -0 into 0.
      return JSON.stringify(value);
    case "object":
      break;
    default:
      // undefined, function, symbol, bigint: JSON.stringify would silently drop or throw on
      // these depending on position. A hash input must never be silently lossy.
      throw new TypeError(`canonicalJson: unsupported ${describe(value)} at ${path}`);
  }

  if (value === null) return "null";
  if (ancestors.has(value)) throw new TypeError(`canonicalJson: circular reference at ${path}`);

  ancestors.add(value);
  let out: string;
  if (Array.isArray(value)) {
    const items: string[] = [];
    // Index loop on purpose: it visits holes in sparse arrays (as undefined) instead of skipping them.
    for (let i = 0; i < value.length; i += 1) {
      items.push(serialise(value[i], `${path}[${i}]`, ancestors));
    }
    out = `[${items.join(",")}]`;
  } else if (isPlainObject(value)) {
    const members = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialise(value[key], `${path}.${key}`, ancestors)}`);
    out = `{${members.join(",")}}`;
  } else {
    // Date, Map, Set, class instances: their JSON form is ambiguous or lossy. Callers convert
    // explicitly (e.g. Date -> ISO string) so the hashed representation is never a surprise.
    throw new TypeError(`canonicalJson: unsupported ${describe(value)} at ${path}`);
  }
  ancestors.delete(value);
  return out;
}

/**
 * Deterministic JSON: object keys sorted recursively, arrays in order, no whitespace.
 * Throws TypeError on anything that is not plain JSON data (undefined, functions, symbols,
 * BigInt, NaN/Infinity, Dates and other class instances, circular structures).
 */
export function canonicalJson(value: unknown): string {
  return serialise(value, "$", new Set());
}

/** Lowercase hex SHA-256 of the UTF-8 encoding of `input`. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
