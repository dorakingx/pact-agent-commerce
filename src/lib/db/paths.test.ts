import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectPath } from "./paths";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("projectPath", () => {
  it("resolves against the working directory when the server was started from the project root", () => {
    expect(projectPath("drizzle", "/srv/pact", "")).toBe(path.resolve("/srv/pact/drizzle"));
    expect(projectPath(".pact-data/dev", "/srv/pact", "")).toBe(path.resolve("/srv/pact/.pact-data/dev"));
  });

  it("finds the project when the server was started from somewhere else", () => {
    // `next dev /srv/pact` launched from /tmp/preview/session: the project is two levels up and over.
    const relative = path.relative("/tmp/preview/session", "/srv/pact");
    expect(projectPath("drizzle", "/tmp/preview/session", relative)).toBe(path.resolve("/srv/pact/drizzle"));
    expect(projectPath(".pact-data/dev", "/tmp/preview/session", relative)).toBe(path.resolve("/srv/pact/.pact-data/dev"));
  });

  it("leaves an absolute target alone, wherever the project is", () => {
    const absolute = path.resolve("/var/lib/pact/data");
    expect(projectPath(absolute, "/srv/pact", "")).toBe(absolute);
    expect(projectPath(absolute, "/tmp/preview/session", "../../../srv/pact")).toBe(absolute);
  });

  it("reads the recorded project directory from PACT_PROJECT_DIR and defaults to the working directory", () => {
    expect(projectPath("drizzle")).toBe(path.join(process.cwd(), "drizzle"));
    vi.stubEnv("PACT_PROJECT_DIR", "nested/app");
    expect(projectPath("drizzle")).toBe(path.join(process.cwd(), "nested", "app", "drizzle"));
  });

  it("points at the migrations this repository ships", () => {
    expect(existsSync(path.join(projectPath("drizzle"), "meta", "_journal.json"))).toBe(true);
  });
});
