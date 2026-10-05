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
  // SQL migrations are read from disk at runtime by the PGlite (local/CI) code path.
  outputFileTracingIncludes: { "/api/**/*": ["./drizzle/**/*"] },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
