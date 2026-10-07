/**
 * Server-side configuration. Read lazily so that importing this module never throws at build time.
 * Secrets are only ever read here and in the modules that need them; they are never logged
 * and never sent to the browser (see /api/health for the redacted view).
 */
import "server-only";

const SANDBOX_API_BASE = "https://api-m.sandbox.paypal.com";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  apiBase: string;
  /** Webhook id from PayPal (required to verify webhook signatures). */
  webhookId: string | undefined;
}

/** Returns PayPal Sandbox credentials, or null when they are not configured. */
export function getPayPalConfig(): PayPalConfig | null {
  const clientId = env("PAYPAL_CLIENT_ID");
  const clientSecret = env("PAYPAL_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  const apiBase = env("PAYPAL_API_BASE") ?? SANDBOX_API_BASE;
  // PACT is a sandbox demo. Refuse to talk to the live API even if someone misconfigures it.
  if (!isSandboxBase(apiBase)) {
    throw new Error("PAYPAL_API_BASE must point at the PayPal Sandbox (api-m.sandbox.paypal.com)");
  }
  return { clientId, clientSecret, apiBase, webhookId: env("PAYPAL_WEBHOOK_ID") };
}

export function isSandboxBase(base: string): boolean {
  try {
    const u = new URL(base);
    if (u.protocol === "https:" && (u.hostname === "api-m.sandbox.paypal.com" || u.hostname === "api.sandbox.paypal.com")) {
      return true;
    }
    // Local PayPal emulator used by integration tests only.
    return process.env.NODE_ENV !== "production" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  } catch {
    return false;
  }
}

export type PaymentMode = "paypal_sandbox" | "simulated";

/**
 * Which payment provider is active. PayPal Sandbox whenever credentials exist; the simulator is
 * only a fallback for keyless local development and CI, and is always labelled as simulated.
 */
export function getPaymentMode(): PaymentMode {
  if (env("PACT_PAYMENT_MODE") === "simulated") return "simulated";
  return getPayPalConfig() ? "paypal_sandbox" : "simulated";
}

export type AiMode = "ai" | "scripted";

/** "scripted" forces the deterministic fallback agents (used by tests and E2E for repeatability). */
export function getAiMode(): AiMode {
  return env("PACT_AI_MODE") === "scripted" ? "scripted" : "ai";
}

export interface ModelConfig {
  buyer: string;
  seller: string;
  verifier: string;
  studio: string;
  ops: string;
  /** Used when a role's primary model fails. */
  fallbacks: string[];
}

/**
 * Buyer and seller run on DIFFERENT model families on purpose: in real agent-to-agent commerce
 * the two sides are independent systems, and nothing in PACT assumes they share a model.
 */
export function getModelConfig(): ModelConfig {
  return {
    buyer: env("PACT_MODEL_BUYER") ?? "google/gemini-2.5-flash",
    seller: env("PACT_MODEL_SELLER") ?? "openai/gpt-5-mini",
    verifier: env("PACT_MODEL_VERIFIER") ?? "google/gemini-2.5-flash",
    studio: env("PACT_MODEL_STUDIO") ?? "google/gemini-2.5-flash",
    ops: env("PACT_MODEL_OPS") ?? "google/gemini-2.5-flash",
    fallbacks: (env("PACT_MODEL_FALLBACKS") ?? "openai/gpt-5-mini,google/gemini-2.5-flash")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export function getDatabaseUrl(): string | undefined {
  return env("DATABASE_URL") ?? env("POSTGRES_URL");
}

/** Secret used to sign the anonymous session cookie. A per-process random value is used in dev. */
export function getSessionSecret(): string {
  const s = env("SESSION_SECRET");
  if (s) return s;
  if (process.env.NODE_ENV === "production" && !process.env.PACT_ALLOW_EPHEMERAL_SECRET) {
    throw new Error("SESSION_SECRET is required in production");
  }
  const g = globalThis as { __pactDevSecret?: string };
  g.__pactDevSecret ??= crypto.randomUUID() + crypto.randomUUID();
  return g.__pactDevSecret;
}

/** Operator token for privileged actions (connect the demo wallet, seed showcase deals, register webhooks). */
export function getAdminToken(): string | undefined {
  return env("ADMIN_TOKEN");
}

/**
 * Shared secret of the scheduled sweep (Vercel Cron sends it as `Authorization: Bearer …`).
 * Unset means the sweep endpoint is closed.
 */
export function getCronSecret(): string | undefined {
  return env("CRON_SECRET");
}

/** Absolute base URL of this deployment, used for PayPal return/cancel URLs. */
export function getAppUrl(requestOrigin?: string): string {
  const explicit = env("APP_URL") ?? env("NEXT_PUBLIC_APP_URL");
  if (explicit) return explicit.replace(/\/$/, "");
  if (requestOrigin) return requestOrigin.replace(/\/$/, "");
  const vercel = env("VERCEL_PROJECT_PRODUCTION_URL") ?? env("VERCEL_URL");
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}

export const APP_VERSION = process.env.npm_package_version ?? "0.1.0";
