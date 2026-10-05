import { describe, expect, it } from "vitest";
import { poolConfigFromUrl } from "./pool-config";

describe("poolConfigFromUrl", () => {
  it("verifies TLS for a managed Postgres URL and removes sslmode from the connection string", () => {
    const config = poolConfigFromUrl(
      "postgresql://app:s3cr3t@ep-cool-123-pooler.us-east-1.aws.neon.tech/pact?sslmode=require&channel_binding=require",
    );

    expect(config.ssl).toBe(true);
    expect(config.connectionString).toBe(
      "postgresql://app:s3cr3t@ep-cool-123-pooler.us-east-1.aws.neon.tech/pact?channel_binding=require",
    );
  });

  it("uses TLS for a remote host even when the URL does not ask for it", () => {
    expect(poolConfigFromUrl("postgres://app:pw@db.internal.example.com:5432/pact")).toEqual({
      connectionString: "postgres://app:pw@db.internal.example.com:5432/pact",
      ssl: true,
    });
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])("connects to %s without TLS by default", (host) => {
    expect(poolConfigFromUrl(`postgres://postgres:postgres@${host}:5432/pact`).ssl).toBe(false);
  });

  it("honours sslmode=disable and sslmode=no-verify", () => {
    expect(poolConfigFromUrl("postgres://app:pw@db.example.com/pact?sslmode=disable").ssl).toBe(false);
    expect(poolConfigFromUrl("postgres://app:pw@db.example.com/pact?sslmode=no-verify").ssl).toEqual({
      rejectUnauthorized: false,
    });
  });

  it.each(["allow", "prefer", "require", "verify-ca", "verify-full"])("treats sslmode=%s as full verification", (mode) => {
    expect(poolConfigFromUrl(`postgres://app:pw@localhost/pact?sslmode=${mode}`).ssl).toBe(true);
  });

  it("leaves URLs with their own TLS material for the driver to interpret", () => {
    const url = "postgres://app:pw@db.example.com/pact?sslmode=verify-full&sslrootcert=/etc/ssl/ca.pem";

    expect(poolConfigFromUrl(url)).toEqual({ connectionString: url });
  });

  it("keeps percent-encoded credentials intact", () => {
    const config = poolConfigFromUrl("postgres://app:p%40ss%2Fword@db.example.com/pact?sslmode=require");

    expect(config.connectionString).toBe("postgres://app:p%40ss%2Fword@db.example.com/pact");
  });

  it("rejects malformed input without echoing it (the URL contains the password)", () => {
    const attempts = ["not a url with s3cr3t", "mysql://app:s3cr3t@db.example.com/pact", "postgres://app:s3cr3t@db/pact?sslmode=bogus"];

    for (const url of attempts) {
      let message = "";
      try {
        poolConfigFromUrl(url);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("s3cr3t");
    }
  });
});
