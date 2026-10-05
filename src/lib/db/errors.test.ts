import { describe, expect, it } from "vitest";
import { dbCall, DbError, DuplicateError, isUniqueViolation } from "./errors";

/** Shaped like drizzle's query wrapper: the message carries SQL and parameters, the cause is the driver error. */
function queryFailure(cause: unknown): Error {
  const wrapper = new Error('Failed query: insert into "wallets" values ($1, $2)\nparams: demo,VAULT-SECRET-123');
  return Object.assign(wrapper, { query: 'insert into "wallets" values ($1, $2)', params: ["demo", "VAULT-SECRET-123"], cause });
}

function driverError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...extra });
}

describe("dbCall", () => {
  it("returns the operation's result", async () => {
    await expect(dbCall("getDeal", async () => 42)).resolves.toBe(42);
  });

  it("turns a unique violation into a DuplicateError that names the constraint", async () => {
    const failure = queryFailure(
      driverError("23505", 'duplicate key value violates unique constraint "audit_deal_seq_idx"', {
        constraint: "audit_deal_seq_idx",
        detail: "Key (deal_id, seq)=(deal_1, 4) already exists.",
      }),
    );

    const error = await dbCall("insertAuditEvent", () => Promise.reject(failure)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DuplicateError);
    expect(error).toBeInstanceOf(DbError);
    expect(error).toMatchObject({
      name: "DuplicateError",
      operation: "insertAuditEvent",
      code: "23505",
      constraint: "audit_deal_seq_idx",
      message: "insertAuditEvent: the record already exists (audit_deal_seq_idx)",
    });
  });

  it("turns any other database failure into a DbError carrying the SQLSTATE", async () => {
    const failure = queryFailure(driverError("23503", "insert or update violates foreign key constraint"));

    await expect(dbCall("insertMove", () => Promise.reject(failure))).rejects.toMatchObject({
      name: "DbError",
      operation: "insertMove",
      code: "23503",
      message: "insertMove failed: insert or update violates foreign key constraint (SQLSTATE 23503)",
    });
  });

  it("never lets SQL text, bound parameters or row details through", async () => {
    const failure = queryFailure(
      driverError("23502", 'null value in column "provider" violates not-null constraint', {
        detail: "Failing row contains (demo, null, active, VAULT-SECRET-123).",
      }),
    );

    const error = (await dbCall("upsertWallet", () => Promise.reject(failure)).catch((caught: unknown) => caught)) as DbError;

    const visible = JSON.stringify({ message: error.message, cause: String(error.cause), stack: error.stack });
    expect(visible).not.toContain("VAULT-SECRET-123");
    expect(visible).not.toContain("insert into");
    expect(error.cause).toBeUndefined();
  });

  it("reports a connection failure as a DbError without a SQLSTATE", async () => {
    const refused = driverError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432");

    const error = await dbCall("getDeal", () => Promise.reject(queryFailure(refused))).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "DbError", code: null, message: "getDeal failed: connect ECONNREFUSED 127.0.0.1:5432" });
    expect((error as DbError).cause).toBe(refused);
  });

  it("does not mistake a five-letter Node.js errno for a SQLSTATE", async () => {
    const brokenPipe = driverError("EPIPE", "write EPIPE");

    await expect(dbCall("insertDeal", () => Promise.reject(queryFailure(brokenPipe)))).rejects.toMatchObject({
      name: "DbError",
      code: null,
      message: "insertDeal failed: write EPIPE",
    });
  });

  it("leaves errors that did not come from the database untouched", async () => {
    const validation = new RangeError("limit must be a positive integer");
    const alreadyTranslated = new DuplicateError("insertDeal", "deals_code_idx");

    await expect(dbCall("listDeals", () => Promise.reject(validation))).rejects.toBe(validation);
    await expect(dbCall("outer", () => Promise.reject(alreadyTranslated))).rejects.toBe(alreadyTranslated);
  });
});

describe("isUniqueViolation", () => {
  it("recognises translated and raw unique violations, and nothing else", () => {
    expect(isUniqueViolation(new DuplicateError("insertDeal", null))).toBe(true);
    expect(isUniqueViolation(queryFailure(driverError("23505", "duplicate key")))).toBe(true);
    expect(isUniqueViolation(queryFailure(driverError("23503", "foreign key")))).toBe(false);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
