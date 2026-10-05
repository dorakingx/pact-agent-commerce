/**
 * Register the PACT webhook endpoint with PayPal Sandbox — or find it if it already exists —
 * and print its webhook id (the value for PAYPAL_WEBHOOK_ID).
 *
 *   tsx scripts/paypal-webhook-register.ts https://host/api/webhooks/paypal
 *
 * Credentials come from PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (and optionally PAYPAL_API_BASE);
 * .env.local and .env are loaded when present. Standard output carries ONLY the webhook id, so
 * the result can be piped straight into `vercel env add`. Everything else goes to stderr.
 */
import { z } from "zod";
import { PayPalHttp } from "../src/lib/payments/paypal-http";
import { PaymentError } from "../src/lib/payments/types";
import { SUBSCRIBED_EVENT_TYPES } from "../src/lib/payments/webhook";

const WEBHOOKS_PATH = "/v1/notifications/webhooks";
const SANDBOX_API_BASE = "https://api-m.sandbox.paypal.com";

const WebhookSchema = z.object({
  id: z.string().min(1),
  url: z.string(),
  event_types: z.array(z.object({ name: z.string() })).nullish(),
});
const WebhookListSchema = z.object({ webhooks: z.array(WebhookSchema).nullish() });
type Webhook = z.infer<typeof WebhookSchema>;

class UsageError extends Error {}

function loadEnvFiles(): void {
  for (const file of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // The file is optional; variables may just as well come from the shell.
    }
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new UsageError(`${name} is not set`);
  return value;
}

function parseWebhookUrl(argument: string | undefined): string {
  if (!argument) throw new UsageError("usage: tsx scripts/paypal-webhook-register.ts https://host/api/webhooks/paypal");
  let url: URL;
  try {
    url = new URL(argument);
  } catch {
    throw new UsageError(`not a valid URL: ${argument}`);
  }
  // PayPal only delivers webhooks to HTTPS endpoints on port 443.
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443")) {
    throw new UsageError("PayPal only delivers webhooks to https URLs on port 443");
  }
  return url.toString();
}

/** PayPal treats "*" as a subscription to every event type. */
function coversAllEvents(webhook: Webhook): boolean {
  const names = new Set((webhook.event_types ?? []).map((eventType) => eventType.name));
  return names.has("*") || SUBSCRIBED_EVENT_TYPES.every((name) => names.has(name));
}

async function findOrRegister(http: PayPalHttp, url: string): Promise<string> {
  const eventTypes = SUBSCRIBED_EVENT_TYPES.map((name) => ({ name }));
  const listed = await http.request({ method: "GET", path: WEBHOOKS_PATH, template: WEBHOOKS_PATH });
  const existing = (WebhookListSchema.parse(listed.body).webhooks ?? []).find((webhook) => webhook.url === url);

  if (existing === undefined) {
    const created = await http.request({
      method: "POST",
      path: WEBHOOKS_PATH,
      template: WEBHOOKS_PATH,
      body: { url, event_types: eventTypes },
    });
    return WebhookSchema.parse(created.body).id;
  }
  if (!coversAllEvents(existing)) {
    // The subscription list grew since the webhook was registered: bring it up to date in place,
    // so the webhook id (and PAYPAL_WEBHOOK_ID) stays the same.
    await http.request({
      method: "PATCH",
      path: `${WEBHOOKS_PATH}/${encodeURIComponent(existing.id)}`,
      template: `${WEBHOOKS_PATH}/{id}`,
      body: [{ op: "replace", path: "/event_types", value: eventTypes }],
    });
  }
  return existing.id;
}

async function main(): Promise<void> {
  loadEnvFiles();
  // The transport logs one JSON line per request to stdout; this script's stdout is reserved for the id.
  process.env.PACT_LOG_SILENT = "1";
  const url = parseWebhookUrl(process.argv[2]);
  const http = new PayPalHttp({
    clientId: requireEnv("PAYPAL_CLIENT_ID"),
    clientSecret: requireEnv("PAYPAL_CLIENT_SECRET"),
    apiBase: process.env.PAYPAL_API_BASE?.trim() || SANDBOX_API_BASE,
  });
  process.stdout.write(`${await findOrRegister(http, url)}\n`);
}

main().catch((error: unknown) => {
  if (error instanceof PaymentError) {
    const debug = error.debugId === null ? "" : ` (debug_id ${error.debugId})`;
    process.stderr.write(`PayPal refused the request: ${error.issue} — ${error.message}${debug}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
