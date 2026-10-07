import { defineConfig, devices } from "@playwright/test";

/** Not 3000/3100: a developer's own dev server usually sits there, and these tests must never talk to it. */
const PORT = Number(process.env.PACT_E2E_PORT ?? 3190);
/**
 * "localhost", not 127.0.0.1: the session cookie is `Secure` in a production build, and both
 * Chromium and Playwright's API client only send a Secure cookie over plain http to localhost.
 */
const BASE_URL = `http://localhost:${PORT}`;
const IS_CI = Boolean(process.env.CI);

/**
 * End-to-end tests run against the production build (`npm run build` first), because that is
 * what ships. The server is started with scripted agents, the payment simulator and an in-memory
 * database, so a run needs no credentials, calls no model and no PayPal API, leaves nothing
 * behind and is repeatable.
 *
 * The specs assert outcomes that only hold in that mode, so a server that happens to be running
 * is never reused by default. To iterate against one you started yourself — with
 * PACT_AI_MODE=scripted and PACT_PAYMENT_MODE=simulated — set PACT_E2E_REUSE=1.
 */
export default defineConfig({
  // Scoped on purpose: without it Playwright would also collect the Vitest files (*.test.ts).
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: IS_CI,
  retries: IS_CI ? 1 : 0,
  // Ceilings, not budgets: every wait is on visible state, and a loaded machine should slow the
  // suite down rather than fail it. UI flows that run a whole deal set their own, longer limit.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: IS_CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    /*
     * Headless Chromium composites in software. A live deal keeps a few small looping indicators
     * (spinner, pulse dots) under the sticky bar's backdrop blur, which costs a CPU core per page
     * there and made parallel runs about four times slower. The product honours reduced motion,
     * so the specs run with it; the happy-path walk-through opts back in to full motion.
     */
    contextOptions: { reducedMotion: "reduce" },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: process.env.PACT_E2E_REUSE === "1",
    timeout: 60_000,
    env: {
      PACT_AI_MODE: "scripted",
      PACT_PAYMENT_MODE: "simulated",
      PACT_LOG_SILENT: "1",
      // Hermetic: `next start` also reads .env.local, and a developer's file may name their local
      // data directory (PGlite allows one process per directory), a real database or a public
      // URL. Empty values win over that file and select an in-memory database for this server alone.
      PGLITE_DIR: "",
      DATABASE_URL: "",
      POSTGRES_URL: "",
      APP_URL: "",
      NEXT_PUBLIC_APP_URL: "",
      SESSION_SECRET: process.env.SESSION_SECRET ?? "e2e-only-session-secret-not-used-anywhere-else",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
