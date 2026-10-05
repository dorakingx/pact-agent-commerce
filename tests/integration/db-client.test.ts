import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeDb,
  createTestDb,
  databaseKind,
  getDb,
  getDeal,
  insertAuditEvent,
  insertDeal,
  insertMove,
  listAuditEvents,
  listMoves,
  updateDeal,
  withTransaction,
  type Db,
} from "@/lib/db";
import { auditFixture, dealFixture, moveFixture, queryRows } from "@/lib/db/test-fixtures";

const run = promisify(execFile);
const ROOT = process.cwd();
/** Scratch data directories live under the gitignored artifacts/tmp and are removed after each test. */
const SCRATCH = path.join(ROOT, "artifacts", "tmp", `db-client-test-${process.pid}`);

async function journalLength(): Promise<number> {
  const journal = JSON.parse(await readFile(path.join(ROOT, "drizzle", "meta", "_journal.json"), "utf8")) as {
    entries: unknown[];
  };
  return journal.entries.length;
}

async function appliedMigrations(db: Db): Promise<number> {
  const [row] = await queryRows<{ total: string | number }>(
    db,
    sql`select count(*) as total from drizzle.__drizzle_migrations`,
  );
  return Number(row.total);
}

describe("withTransaction", () => {
  let db: Db;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await closeDb(db);
  });

  it("commits every write and returns the callback's value when it resolves", async () => {
    const result = await withTransaction(db, async (tx) => {
      const deal = await insertDeal(tx, dealFixture());
      await insertMove(tx, deal.id, moveFixture(1));
      await insertAuditEvent(tx, auditFixture(deal.id, 1));
      return deal.id;
    });

    expect(await getDeal(db, result)).not.toBeNull();
    expect(await listMoves(db, result)).toHaveLength(1);
    expect(await listAuditEvents(db, result)).toHaveLength(1);
  });

  it("rolls back every write when the callback throws", async () => {
    const existing = await insertDeal(db, dealFixture());
    const created = dealFixture();

    await expect(
      withTransaction(db, async (tx) => {
        await insertDeal(tx, created);
        await insertMove(tx, created.id, moveFixture(1));
        await updateDeal(tx, existing.id, 0, { status: "agreed" });
        await insertAuditEvent(tx, auditFixture(existing.id, 1));
        throw new Error("step failed after writing");
      }),
    ).rejects.toThrow("step failed after writing");

    expect(await getDeal(db, created.id)).toBeNull();
    expect(await listMoves(db, created.id)).toEqual([]);
    expect(await getDeal(db, existing.id)).toMatchObject({ status: "negotiating", version: 0 });
    expect(await listAuditEvents(db, existing.id)).toEqual([]);
  });

  it("rolls back when a repository call inside it fails", async () => {
    const existing = await insertDeal(db, dealFixture());
    const created = dealFixture();

    await expect(
      withTransaction(db, async (tx) => {
        await insertDeal(tx, created);
        await insertDeal(tx, dealFixture({ id: existing.id }));
      }),
    ).rejects.toMatchObject({ name: "DuplicateError" });

    expect(await getDeal(db, created.id)).toBeNull();
  });

  it("treats a nested call as a savepoint: the inner failure is undone, the outer work is kept", async () => {
    const outer = dealFixture();
    const inner = dealFixture();

    await withTransaction(db, async (tx) => {
      await insertDeal(tx, outer);
      await expect(
        withTransaction(tx, async (nested) => {
          await insertDeal(nested, inner);
          throw new Error("inner step failed");
        }),
      ).rejects.toThrow("inner step failed");
      await insertMove(tx, outer.id, moveFixture(1));
    });

    expect(await getDeal(db, outer.id)).not.toBeNull();
    expect(await listMoves(db, outer.id)).toHaveLength(1);
    expect(await getDeal(db, inner.id)).toBeNull();
  });

  it("does not stop other requests from using the root database while a transaction is open", async () => {
    const deal = await insertDeal(db, dealFixture());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const transaction = withTransaction(db, async (tx) => {
      await updateDeal(tx, deal.id, 0, { status: "agreed" });
      entered();
      await gate;
    });
    await inside;
    // A different async context (think: another HTTP request) reading through the root handle.
    const concurrentRead = getDeal(db, deal.id);
    release();

    await transaction;
    // Whether that read waited for the commit (PGlite) or ran beside it (Postgres), it succeeds.
    expect(await concurrentRead).toMatchObject({ id: deal.id });
    expect(await getDeal(db, deal.id)).toMatchObject({ status: "agreed", version: 1 });
  });

  it("allows the root database again as soon as the callback has finished", async () => {
    const deal = await insertDeal(db, dealFixture());
    let afterCommit: Promise<unknown> = Promise.resolve(null);

    await withTransaction(db, async (tx) => {
      await updateDeal(tx, deal.id, 0, { status: "agreed" });
      // Started inside the callback but running after it: by then the transaction is over.
      afterCommit = new Promise((resolve) => setTimeout(resolve, 25)).then(() => getDeal(db, deal.id));
    });

    expect(await afterCommit).toMatchObject({ status: "agreed" });
  });
});

