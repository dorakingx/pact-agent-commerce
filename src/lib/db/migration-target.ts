/**
 * Where the build-time migration step should run — and when it must stop the build instead.
 *
 * Without a database URL the app falls back to PGlite, which is right for local development and
 * CI. On a serverless deployment it is not a fallback at all: every function instance would get
 * its own empty in-memory database, a deal created on one instance would be unknown to the next,
 * and an authorization placed at PayPal would stay held with no durable record of it anywhere.
 * A missing or misnamed variable must therefore fail the deployment loudly, not "skip" quietly.
 *
 * Kept free of I/O so the decision can be tested; scripts/migrate.ts acts on it.
 */

/** The names the app itself reads its runtime URL from (see getDatabaseUrl in ../config.ts). */
const RUNTIME_URL_NAMES = ["DATABASE_URL", "POSTGRES_URL"] as const;
/** A direct connection is preferred for DDL when the provider offers one. */
const DIRECT_URL_NAMES = ["DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING"] as const;
/** Set to "1" to deploy on purpose without a database (a throwaway preview). */
export const ALLOW_EPHEMERAL_DB = "PACT_ALLOW_EPHEMERAL_DB";

export type MigrationTarget =
  | { kind: "migrate"; url: string }
  /** Nothing to migrate: PGlite applies the migrations itself when the app starts. */
  | { kind: "skip"; message: string }
  /** The build must fail: the deployment would run without a durable database. */
  | { kind: "refuse"; message: string };

type Env = Readonly<Record<string, string | undefined>>;

function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/** Variables that look like a database URL under a name the app does not read. Names only, never values. */
function lookalikes(env: Env): string[] {
  const known = new Set<string>([...RUNTIME_URL_NAMES, ...DIRECT_URL_NAMES]);
  return Object.keys(env)
    .filter((name) => !known.has(name) && /(?:DATABASE|POSTGRES|PG).*(?:URL|URI)$/i.test(name) && read(env, name) !== undefined)
    .sort();
}

export function resolveMigrationTarget(env: Env): MigrationTarget {
  const runtimeUrl = read(env, "DATABASE_URL") ?? read(env, "POSTGRES_URL");
  if (runtimeUrl !== undefined) {
    return { kind: "migrate", url: read(env, "DATABASE_URL_UNPOOLED") ?? read(env, "POSTGRES_URL_NON_POOLING") ?? runtimeUrl };
  }
  // VERCEL is set by the platform for every build and function; nothing else identifies a serverless deployment as reliably.
  const serverless = read(env, "VERCEL") !== undefined;
  if (!serverless) return { kind: "skip", message: "No DATABASE_URL — skipping (PGlite migrates at startup)" };
  if (read(env, ALLOW_EPHEMERAL_DB) === "1") {
    return {
      kind: "skip",
      message: `No DATABASE_URL, and ${ALLOW_EPHEMERAL_DB}=1: deploying WITHOUT a durable database. Deals will not survive a function instance.`,
    };
  }
  const found = lookalikes(env);
  const hint = found.length === 0 ? "" : ` Found ${found.join(", ")}, which PACT does not read.`;
  return {
    kind: "refuse",
    message:
      `No database URL is configured for this deployment (looked for ${RUNTIME_URL_NAMES.join(" and ")}).${hint} ` +
      "Without one every function instance would run on its own empty in-memory database, and PayPal authorizations would be held with no durable record. " +
      `Connect a Postgres database, or set ${ALLOW_EPHEMERAL_DB}=1 to deploy a throwaway preview on purpose.`,
  };
}
