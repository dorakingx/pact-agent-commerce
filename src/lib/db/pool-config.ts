/**
 * Turns a Postgres connection URL into explicit node-postgres connection settings.
 *
 * node-postgres lets the connection string override any `ssl` option passed next to it and
 * warns on every cold start about `sslmode=require` (what managed Postgres URLs ship with).
 * Deciding TLS here keeps the behaviour explicit: remote hosts always get a fully verified TLS
 * connection, local hosts get none, and the URL can still opt out with `sslmode=disable`.
 *
 * Pure and dependency-free so that scripts/migrate.ts can share it. Error messages never echo
 * the URL: it contains the database password.
 */

export interface PoolConnectionConfig {
  connectionString: string;
  /** Omitted when the URL carries its own TLS material and node-postgres must interpret it. */
  ssl?: boolean | { rejectUnauthorized: boolean };
}

const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "[::1]"]);

/** Query parameters that configure TLS in ways only node-postgres itself can honour. */
const DRIVER_MANAGED_TLS_PARAMS = ["ssl", "sslcert", "sslkey", "sslrootcert", "sslnegotiation", "uselibpqcompat"];

function parseUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The database URL is not a valid URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("The database URL must use the postgres:// or postgresql:// scheme");
  }
  return parsed;
}

function tlsFor(sslmode: string | null, hostname: string): boolean | { rejectUnauthorized: boolean } {
  switch (sslmode) {
    case null:
      return !LOCAL_HOSTS.has(hostname);
    case "disable":
      return false;
    case "no-verify":
      return { rejectUnauthorized: false };
    case "allow":
    case "prefer":
    case "require":
    case "verify-ca":
    case "verify-full":
      // Stricter than libpq for the weaker modes on purpose: an unverified certificate
      // protects nothing, and every managed Postgres presents a publicly trusted one.
      return true;
    default:
      throw new Error(`The database URL has an unsupported sslmode "${sslmode}"`);
  }
}

export function poolConfigFromUrl(url: string): PoolConnectionConfig {
  const parsed = parseUrl(url);
  if (DRIVER_MANAGED_TLS_PARAMS.some((name) => parsed.searchParams.has(name))) {
    return { connectionString: url };
  }
  const ssl = tlsFor(parsed.searchParams.get("sslmode"), parsed.hostname);
  // Left in place, sslmode would override the explicit `ssl` setting above.
  parsed.searchParams.delete("sslmode");
  return { connectionString: parsed.toString(), ssl };
}