describe("withTransaction on PGlite's single connection", () => {
  let db: Db;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await closeDb(db);
  });

  it("fails fast, instead of deadlocking, when the root database is used inside the callback", async () => {
    const created = dealFixture();

    await expect(
      withTransaction(db, async (tx) => {
        await insertDeal(tx, created);
        // The mistake under test: `db` instead of `tx`.
        await getDeal(db, created.id);
      }),
    ).rejects.toThrow(/Use the transaction handle/);
    await expect(
      withTransaction(db, (tx) => withTransaction(db, (inner) => getDeal(inner, created.id)).then(() => getDeal(tx, created.id))),
    ).rejects.toThrow(/Use the transaction handle/);

    // The failed transaction rolled back and the database is still perfectly usable.
    expect(await getDeal(db, created.id)).toBeNull();
    expect(await insertDeal(db, created)).toMatchObject({ id: created.id });
  }, 5_000);
});

describe("createTestDb", () => {
  it("hands out isolated databases", async () => {
    const first = await createTestDb();
    const second = await createTestDb();
    try {
      const deal = await insertDeal(first, dealFixture());

      expect(first).not.toBe(second);
      expect(await getDeal(first, deal.id)).not.toBeNull();
      expect(await getDeal(second, deal.id)).toBeNull();
    } finally {
      await closeDb(first);
      await closeDb(second);
    }
  });

  it("refuses to close a database it did not create", async () => {
    const db = await createTestDb();
    try {
      await withTransaction(db, async (tx) => {
        await expect(closeDb(tx)).rejects.toThrow(/createTestDb/);
      });
    } finally {
      await closeDb(db);
    }
    await expect(closeDb(db)).rejects.toThrow(/createTestDb/);
  });
});

