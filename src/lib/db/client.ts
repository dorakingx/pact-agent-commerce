/**
 * Database access. One schema and one set of SQL migrations, two drivers:
 *
 *  - managed Postgres through node-postgres whenever a database URL is configured (production);
 *  - PGlite, an in-process Postgres, otherwise (local development, CI and tests).
 *
 * Each driver is loaded with a dynamic import so that production never loads the PGlite WASM
 * build and a keyless local checkout never opens a socket.
 */
import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir } from "node:fs/promises";
import type { Logger as QueryLogger } from "drizzle-orm/logger";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { getDatabaseUrl } from "../config";
import { log } from "../observability/logger";
import { projectPath } from "./paths";
import { poolConfigFromUrl } from "./pool-config";
import * as schema from "./schema";

/**
 * A Drizzle Postgres database. Both drivers satisfy it, and so does the handle passed to a
 * transaction callback — which is why every repository function takes a `Db` first.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export type DatabaseKind = "postgres" | "pglite";

/** Receives every SQL statement a test database executes (text and bound parameters). */
export type QueryObserver = (query: string, params: unknown[]) => void;

interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

/** Fluid compute keeps a few requests on one instance; a small pool protects the database's connection limit. */
const POOL_MAX_CONNECTIONS = 5;
/** Kept short so idle connections are released before the function instance is suspended. */
const POOL_IDLE_TIMEOUT_MS = 5_000;
const POOL_CONNECT_TIMEOUT_MS = 10_000;

function migrationsFolder(): string {
  return projectPath("drizzle");
}

/** Marks the async context of a withTransaction callback for as long as that callback is running. */
interface TransactionFrame {
  open: boolean;
}

/**
 * Process-wide state lives on globalThis rather than in module scope: Next.js re-evaluates
 * modules on every dev reload, and a second PGlite instance on the same data directory would
 * corrupt it.
 */
const globalStore = globalThis as typeof globalThis & {
  __pactDb?: Promise<DbHandle>;
  __pactTransactionScope?: AsyncLocalStorage<TransactionFrame>;
};

function transactionScope(): AsyncLocalStorage<TransactionFrame> {
  globalStore.__pactTransactionScope ??= new AsyncLocalStorage<TransactionFrame>();
  return globalStore.__pactTransactionScope;
}

/** The PGlite entry points drizzle uses to run a statement or open a transaction on the root connection. */
const ROOT_CONNECTION_METHODS: ReadonlySet<PropertyKey> = new Set(["query", "sql", "exec", "transaction"]);

/**
 * PGlite has exactly one connection. A statement issued on the root database from inside a
 * withTransaction callback queues behind that transaction, while the transaction is waiting
 * for the statement: the request would hang forever without a word. This wrapper turns that
 * silent deadlock into an immediate, explicit error. (Statements on the `tx` handle never come
 * through here: PGlite gives a transaction its own client object.)
 */
function failFastOnReentry<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, property) {
      // The real instance is the receiver: PGlite keeps its state in private fields.
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (ROOT_CONNECTION_METHODS.has(property) && transactionScope().getStore()?.open) {
          throw new Error(
            "The root database was used inside withTransaction(). Use the transaction handle passed to the callback (PGlite has a single connection, so this would otherwise wait forever).",
          );
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
}

/** Databases handed out by createTestDb(), so closeDb(db) can dispose of them. */
const testHandles = new WeakMap<Db, DbHandle>();

async function openPostgres(url: string): Promise<DbHandle> {
  const [{ Pool }, { drizzle }, { attachDatabasePool }] = await Promise.all([
    import("pg"),
    import("drizzle-orm/node-postgres"),
    import("@vercel/functions"),
  ]);
  const pool = new Pool({
    ...poolConfigFromUrl(url),
    max: POOL_MAX_CONNECTIONS,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: POOL_CONNECT_TIMEOUT_MS,
  });
  // An idle client can be dropped by the server at any time; without a listener that would
  // surface as an unhandled "error" event and take the whole process down.
  pool.on("error", (error) => log.error("db.pool_error", { error }));
  attachDatabasePool(pool);
  return { db: drizzle({ client: pool, schema }), close: () => pool.end() };
}

interface PgliteHandle extends DbHandle {
  /** The whole data directory as an uncompressed tarball. */
  snapshot: () => Promise<Blob>;
}

/**
 * Opens PGlite in memory, on a data directory, or from a snapshot of an already migrated
 * database (`image`). Migrations are applied unless an image is supplied.
 */
async function openPglite(options: { dataDir?: string; image?: Blob; onQuery?: QueryObserver }): Promise<PgliteHandle> {
  const [{ PGlite }, { drizzle }, { migrate }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("drizzle-orm/pglite"),
    import("drizzle-orm/pglite/migrator"),
  ]);
  let dataDir: string | undefined;
  if (options.dataDir) {
    // A relative directory (".pact-data/dev" in .env files) is the project's, wherever the server was started.
    dataDir = projectPath(options.dataDir);
    // PGlite creates the data directory itself but not its parents.
    await mkdir(dataDir, { recursive: true });
  }
  const client = await PGlite.create(dataDir, options.image ? { loadDataDir: options.image } : undefined);
  try {
    // PGlite inherits the machine's time zone; managed Postgres runs in UTC. Align them so a
    // statement can never behave differently between development and production.
    await client.exec("SET TIME ZONE 'UTC'");
    const { onQuery } = options;
    const logger: QueryLogger | undefined = onQuery ? { logQuery: (query, params) => onQuery(query, params) } : undefined;
    const db = drizzle({ client: failFastOnReentry(client), schema, logger });
    if (!options.image) {
      // Idempotent: drizzle records applied migrations, so reopening a data directory applies only what is new.
      await migrate(db, { migrationsFolder: migrationsFolder() });
    }
    return { db, close: () => client.close(), snapshot: () => client.dumpDataDir("none") };
  } catch (error) {
    await client.close();
    throw error;
  }
}

