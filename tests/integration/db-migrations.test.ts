import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getTableName, isTable, sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createTestDb, type Db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { queryRows } from "@/lib/db/test-fixtures";

const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

interface Journal {
  entries: { idx: number; when: number; tag: string }[];
}

function readJournal(): Journal {
  return JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as Journal;
}

function latestSnapshot(journal: Journal): Parameters<typeof generateMigration>[0] {
  const last = journal.entries[journal.entries.length - 1];
  const file = path.join(MIGRATIONS_DIR, "meta", `${last.tag.slice(0, 4)}_snapshot.json`);
  return JSON.parse(readFileSync(file, "utf8")) as Parameters<typeof generateMigration>[0];
}

describe("migrations", () => {
  let db: Db;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await closeDb(db);
  });

  it("has exactly one SQL file per journal entry, in order", () => {
    const journal = readJournal();
    const sqlFiles = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort();

    expect(journal.entries.length).toBeGreaterThan(0);
    expect(sqlFiles).toEqual(journal.entries.map((entry) => `${entry.tag}.sql`));
    expect(journal.entries.map((entry) => entry.idx)).toEqual(journal.entries.map((_, index) => index));
    const timestamps = journal.entries.map((entry) => entry.when);
    expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps);
  });

  it("applies every migration to a fresh database and records each one once", async () => {
    const expected = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
    const applied = await queryRows<{ hash: string; created_at: string | number }>(
      db,
      sql`select hash, created_at from drizzle.__drizzle_migrations order by id`,
    );

    expect(applied.map((row) => row.hash)).toEqual(expected.map((migration) => migration.hash));
    expect(applied.map((row) => Number(row.created_at))).toEqual(readJournal().entries.map((entry) => entry.when));
  });

  it("creates every table declared in schema.ts", async () => {
    const declared = Object.values(schema)
      .filter((value) => isTable(value))
      .map((table) => getTableName(table))
      .sort();
    const created = await queryRows<{ table_name: string }>(
      db,
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );

    expect(declared).toHaveLength(13);
    expect(created.map((row) => row.table_name)).toEqual(declared);
  });

  it("is in sync with schema.ts (no change is waiting for `drizzle-kit generate`)", async () => {
    const snapshot = latestSnapshot(readJournal());
    const current = generateDrizzleJson(schema, snapshot.id);

    await expect(generateMigration(snapshot, current)).resolves.toEqual([]);
  });

  it("makes every foreign key to deals cascade on delete", async () => {
    const foreignKeys = await queryRows<{ constraint_name: string; delete_rule: string }>(
      db,
      sql`select constraint_name, delete_rule from information_schema.referential_constraints
          where constraint_schema = 'public' order by constraint_name`,
    );

    expect(foreignKeys.map((fk) => fk.constraint_name)).toEqual([
      "audit_events_deal_id_deals_id_fk",
      "contracts_deal_id_deals_id_fk",
      "negotiation_moves_deal_id_deals_id_fk",
      "payment_operations_deal_id_deals_id_fk",
      "payments_deal_id_deals_id_fk",
      "submissions_deal_id_deals_id_fk",
      "verification_reports_deal_id_deals_id_fk",
    ]);
    expect(new Set(foreignKeys.map((fk) => fk.delete_rule))).toEqual(new Set(["CASCADE"]));
  });

  it("creates the unique indexes that arbitrate concurrent writers", async () => {
    const unique = await queryRows<{ indexname: string }>(
      db,
      sql`select indexname from pg_indexes
          where schemaname = 'public' and indexdef like 'CREATE UNIQUE INDEX%' order by indexname`,
    );

    expect(unique.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "audit_deal_seq_idx",
        "contracts_deal_idx",
        "deals_code_idx",
        "negotiation_moves_deal_id_seq_pk",
        "payments_order_idx",
        "submissions_deal_round_idx",
        "verification_deal_round_idx",
      ]),
    );
  });
});
