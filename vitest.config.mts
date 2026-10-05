import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const shared = {
  resolve: {
    alias: {
      "@": r("./src"),
      // `server-only` throws outside the react-server condition; tests run in plain Node.
      "server-only": r("./tests/stubs/server-only.ts"),
    },
  },
};

export default defineConfig({
  ...shared,
  test: {
    environment: "node",
    passWithNoTests: true,
    projects: [
      {
        ...shared,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        ...shared,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // PGlite is a single-connection in-process database: keep integration files serial.
          fileParallelism: false,
        },
      },
      {
        ...shared,
        test: {
          // Live PayPal Sandbox tests. Skipped automatically unless PAYPAL_CLIENT_ID/SECRET are set.
          name: "sandbox",
          environment: "node",
          include: ["tests/sandbox/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/**/*.test.ts"],
    },
  },
});