/**
 * A migrated, empty database image shared by every createTestDb() call in this process.
 * Restoring it takes a fraction of the time needed to initialise a cluster and replay the
 * migrations, which matters when a test suite wants a fresh database per test.
 */
let pristineImage: Promise<Blob> | undefined;

function pristineTestImage(): Promise<Blob> {
  if (!pristineImage) {
    const building: Promise<Blob> = (async () => {
      const seed = await openPglite({});
      try {
        return await seed.snapshot();
      } finally {
        await seed.close();
      }
    })().catch((error: unknown) => {
      if (pristineImage === building) pristineImage = undefined;
      throw error;
    });
    pristineImage = building;
  }
  return pristineImage;
}

async function openConfigured(): Promise<DbHandle> {
  const url = getDatabaseUrl();
  if (url) {
    // Migrations are applied at build time (scripts/migrate.ts), never from a request.
    const handle = await openPostgres(url);
    log.info("db.ready", { kind: "postgres" });
    return handle;
  }
  const dataDir = process.env.PGLITE_DIR?.trim() || undefined;
  const handle = await openPglite({ dataDir });
  log.info("db.ready", { kind: "pglite", storage: dataDir ? "directory" : "memory" });
  if (!dataDir && process.env.VERCEL) {
    // The build refuses this (scripts/migrate.ts) unless it was asked for; say so at run time too.
    log.error("db.ephemeral_on_serverless", { hint: "Set DATABASE_URL or POSTGRES_URL: this instance's data is lost when it is recycled." });
  }
  return handle;
}

/** Which driver getDb() uses in this environment. */
export function databaseKind(): DatabaseKind {
  return getDatabaseUrl() ? "postgres" : "pglite";
}

/**
 * The process-wide database. The first call connects (and, on PGlite, applies migrations
 * exactly once); concurrent first calls share that work and every later call returns the
 * same instance.
 */
export async function getDb(): Promise<Db> {
  if (!globalStore.__pactDb) {
    const opening: Promise<DbHandle> = openConfigured().catch((error: unknown) => {
      // Do not cache a failed start-up: the next request must be able to try again.
      if (globalStore.__pactDb === opening) globalStore.__pactDb = undefined;
      throw error;
    });
    globalStore.__pactDb = opening;
  }
  return (await globalStore.__pactDb).db;
}

/**
 * A fresh in-memory PGlite database with every migration applied. Not memoised: each call is
 * an isolated database, which is what tests want. Dispose of it with `closeDb(db)`.
 */
export async function createTestDb(options: { onQuery?: QueryObserver } = {}): Promise<Db> {
  const handle = await openPglite({ image: await pristineTestImage(), onQuery: options.onQuery });
  testHandles.set(handle.db, handle);
  return handle.db;
}

/**
 * Without an argument: closes the process-wide database (a later getDb() reconnects).
 * With a database returned by createTestDb(): closes that database.
 */
export async function closeDb(db?: Db): Promise<void> {
  if (db) {
    const handle = testHandles.get(db);
    if (!handle) {
      throw new Error("closeDb(db) only accepts a database returned by createTestDb(); call closeDb() for the process-wide one");
    }
    testHandles.delete(db);
    await handle.close();
    return;
  }
  const opening = globalStore.__pactDb;
  if (!opening) return;
  globalStore.__pactDb = undefined;
  const handle = await opening.catch(() => null);
  await handle?.close();
}

/**
 * Runs `fn` in a transaction: commits when it resolves, rolls back when it throws. Nested calls
 * (passing a `tx`) become savepoints.
 *
 * Inside `fn`, use ONLY the `tx` handle. On PGlite a statement on the root database from inside
 * the callback is rejected with an explicit error (it could never complete); on Postgres it
 * would run on another connection, outside the transaction, which is never what was meant.
 */
export function withTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction((tx) => {
    const frame: TransactionFrame = { open: true };
    return transactionScope().run(frame, async () => {
      try {
        return await fn(tx);
      } finally {
        // Work the callback started but did not await may outlive the transaction; from here
        // on the root database is safe to use again.
        frame.open = false;
      }
    });
  });
}
