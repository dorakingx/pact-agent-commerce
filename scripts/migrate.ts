/**
 * Applies the SQL migrations in ./drizzle to managed Postgres. Runs at build time
 * (`npm run db:migrate`, part of `vercel-build`) so that no request ever pays for, or races on,
 * a schema change. Without a database URL there is nothing to do: PGlite migrates itself when
 * the app starts.
 *
 * The connection URL contains the database password, so nothing printed here may include it.
 */
import path from "node:path";
import type { Pool } from "pg";
import { poolConfigFromUrl } from "../src/lib/db/pool-config";

const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Migrations run only when the app itself will use Postgres (same test as getDatabaseUrl in
 * src/lib/config.ts). A direct connection is preferred when the provider offers one: DDL
 * inside a transaction is not reliable through a transaction-mode pooler.
 */
function migrationUrl(): string | undefined {
  const runtimeUrl = env("DATABASE_URL") ?? env("POSTGRES_URL");
  if (!runtimeUrl) return undefined;
  return env("DATABASE_URL_UNPOOLED") ?? env("POSTGRES_URL_NON_POOLING") ?? runtimeUrl;
}

/** Driver errors can quote the connection string; the URL and its password must not reach a build log. */
function scrub(message: string, url: string): string {
  let clean = message.split(url).join("[database url]").replace(/postgres(?:ql)?:\/\/\S+/gi, "[database url]");
  try {
    const password = decodeURIComponent(new URL(url).password);
    if (password) clean = clean.split(password).join("[redacted]");
  } catch {
    // Not a parseable URL: there is no password to look for.
  }
  return clean;
}

/** One line: the driver's own message first, then the start of the statement drizzle was running. */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const headline = error.message.replace(/\s+/g, " ").trim().slice(0, 160);
  return error.cause instanceof Error ? `${error.cause.message} (${headline}…)` : headline;
}

async function appliedCount(pool: Pool): Promise<number> {
  const exists = await pool.query<{ present: boolean }>(
    "select to_regclass('drizzle.__drizzle_migrations') is not null as present",
  );
  if (!exists.rows[0]?.present) return 0;
  const count = await pool.query<{ total: string }>("select count(*) as total from drizzle.__drizzle_migrations");
  return Number(count.rows[0]?.total ?? 0);
}

async function migrateDatabase(url: string): Promise<string> {
  const [{ Pool }, { drizzle }, { migrate }] = await Promise.all([
    import("pg"),
    import("drizzle-orm/node-postgres"),
    import("drizzle-orm/node-postgres/migrator"),
  ]);
  const startedAt = Date.now();
  // One connection: the migrator needs a single session, and a build must not hold more.
  const pool = new Pool({ ...poolConfigFromUrl(url), max: 1, connectionTimeoutMillis: 15_000 });
  try {
    const before = await appliedCount(pool);
    await migrate(drizzle({ client: pool }), { migrationsFolder: MIGRATIONS_FOLDER });
    const after = await appliedCount(pool);
    const applied = after - before;
    return `Migrations: ${applied === 0 ? "already up to date" : `applied ${applied}`} (${after} total) in ${Date.now() - startedAt} ms`;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const url = migrationUrl();
  if (!url) {
    process.stdout.write("No DATABASE_URL — skipping (PGlite migrates at startup)\n");
    return;
  }
  try {
    process.stdout.write(`${await migrateDatabase(url)}\n`);
  } catch (error) {
    process.stderr.write(`Migration failed: ${scrub(describeFailure(error), url)}\n`);
    process.exitCode = 1;
  }
}

void main();
