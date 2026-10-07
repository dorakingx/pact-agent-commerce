import { describe, expect, it } from "vitest";
import { resolveMigrationTarget } from "./migration-target";

describe("resolveMigrationTarget", () => {
  it("migrates the configured database, preferring a direct connection for DDL", () => {
    expect(resolveMigrationTarget({ DATABASE_URL: "postgres://pooled" })).toEqual({ kind: "migrate", url: "postgres://pooled" });
    expect(resolveMigrationTarget({ POSTGRES_URL: "postgres://pooled", POSTGRES_URL_NON_POOLING: "postgres://direct" })).toEqual({
      kind: "migrate",
      url: "postgres://direct",
    });
    // A direct URL alone does not make the app use Postgres, so it is not migrated either.
    expect(resolveMigrationTarget({ DATABASE_URL_UNPOOLED: "postgres://direct" }).kind).toBe("skip");
  });

  it("has nothing to do locally and in CI, where PGlite migrates itself", () => {
    expect(resolveMigrationTarget({})).toEqual({ kind: "skip", message: "No DATABASE_URL — skipping (PGlite migrates at startup)" });
    expect(resolveMigrationTarget({ DATABASE_URL: "   ", CI: "true" }).kind).toBe("skip");
  });

  it("fails a serverless build that has no database, instead of shipping an in-memory one per instance", () => {
    const target = resolveMigrationTarget({ VERCEL: "1", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" });
    expect(target.kind).toBe("refuse");
    expect(target.kind === "refuse" && target.message).toContain("DATABASE_URL and POSTGRES_URL");
  });

  it("names a variable that looks like the database URL under another name, never its value", () => {
    const target = resolveMigrationTarget({ VERCEL: "1", STORAGE_POSTGRES_URL: "postgres://user:hunter2@host/db", NEON_DATABASE_URL: "postgres://x" });
    expect(target).toMatchObject({ kind: "refuse" });
    const message = target.kind === "refuse" ? target.message : "";
    expect(message).toContain("Found NEON_DATABASE_URL, STORAGE_POSTGRES_URL");
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("postgres://");
  });

  it("lets an operator deploy a throwaway preview on purpose, and says what that means", () => {
    const target = resolveMigrationTarget({ VERCEL: "1", PACT_ALLOW_EPHEMERAL_DB: "1" });
    expect(target.kind).toBe("skip");
    expect(target.kind === "skip" && target.message).toContain("WITHOUT a durable database");
  });
});
