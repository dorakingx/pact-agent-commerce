import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PACT_E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const IS_CI = Boolean(process.env.CI);

/**
 * Browser tests run against the production build (`npm run build` first), because that is what
 * ships. The server is started with scripted agents and the payment simulator, so a run needs no
 * credentials, calls no model and no PayPal API, and is repeatable.
 */
export default defineConfig({
  // Scoped on purpose: without it Playwright would also collect the Vitest files (*.test.ts).
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: IS_CI,
  retries: IS_CI ? 1 : 0,
  reporter: IS_CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !IS_CI,
    timeout: 60_000,
    env: {
      PACT_AI_MODE: "scripted",
      PACT_PAYMENT_MODE: "simulated",
      PACT_LOG_SILENT: "1",
      SESSION_SECRET: process.env.SESSION_SECRET ?? "e2e-only-session-secret-not-used-anywhere-else",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