describe("getDb on PGlite", () => {
  beforeEach(async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("POSTGRES_URL", "");
    await mkdir(SCRATCH, { recursive: true });
  });

  afterEach(async () => {
    await closeDb();
    vi.unstubAllEnvs();
    await rm(SCRATCH, { recursive: true, force: true });
  });

  it("uses PGlite when no database URL is configured", () => {
    expect(databaseKind()).toBe("pglite");

    vi.stubEnv("DATABASE_URL", "postgres://user:secret@db.example.com/pact");
    expect(databaseKind()).toBe("postgres");
  });

  it("returns one shared instance, even for concurrent first calls, and migrates it once", async () => {
    vi.stubEnv("PGLITE_DIR", "");

    const [first, second] = await Promise.all([getDb(), getDb()]);
    const third = await getDb();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(await appliedMigrations(first)).toBe(await journalLength());
  });

  it("starts empty again after closeDb() when it is in-memory", async () => {
    vi.stubEnv("PGLITE_DIR", "");
    const before = await getDb();
    const deal = await insertDeal(before, dealFixture());

    await closeDb();
    const after = await getDb();

    expect(after).not.toBe(before);
    expect(await getDeal(after, deal.id)).toBeNull();
  });

  it("persists to PGLITE_DIR and does not re-apply migrations when the directory is reopened", async () => {
    // Relative on purpose: that is how .env files spell it (".pact-data/dev").
    vi.stubEnv("PGLITE_DIR", path.relative(ROOT, path.join(SCRATCH, "nested", "data")));
    const deal = await insertDeal(await getDb(), dealFixture({ deadline: "2026-10-08T18:00:00+09:00" }));

    await closeDb();
    const reopened = await getDb();

    expect(await getDeal(reopened, deal.id)).toEqual(deal);
    expect(await appliedMigrations(reopened)).toBe(await journalLength());
  });

  it("can be retried after a failed start-up", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(path.join(SCRATCH, "no-migrations-here"));
    vi.stubEnv("PGLITE_DIR", "");
    try {
      await expect(getDb()).rejects.toThrow();
    } finally {
      cwd.mockRestore();
    }

    expect(await appliedMigrations(await getDb())).toBe(await journalLength());
  });
});

describe("getDb in a plain Node process", () => {
  const dataDir = path.join(SCRATCH, "process-data");

  /**
   * Loads the persistence module the way a Next.js route handler does — compiled TypeScript,
   * the "react-server" export condition (so `server-only` resolves), no test runner — and
   * prints one JSON line describing what it found.
   */
  const script = `
    const { sql } = require("drizzle-orm");
    const db = require(${JSON.stringify(path.join(ROOT, "src", "lib", "db", "index.ts"))});
    (async () => {
      const first = await db.getDb();
      const second = await db.getDb();
      const existing = await db.getDealByCode(first, "PACT-PROCESS");
      if (!existing) {
        await db.insertDeal(first, { id: "deal_process", code: "PACT-PROCESS", owner: "session-a", status: "negotiating", intent: "Persist me" });
      }
      const migrations = await first.execute(sql\`select count(*) as total from drizzle.__drizzle_migrations\`);
      const deals = await first.execute(sql\`select count(*) as total from deals\`);
      await db.closeDb();
      process.stdout.write(JSON.stringify({
        kind: db.databaseKind(),
        sameInstance: first === second,
        foundExistingDeal: existing !== null,
        createdAt: existing ? existing.createdAt : null,
        migrations: Number(migrations.rows[0].total),
        deals: Number(deals.rows[0].total),
      }) + "\\n");
    })().catch((error) => { process.stderr.write(String(error && error.stack || error) + "\\n"); process.exit(1); });
  `;

  async function runProcess(): Promise<Record<string, unknown>> {
    const { stdout } = await run(process.execPath, ["--conditions=react-server", "--import", "tsx", "-e", script], {
      cwd: ROOT,
      env: { ...process.env, PGLITE_DIR: dataDir, DATABASE_URL: "", POSTGRES_URL: "", PACT_LOG_SILENT: "1" },
    });
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
  }

  afterAll(async () => {
    await rm(SCRATCH, { recursive: true, force: true });
  });

  it("memoises the database within a process and reuses the migrated data directory across processes", async () => {
    const expectedMigrations = await journalLength();

    const firstProcess = await runProcess();
    expect(firstProcess).toEqual({
      kind: "pglite",
      sameInstance: true,
      foundExistingDeal: false,
      createdAt: null,
      migrations: expectedMigrations,
      deals: 1,
    });

    // A second process start: the schema and the row are already there, and nothing is migrated twice.
    const secondProcess = await runProcess();
    expect(secondProcess).toMatchObject({
      kind: "pglite",
      sameInstance: true,
      foundExistingDeal: true,
      migrations: expectedMigrations,
      deals: 1,
    });
    expect(secondProcess.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }, 90_000);
});
