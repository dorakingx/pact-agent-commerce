import path from "node:path";
import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // PGlite ships WASM + data sidecars and must not be bundled. It is only loaded when no DATABASE_URL is set.
  serverExternalPackages: ["@electric-sql/pglite", "@paypal/agent-toolkit"],
  // SQL migrations are read from disk at runtime by the PGlite (local/CI) code path, by every
  // route that opens the database: the API handlers and the server-rendered pages alike.
  outputFileTracingIncludes: { "/*": ["./drizzle/**/*"], "/api/**/*": ["./drizzle/**/*"] },
  env: {
    // Where the project is, seen from the directory the server was started in: "" for
    // `npm run dev`, `npm start` and Vercel. `next dev <dir>` launched from elsewhere (an IDE
    // preview, a process manager) would otherwise look for the migrations and the local
    // database under that other directory. Read by src/lib/db/paths.ts; not a secret.
    PACT_PROJECT_DIR: path.relative(process.cwd(), __dirname),
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
