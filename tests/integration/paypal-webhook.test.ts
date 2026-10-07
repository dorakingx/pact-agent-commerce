/**
 * PayPal webhooks end to end: signature verification (self-verification with a certificate
 * served from a paypal.com host, replay window, postback fallback), then interpretation of each
 * subscribed event type and its effect on a payment record.
 *
 * The signing key pair is generated here, and events are signed exactly as PayPal signs them:
 * RSA-SHA256 over `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(rawBody)}`.
 */
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { crc32 } from "node:zlib";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditEventSchema } from "@/lib/domain/schemas";
import { canPaymentTransition } from "@/lib/domain/status";
import { newPaymentRecord } from "@/lib/payments/orchestrator";
import { PayPalSandboxProvider } from "@/lib/payments/paypal-client";
import type { PaymentRecord } from "@/lib/payments/types";
import {
  SUBSCRIBED_EVENT_TYPES,
  applyWebhookEffect,
  interpretWebhookEvent,
  storedWebhookPayload,
  type WebhookApplication,
  type WebhookEffect,
} from "@/lib/payments/webhook";

const API = "https://api-m.sandbox.paypal.com";
const WEBHOOK_ID = "8PT597110X687430LKGECATA";
const CERT_URL = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-90621ecd";
const VERIFY_PATH = "/v1/notifications/verify-webhook-signature";
const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const ORDER_ID = "5O190127TN364715T";
const AUTHORIZATION_ID = "0AW2184448108334S";
const CAPTURE_ID = "2GG279541U471931P";
const CUSTOM_ID = `pact:v1:${"ab".repeat(32)}`;

/* -------------------------------------------------------------------------- */
/*  Signature verification                                                     */
/* -------------------------------------------------------------------------- */

let privateKey: KeyObject;
let certificatePem: string;

interface FetchLog {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

interface Net {
  log: FetchLog[];
  /** What the certificate URL answers with. */
  certificate: () => Response;
  /** What PayPal's postback verification answers with. */
  postback: () => Response;
  fetch: typeof fetch;
}

function createNet(): Net {
  const net: Net = {
    log: [],
    certificate: () => new Response(certificatePem, { status: 200, headers: { "content-type": "application/x-pem-file" } }),
    postback: () => Response.json({ verification_status: "SUCCESS" }),
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      net.log.push({
        url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : null,
      });
      if (url === `${API}/v1/oauth2/token`) return Response.json({ access_token: "A21AA-webhook-test-token", token_type: "Bearer", expires_in: 3600 });
      if (url === `${API}${VERIFY_PATH}`) return net.postback();
      if (url.includes("/v1/notifications/certs/")) return net.certificate();
      return new Response("not found", { status: 404 });
    },
  };
  return net;
}

/** `webhookId: null` builds a provider with no webhook id configured. */
function providerFor(net: Net, webhookId: string | null = WEBHOOK_ID): PayPalSandboxProvider {
  return new PayPalSandboxProvider({
    clientId: "sandbox-client-id",
    clientSecret: "sandbox-client-secret",
    apiBase: API,
    ...(webhookId === null ? {} : { webhookId }),
    fetchImpl: net.fetch,
    now: () => NOW,
    sleep: async () => {},
  });
}

interface SignOptions {
  transmissionId?: string;
  transmissionTime?: string;
  webhookId?: string;
  certUrl?: string;
  authAlgo?: string | null;
}

/** Headers exactly as PayPal sends them for `rawBody`. */
function sign(rawBody: string, options: SignOptions = {}): Headers {
  const transmissionId = options.transmissionId ?? "69cd13f0-d67a-11e5-baa3-778b53f4ae55";
  const transmissionTime = options.transmissionTime ?? new Date(NOW - 5_000).toISOString();
  const message = `${transmissionId}|${transmissionTime}|${options.webhookId ?? WEBHOOK_ID}|${crc32(rawBody)}`;
  const headers = new Headers({
    "paypal-transmission-id": transmissionId,
    "paypal-transmission-time": transmissionTime,
    "paypal-transmission-sig": createSign("SHA256").update(message).sign(privateKey, "base64"),
    "paypal-cert-url": options.certUrl ?? CERT_URL,
    "content-type": "application/json",
  });
  const authAlgo = options.authAlgo === undefined ? "SHA256withRSA" : options.authAlgo;
  if (authAlgo !== null) headers.set("paypal-auth-algo", authAlgo);
  return headers;
}

function captureCompletedEvent(): Record<string, unknown> {
  return {
    id: "WH-58D329510W468432D-8HN650336L201105X",
    event_version: "1.0",
    create_time: "2026-10-06T11:59:55.000Z",
    resource_type: "capture",
    resource_version: "2.0",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    summary: "Payment completed for $ 90.0 USD",
    resource: {
      id: CAPTURE_ID,
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "90.00" },
      final_capture: true,
      custom_id: CUSTOM_ID,
      invoice_id: "ctr_webhook000001",
      seller_protection: { status: "ELIGIBLE" },
      supplementary_data: { related_ids: { order_id: ORDER_ID, authorization_id: AUTHORIZATION_ID } },
      links: [
        { href: `${API}/v2/payments/captures/${CAPTURE_ID}`, rel: "self", method: "GET" },
        { href: `${API}/v2/payments/authorizations/${AUTHORIZATION_ID}`, rel: "up", method: "GET" },
      ],
    },
    links: [],
  };
}

const RAW_BODY = JSON.stringify(captureCompletedEvent());

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  certificatePem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
});

describe("verifyWebhook — self-verification", () => {
  let net: Net;
  let provider: PayPalSandboxProvider;

  beforeEach(() => {
    net = createNet();
    provider = providerFor(net);
  });

  it("verifies a correctly signed event against the certificate from a paypal.com host", async () => {
    await expect(provider.verifyWebhook(sign(RAW_BODY), RAW_BODY)).resolves.toEqual({ verified: true, method: "self", reason: null });
    // Only the certificate was fetched: no token, no postback.
    expect(net.log.map((entry) => entry.url)).toEqual([CERT_URL]);
  });

  it("verifies the exact bytes: unusual whitespace, escapes and non-ASCII text survive", async () => {
    const raw = '{ "id":"WH-1",\n  "summary":"Caf\\u00e9 — 支払い ✓", "resource":{"amount":{"value":"10.00"}} }';
    await expect(provider.verifyWebhook(sign(raw), raw)).resolves.toMatchObject({ verified: true, method: "self" });
  });

  it("caches the certificate between events", async () => {
    await provider.verifyWebhook(sign(RAW_BODY), RAW_BODY);
    const other = JSON.stringify({ ...captureCompletedEvent(), id: "WH-ANOTHER" });
    await expect(provider.verifyWebhook(sign(other), other)).resolves.toMatchObject({ verified: true });
    expect(net.log.filter((entry) => entry.url === CERT_URL)).toHaveLength(1);
  });

  it("accepts an event without the auth-algo header (PayPal's own sample does not read it)", async () => {
    await expect(provider.verifyWebhook(sign(RAW_BODY, { authAlgo: null }), RAW_BODY)).resolves.toMatchObject({ verified: true, method: "self" });
  });

  it("rejects a tampered body", async () => {
    const headers = sign(RAW_BODY);
    const tampered = RAW_BODY.replace('"90.00"', '"9000.00"');
    await expect(provider.verifyWebhook(headers, tampered)).resolves.toEqual({ verified: false, method: "self", reason: "signature_mismatch" });
    // A definite mismatch is final: PayPal is not asked for a second opinion.
    expect(net.log.some((entry) => entry.url.endsWith(VERIFY_PATH))).toBe(false);
  });

  it("rejects an event signed for a different webhook id", async () => {
    const headers = sign(RAW_BODY, { webhookId: "SOMEONE-ELSES-WEBHOOK-ID" });
    await expect(provider.verifyWebhook(headers, RAW_BODY)).resolves.toMatchObject({ verified: false, reason: "signature_mismatch" });
  });

  it("rejects a tampered transmission id or time, because both are part of the signed message", async () => {
    const reusedId = sign(RAW_BODY);
    reusedId.set("paypal-transmission-id", "00000000-0000-0000-0000-000000000000");
    await expect(provider.verifyWebhook(reusedId, RAW_BODY)).resolves.toMatchObject({ verified: false, reason: "signature_mismatch" });

    const refreshedTime = sign(RAW_BODY, { transmissionTime: new Date(NOW - 5 * HOUR_MS).toISOString() });
    refreshedTime.set("paypal-transmission-time", new Date(NOW).toISOString());
    await expect(provider.verifyWebhook(refreshedTime, RAW_BODY)).resolves.toMatchObject({ verified: false, reason: "signature_mismatch" });
  });

  it("rejects a garbage signature", async () => {
    const headers = sign(RAW_BODY);
    headers.set("paypal-transmission-sig", "bm90IGEgc2lnbmF0dXJl");
    await expect(provider.verifyWebhook(headers, RAW_BODY)).resolves.toMatchObject({ verified: false, method: "self", reason: "signature_mismatch" });
  });

  it.each([
    "https://attacker.example/v1/notifications/certs/CERT-1",
    "https://api.sandbox.paypal.com.attacker.example/v1/notifications/certs/CERT-1",
    "https://notpaypal.com/v1/notifications/certs/CERT-1",
    "https://evilpaypal.com/v1/notifications/certs/CERT-1",
    "http://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "https://api.sandbox.paypal.com:8443/v1/notifications/certs/CERT-1",
    "https://user:pw@api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "not a url",
  ])("refuses the certificate URL %s without fetching anything", async (certUrl) => {
    // Signed with a key the attacker controls and served from their host: it must never be fetched.
    await expect(provider.verifyWebhook(sign(RAW_BODY, { certUrl }), RAW_BODY)).resolves.toEqual({
      verified: false,
      method: "self",
      reason: "untrusted_cert_url",
    });
    expect(net.log).toEqual([]);
  });

  it.each(["https://paypal.com/v1/notifications/certs/CERT-1", "https://api.paypal.com/v1/notifications/certs/CERT-1"])(
    "trusts the certificate URL %s",
    async (certUrl) => {
      await expect(provider.verifyWebhook(sign(RAW_BODY, { certUrl }), RAW_BODY)).resolves.toMatchObject({ verified: true, method: "self" });
    },
  );

  it.each([
    ["older than 6 hours", NOW - 6 * HOUR_MS - 1000, "stale_transmission"],
    ["more than 10 minutes in the future", NOW + 10 * MINUTE_MS + 1000, "transmission_from_future"],
  ])("rejects a correctly signed transmission that is %s", async (_label, sentAt, reason) => {
    const headers = sign(RAW_BODY, { transmissionTime: new Date(sentAt).toISOString() });
    await expect(provider.verifyWebhook(headers, RAW_BODY)).resolves.toEqual({ verified: false, method: "self", reason });
    expect(net.log).toEqual([]);
  });

  it.each([
    ["just inside the 6 hour window", NOW - 6 * HOUR_MS + 1000],
    ["slightly ahead of this server's clock", NOW + 9 * MINUTE_MS],
  ])("accepts a transmission %s", async (_label, sentAt) => {
    const headers = sign(RAW_BODY, { transmissionTime: new Date(sentAt).toISOString() });
    await expect(provider.verifyWebhook(headers, RAW_BODY)).resolves.toMatchObject({ verified: true });
  });

  it("rejects an unparseable transmission time", async () => {
    await expect(provider.verifyWebhook(sign(RAW_BODY, { transmissionTime: "yesterday" }), RAW_BODY)).resolves.toMatchObject({
      verified: false,
      reason: "invalid_transmission_time",
    });
  });

  it.each(["paypal-transmission-id", "paypal-transmission-time", "paypal-transmission-sig", "paypal-cert-url"])(
    "rejects an event without the %s header",
    async (header) => {
      const headers = sign(RAW_BODY);
      headers.delete(header);
      await expect(provider.verifyWebhook(headers, RAW_BODY)).resolves.toEqual({
        verified: false,
        method: "none",
        reason: "missing_signature_headers",
      });
      expect(net.log).toEqual([]);
    },
  );

  it("cannot verify anything without a configured webhook id", async () => {
    const unconfigured = providerFor(net, null);
    await expect(unconfigured.verifyWebhook(sign(RAW_BODY), RAW_BODY)).resolves.toEqual({
      verified: false,
      method: "none",
      reason: "webhook_id_not_configured",
    });
    expect(net.log).toEqual([]);
  });
});

describe("verifyWebhook — postback fallback", () => {
  let net: Net;
  let provider: PayPalSandboxProvider;

  beforeEach(() => {
    net = createNet();
    net.certificate = () => new Response("certificate store unavailable", { status: 503 });
    provider = providerFor(net);
  });

  it("asks PayPal to verify when the certificate cannot be fetched", async () => {
    const headers = sign(RAW_BODY);
    await expect(provider.verifyWebhook(headers, RAW_BODY)).resolves.toEqual({ verified: true, method: "postback", reason: null });

    const postback = net.log.find((entry) => entry.url === `${API}${VERIFY_PATH}`);
    expect(postback?.method).toBe("POST");
    expect(postback?.headers.get("authorization")).toBe("Bearer A21AA-webhook-test-token");
    expect(postback?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(postback?.body ?? "null")).toEqual({
      auth_algo: "SHA256withRSA",
      cert_url: CERT_URL,
      transmission_id: headers.get("paypal-transmission-id"),
      transmission_sig: headers.get("paypal-transmission-sig"),
      transmission_time: headers.get("paypal-transmission-time"),
      webhook_id: WEBHOOK_ID,
      // The event as a JSON object, not as a string.
      webhook_event: captureCompletedEvent(),
    });
  });

  it("embeds the received bytes verbatim, so PayPal's checksum still matches", async () => {
    // Re-serialising would turn 10.00 into 10 and reorder nothing but still change the CRC.
    const raw = '{"id":"WH-RAW",  "resource":{"fee":10.00,"note":"caf\\u00e9"}}';
    await provider.verifyWebhook(sign(raw), raw);
    const postback = net.log.find((entry) => entry.url === `${API}${VERIFY_PATH}`);
    expect(postback?.body).toContain(`"webhook_event":${raw}}`);
  });

  it("reports PayPal's FAILURE verdict as not verified", async () => {
    net.postback = () => Response.json({ verification_status: "FAILURE" });
    await expect(provider.verifyWebhook(sign(RAW_BODY), RAW_BODY)).resolves.toEqual({ verified: false, method: "postback", reason: "postback_failure" });
  });

  it("distinguishes 'could not ask PayPal' from a rejection, and does not retry the postback", async () => {
    net.postback = () => Response.json({ name: "INTERNAL_SERVER_ERROR", message: "An internal server error has occurred." }, { status: 500 });
    await expect(provider.verifyWebhook(sign(RAW_BODY), RAW_BODY)).resolves.toEqual({ verified: false, method: "postback", reason: "postback_unavailable" });
    // No PayPal-Request-Id on this call, so the transport must not repeat it.
    expect(net.log.filter((entry) => entry.url === `${API}${VERIFY_PATH}`)).toHaveLength(1);
  });

  it("does not post a body that is not a JSON object", async () => {
    for (const raw of ["not json", '"a string"', "[1,2,3]", ""]) {
      await expect(provider.verifyWebhook(sign(raw), raw)).resolves.toEqual({ verified: false, method: "postback", reason: "body_not_json" });
    }
    expect(net.log.some((entry) => entry.url === `${API}${VERIFY_PATH}`)).toBe(false);
  });

  it("falls back when the certificate URL serves something that is not a key", async () => {
    net.certificate = () => new Response("<html>maintenance</html>", { status: 200 });
    await expect(provider.verifyWebhook(sign(RAW_BODY), RAW_BODY)).resolves.toMatchObject({ verified: true, method: "postback" });
  });

  it("falls back when the certificate fetch itself fails", async () => {
    net.certificate = () => {
      throw new TypeError("fetch failed");
    };
    await expect(provider.verifyWebhook(sign(RAW_BODY), RAW_BODY)).resolves.toMatchObject({ verified: true, method: "postback" });
  });

  it("refuses a signature algorithm PayPal does not use, without fetching or asking anything", async () => {
    net.certificate = () => new Response(certificatePem, { status: 200 });
    await expect(provider.verifyWebhook(sign(RAW_BODY, { authAlgo: "SHA512withRSA" }), RAW_BODY)).resolves.toEqual({
      verified: false,
      method: "self",
      reason: "unsupported_auth_algo",
    });
    expect(net.log).toEqual([]);
  });

  it("does not fetch a certificate URL again for a while after it failed", async () => {
    const certFetches = (): number => net.log.filter((entry) => entry.url === CERT_URL).length;
    for (let delivery = 0; delivery < 4; delivery += 1) await provider.verifyWebhook(sign(RAW_BODY), RAW_BODY);
    expect(certFetches()).toBe(1);

    // Once the certificate store is back and the failure has aged out, the key is fetched and cached.
    net.certificate = () => new Response(certificatePem, { status: 200 });
    let clock = NOW;
    const later = new PayPalSandboxProvider({
      clientId: "sandbox-client-id",
      clientSecret: "sandbox-client-secret",
      apiBase: API,
      webhookId: WEBHOOK_ID,
      fetchImpl: net.fetch,
      now: () => clock,
      sleep: async () => {},
    });
    net.certificate = () => new Response("certificate store unavailable", { status: 503 });
    await later.verifyWebhook(sign(RAW_BODY), RAW_BODY);
    net.certificate = () => new Response(certificatePem, { status: 200 });
    await expect(later.verifyWebhook(sign(RAW_BODY), RAW_BODY)).resolves.toMatchObject({ method: "postback" });
    clock += 5 * MINUTE_MS + 1000;
    const fresh = sign(RAW_BODY, { transmissionTime: new Date(clock).toISOString() });
    await expect(later.verifyWebhook(fresh, RAW_BODY)).resolves.toEqual({ verified: true, method: "self", reason: null });
  });

  it("makes no outbound call the caller's budget does not allow: forged deliveries cannot be turned into PayPal traffic", async () => {
    let asked = 0;
    const refuseAll = { mayCallOut: async () => ((asked += 1), false) };
    for (let delivery = 0; delivery < 10; delivery += 1) {
      const certUrl = `https://api.sandbox.paypal.com/v1/notifications/certs/CERT-FORGED-${delivery}`;
      await expect(provider.verifyWebhook(sign(RAW_BODY, { certUrl }), RAW_BODY, refuseAll)).resolves.toEqual({
        verified: false,
        method: "postback",
        reason: "verification_budget_spent",
      });
    }
    expect(net.log).toEqual([]);
    expect(asked).toBe(20);
  });

  it("verifies from the cached key without spending the budget", async () => {
    net.certificate = () => new Response(certificatePem, { status: 200 });
    await expect(provider.verifyWebhook(sign(RAW_BODY), RAW_BODY)).resolves.toMatchObject({ verified: true, method: "self" });
    let asked = 0;
    const refuseAll = { mayCallOut: async () => ((asked += 1), false) };
    await expect(provider.verifyWebhook(sign(RAW_BODY), RAW_BODY, refuseAll)).resolves.toMatchObject({ verified: true, method: "self" });
    expect(asked).toBe(0);
  });

  it("still applies the cert-host and replay checks before falling back", async () => {
    await expect(
      provider.verifyWebhook(sign(RAW_BODY, { certUrl: "https://attacker.example/cert.pem" }), RAW_BODY),
    ).resolves.toMatchObject({ verified: false, reason: "untrusted_cert_url" });
    await expect(
      provider.verifyWebhook(sign(RAW_BODY, { transmissionTime: new Date(NOW - 7 * HOUR_MS).toISOString() }), RAW_BODY),
    ).resolves.toMatchObject({ verified: false, reason: "stale_transmission" });
    expect(net.log).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Interpretation                                                             */
/* -------------------------------------------------------------------------- */

function event(eventType: string, resource: Record<string, unknown>, id = `WH-${eventType}`): Record<string, unknown> {
  return { id, event_type: eventType, resource_type: "test", create_time: "2026-10-06T11:59:55.000Z", resource };
}

const AMOUNT = { currency_code: "USD", value: "90.00" };
const RELATED = { supplementary_data: { related_ids: { order_id: ORDER_ID, authorization_id: AUTHORIZATION_ID } } };
const captureResource = { id: CAPTURE_ID, amount: AMOUNT, custom_id: CUSTOM_ID, invoice_id: "ctr_webhook000001", ...RELATED };
const authorizationResource = {
  id: AUTHORIZATION_ID,
  status: "CREATED",
  amount: AMOUNT,
  custom_id: CUSTOM_ID,
  invoice_id: "ctr_webhook000001",
  expiration_time: "2026-11-04T12:00:00Z",
  supplementary_data: { related_ids: { order_id: ORDER_ID } },
};

describe("interpretWebhookEvent", () => {
  it("subscribes to exactly the event types it can interpret", () => {
    expect([...SUBSCRIBED_EVENT_TYPES].sort()).toEqual([
      "CHECKOUT.ORDER.APPROVED",
      "PAYMENT.AUTHORIZATION.CREATED",
      "PAYMENT.AUTHORIZATION.VOIDED",
      "PAYMENT.CAPTURE.COMPLETED",
      "PAYMENT.CAPTURE.DECLINED",
      "PAYMENT.CAPTURE.DENIED",
      "PAYMENT.CAPTURE.PENDING",
      "PAYMENT.CAPTURE.REFUNDED",
      "PAYMENT.CAPTURE.REVERSED",
    ]);
    for (const eventType of SUBSCRIBED_EVENT_TYPES) {
      expect(interpretWebhookEvent(event(eventType, captureResource)).kind).not.toBe("ignored");
    }
  });

  it("reads CHECKOUT.ORDER.APPROVED from the order and its purchase unit", () => {
    const effect = interpretWebhookEvent(
      event("CHECKOUT.ORDER.APPROVED", {
        id: ORDER_ID,
        status: "APPROVED",
        intent: "AUTHORIZE",
        purchase_units: [{ reference_id: "deal_webhook", amount: AMOUNT, custom_id: CUSTOM_ID, invoice_id: "ctr_webhook000001" }],
        payer: { email_address: "sb-buyer@personal.example.com" },
      }),
    );
    expect(effect).toEqual({
      kind: "approved",
      eventId: "WH-CHECKOUT.ORDER.APPROVED",
      eventType: "CHECKOUT.ORDER.APPROVED",
      resourceId: ORDER_ID,
      orderId: ORDER_ID,
      authorizationId: null,
      captureId: null,
      amountMinor: 9000,
      customId: CUSTOM_ID,
      invoiceId: "ctr_webhook000001",
      resourceStatus: "APPROVED",
      expiresAt: null,
    });
  });

  it.each([
    ["PAYMENT.AUTHORIZATION.CREATED", "authorized"],
    ["PAYMENT.AUTHORIZATION.VOIDED", "voided"],
  ] as const)("reads %s from the authorization and its related order", (eventType, kind) => {
    expect(interpretWebhookEvent(event(eventType, authorizationResource))).toEqual({
      kind,
      eventId: `WH-${eventType}`,
      eventType,
      resourceId: AUTHORIZATION_ID,
      orderId: ORDER_ID,
      authorizationId: AUTHORIZATION_ID,
      captureId: null,
      amountMinor: 9000,
      customId: CUSTOM_ID,
      invoiceId: "ctr_webhook000001",
      // The authorization's own status and expiry: an event about one that is still PENDING holds nothing.
      resourceStatus: "CREATED",
      expiresAt: "2026-11-04T12:00:00.000Z",
    });
  });

  it.each([
    ["PAYMENT.CAPTURE.COMPLETED", "captured"],
    ["PAYMENT.CAPTURE.PENDING", "capture_pending"],
    ["PAYMENT.CAPTURE.DENIED", "capture_denied"],
    ["PAYMENT.CAPTURE.DECLINED", "capture_denied"],
  ] as const)("reads %s from the capture, finding the authorization in supplementary_data", (eventType, kind) => {
    expect(interpretWebhookEvent(event(eventType, captureResource))).toEqual({
      kind,
      eventId: `WH-${eventType}`,
      eventType,
      resourceId: CAPTURE_ID,
      orderId: ORDER_ID,
      authorizationId: AUTHORIZATION_ID,
      captureId: CAPTURE_ID,
      amountMinor: 9000,
      customId: CUSTOM_ID,
      invoiceId: "ctr_webhook000001",
      resourceStatus: null,
      expiresAt: null,
    });
  });

  it.each(["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"])("reads %s from the refund, finding the capture through the 'up' link", (eventType) => {
    const effect = interpretWebhookEvent(
      event(eventType, {
        id: "1JU08902781691411",
        status: "COMPLETED",
        amount: { currency_code: "USD", value: "45.00" },
        custom_id: CUSTOM_ID,
        invoice_id: "ctr_webhook000001",
        links: [
          { href: `${API}/v2/payments/refunds/1JU08902781691411`, rel: "self", method: "GET" },
          { href: `${API}/v2/payments/captures/${CAPTURE_ID}`, rel: "up", method: "GET" },
        ],
      }),
    );
    expect(effect).toMatchObject({ kind: "refunded", resourceId: "1JU08902781691411", captureId: CAPTURE_ID, authorizationId: null, amountMinor: 4500 });
  });

  it("interprets a real, fully formed PayPal payload", () => {
    expect(interpretWebhookEvent(captureCompletedEvent())).toMatchObject({
      kind: "captured",
      eventId: "WH-58D329510W468432D-8HN650336L201105X",
      captureId: CAPTURE_ID,
      authorizationId: AUTHORIZATION_ID,
      orderId: ORDER_ID,
      amountMinor: 9000,
    });
  });

  it("leaves the amount empty when it is not a well-formed USD amount", () => {
    for (const amount of [{ currency_code: "EUR", value: "90.00" }, { currency_code: "USD", value: "ninety" }, { currency_code: "USD" }, null]) {
      expect(interpretWebhookEvent(event("PAYMENT.CAPTURE.COMPLETED", { ...captureResource, amount })).amountMinor).toBeNull();
    }
  });

  it.each([
    ["an unsubscribed event type", event("CHECKOUT.PAYMENT-APPROVAL.REVERSED", captureResource)],
    ["an unknown event type", event("BILLING.SUBSCRIPTION.CREATED", captureResource)],
    ["a prototype property name as event type", event("constructor", captureResource)],
    ["an event without a resource", { id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED" }],
    ["a resource without an id", event("PAYMENT.CAPTURE.COMPLETED", { amount: AMOUNT })],
    ["a resource of the wrong type", { id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: "capture" }],
  ])("ignores %s", (_label, payload) => {
    const effect = interpretWebhookEvent(payload);
    expect(effect.kind).toBe("ignored");
    expect(effect).toMatchObject({ orderId: null, authorizationId: null, captureId: null, amountMinor: null });
  });

  it.each([null, undefined, 42, "PAYMENT.CAPTURE.COMPLETED", [], { id: 7, event_type: {} }])("never throws on the malformed payload %j", (payload) => {
    expect(interpretWebhookEvent(payload)).toMatchObject({ kind: "ignored", eventId: "", eventType: "" });
  });
});

/* -------------------------------------------------------------------------- */
/*  Application                                                                */
/* -------------------------------------------------------------------------- */

const LATER = new Date("2026-10-06T12:05:00.000Z");
const AuditInputSchema = AuditEventSchema.pick({ actor: true, type: true, title: true, detail: true, data: true, at: true });

function payment(status: PaymentRecord["status"], overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  const base = newPaymentRecord("paypal_sandbox", "interactive", 9000, new Date(NOW));
  const withOrder: Partial<PaymentRecord> = status === "none" ? {} : { orderId: ORDER_ID };
  const withAuthorization: Partial<PaymentRecord> =
    status === "authorized" || status === "captured" || status === "voided" || status === "expired"
      ? { authorizationId: AUTHORIZATION_ID, authorizedMinor: 9000, authorizationExpiresAt: "2026-11-04T12:00:00.000Z" }
      : {};
  const withCapture: Partial<PaymentRecord> = status === "captured" ? { captureId: CAPTURE_ID, capturedMinor: 9000 } : {};
  return { ...base, status, ...withOrder, ...withAuthorization, ...withCapture, ...overrides };
}

function effectOf(eventType: string, resource: Record<string, unknown>): WebhookEffect {
  const effect = interpretWebhookEvent(event(eventType, resource));
  expect(effect.kind).not.toBe("ignored");
  return effect;
}

/** Applies an effect and checks the invariants every application must keep. */
function apply(before: PaymentRecord, effect: WebhookEffect): WebhookApplication {
  const snapshot = structuredClone(before);
  const result = applyWebhookEffect(before, effect, LATER);
  expect(before).toEqual(snapshot);
  if (result.payment.status !== before.status) expect(canPaymentTransition(before.status, result.payment.status)).toBe(true);
  expect(result.changed).toBe(result.payment !== before);
  if (!result.changed) expect(result.payment).toBe(before);
  for (const audit of result.events) {
    expect(AuditInputSchema.safeParse(audit).success).toBe(true);
    expect(audit.actor).toBe("paypal");
    expect(audit.data).toMatchObject({ eventId: effect.eventId, eventType: effect.eventType });
  }
  return result;
}

const types = (result: WebhookApplication) => result.events.map((audit) => audit.type);

const approved = () =>
  effectOf("CHECKOUT.ORDER.APPROVED", { id: ORDER_ID, purchase_units: [{ amount: AMOUNT, custom_id: CUSTOM_ID }] });
const authorizationCreated = () => effectOf("PAYMENT.AUTHORIZATION.CREATED", authorizationResource);
const authorizationVoided = () => effectOf("PAYMENT.AUTHORIZATION.VOIDED", authorizationResource);
const captureCompleted = (resource: Record<string, unknown> = captureResource) => effectOf("PAYMENT.CAPTURE.COMPLETED", resource);
const capturePending = () => effectOf("PAYMENT.CAPTURE.PENDING", captureResource);
const captureDenied = () => effectOf("PAYMENT.CAPTURE.DENIED", captureResource);
const captureRefunded = () =>
  effectOf("PAYMENT.CAPTURE.REFUNDED", {
    id: "1JU08902781691411",
    amount: { currency_code: "USD", value: "45.00" },
    links: [{ href: `${API}/v2/payments/captures/${CAPTURE_ID}`, rel: "up" }],
  });

describe("storedWebhookPayload", () => {
  it("keeps what interpretation reads and drops the payer's identity", () => {
    const stored = storedWebhookPayload(
      event("CHECKOUT.ORDER.APPROVED", {
        id: ORDER_ID,
        status: "APPROVED",
        intent: "AUTHORIZE",
        payer: { name: { given_name: "John", surname: "Doe" }, email_address: "sb-buyer4711@personal.example.com", payer_id: "QYR5Z8XDVJNXQ" },
        payment_source: { paypal: { email_address: "sb-buyer4711@personal.example.com" } },
        purchase_units: [{ amount: AMOUNT, custom_id: CUSTOM_ID, invoice_id: "ctr_webhook000001", shipping: { name: { full_name: "John Doe" } } }],
        links: [{ rel: "self", href: `${API}/v2/checkout/orders/${ORDER_ID}`, method: "GET" }],
      }),
    );
    expect(JSON.stringify(stored)).not.toMatch(/payer|email_address|John|Doe|QYR5Z8XDVJNXQ|@/);
    expect(stored).toEqual({
      id: "WH-CHECKOUT.ORDER.APPROVED",
      event_type: "CHECKOUT.ORDER.APPROVED",
      resource_type: "test",
      create_time: "2026-10-06T11:59:55.000Z",
      resource: {
        id: ORDER_ID,
        status: "APPROVED",
        purchase_units: [{ amount: AMOUNT, custom_id: CUSTOM_ID, invoice_id: "ctr_webhook000001" }],
        links: [{ rel: "self", href: `${API}/v2/checkout/orders/${ORDER_ID}` }],
      },
    });
    // The projection is enough to interpret the event again.
    expect(interpretWebhookEvent(stored)).toMatchObject({ kind: "approved", orderId: ORDER_ID, amountMinor: 9000, customId: CUSTOM_ID });
  });

  it("stores nothing of a body that is not an event", () => {
    expect(storedWebhookPayload("not an object")).toEqual({});
    expect(storedWebhookPayload({ id: "WH-1", event_type: "X", resource: "a string" })).toMatchObject({ id: "WH-1", resource: null });
  });
});

describe("applyWebhookEffect", () => {
  it("ignores an ignored effect", () => {
    const record = payment("authorized");
    expect(apply(record, interpretWebhookEvent(event("SOMETHING.ELSE", captureResource)))).toEqual({ payment: record, events: [], changed: false });
  });

  describe("CHECKOUT.ORDER.APPROVED", () => {
    it("advances a created payment to approved", () => {
      const result = apply(payment("created"), approved());
      expect(result.payment).toMatchObject({ status: "approved", updatedAt: LATER.toISOString() });
      expect(types(result)).toEqual(["payment.webhook", "payment.approved"]);
      expect(result.events[1].data).toMatchObject({ source: "webhook", statusBefore: "created", statusAfter: "approved" });
    });

    it("is old news once the payment has moved on", () => {
      for (const status of ["approved", "authorized", "captured", "voided"] as const) {
        expect(apply(payment(status), approved())).toMatchObject({ changed: false, events: [] });
      }
    });

    it("does not advance when the approved amount differs from the contract price", () => {
      const result = apply(payment("created", { amountMinor: 8000 }), approved());
      expect(result.changed).toBe(false);
      expect(result.events[0]).toMatchObject({ type: "payment.webhook", title: expect.stringContaining("not applied") as string });
      expect(result.events[0].data).toMatchObject({ mismatch: true, paymentStatus: "created" });
    });
  });

  describe("PAYMENT.AUTHORIZATION.CREATED", () => {
    it("confirms an authorization the orchestrator already recorded", () => {
      const result = apply(payment("authorized"), authorizationCreated());
      expect(result.payment).toMatchObject({ status: "authorized", webhookConfirmed: { authorized: true, captured: false, voided: false } });
      expect(types(result)).toEqual(["payment.webhook"]);
      expect(result.events[0].data).toMatchObject({ confirmed: "authorized" });
    });

    it("is idempotent: a redelivered confirmation changes nothing and says nothing", () => {
      const once = apply(payment("authorized"), authorizationCreated()).payment;
      expect(apply(once, authorizationCreated())).toEqual({ payment: once, events: [], changed: false });
    });

    it("advances an approved payment whose authorize result was never recorded", () => {
      const result = apply(payment("approved", { approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=x" }), authorizationCreated());
      expect(result.payment).toMatchObject({
        status: "authorized",
        authorizationId: AUTHORIZATION_ID,
        authorizedMinor: 9000,
        approveUrl: null,
        webhookConfirmed: { authorized: true },
      });
      expect(types(result)).toEqual(["payment.webhook", "payment.authorized"]);
      expect(result.events[1].title).toBe("PayPal authorized $90.00 — the funds are held, not captured");
    });

    it("records when the hold lapses, so a webhook-adopted authorization has an expiry like any other", () => {
      const result = apply(payment("created"), authorizationCreated());
      expect(result.payment).toMatchObject({ status: "authorized", authorizationExpiresAt: "2026-11-04T12:00:00.000Z" });
    });

    it("does not record a hold for an authorization that is still under review", () => {
      const pending = effectOf("PAYMENT.AUTHORIZATION.CREATED", { ...authorizationResource, status: "PENDING" });
      for (const status of ["created", "approved"] as const) {
        const result = apply(payment(status), pending);
        expect(result).toMatchObject({ changed: false, payment: { status, authorizationId: null, authorizedMinor: 0 } });
        expect(types(result)).toEqual(["payment.webhook"]);
        expect(result.events[0].title).toContain("no funds are held yet");
        expect(result.events[0].data).not.toHaveProperty("mismatch");
      }
    });

    it("does not record a hold for an authorization PayPal denied or voided", () => {
      for (const status of ["DENIED", "VOIDED"]) {
        const result = apply(payment("approved"), effectOf("PAYMENT.AUTHORIZATION.CREATED", { ...authorizationResource, status }));
        expect(result).toMatchObject({ changed: false, payment: { status: "approved", authorizationId: null } });
        expect(result.events[0].data).toMatchObject({ mismatch: true });
      }
    });

    it("treats a payload without a status as the held authorization it has always described", () => {
      const withoutStatus: Record<string, unknown> = { ...authorizationResource };
      delete withoutStatus.status;
      expect(apply(payment("approved"), effectOf("PAYMENT.AUTHORIZATION.CREATED", withoutStatus)).payment.status).toBe("authorized");
    });

    it("adopts the authorization of an order PACT holds no id for, but only when the caller vouches for the contract binding", () => {
      const reservation = payment("none");
      const unbound = apply(reservation, authorizationCreated());
      expect(unbound).toMatchObject({ changed: false, payment: { status: "none" } });

      const result = applyWebhookEffect(reservation, authorizationCreated(), LATER, { boundToContract: true });
      expect(result.payment).toMatchObject({ status: "authorized", orderId: ORDER_ID, authorizationId: AUTHORIZATION_ID, authorizedMinor: 9000 });
      // Ids that disagree are never overridden by the binding.
      const other = payment("created", { orderId: "SOME-OTHER-ORDER" });
      expect(applyWebhookEffect(other, authorizationCreated(), LATER, { boundToContract: true })).toMatchObject({ changed: false });
    });

    it("does not advance when the authorized amount differs from the contract price", () => {
      const result = apply(payment("approved", { amountMinor: 12_000 }), authorizationCreated());
      expect(result).toMatchObject({ changed: false, payment: { status: "approved", authorizationId: null } });
      expect(result.events[0].data).toMatchObject({ mismatch: true });
    });

    it("still records the confirmation on a payment that has since been captured", () => {
      const result = apply(payment("captured"), authorizationCreated());
      expect(result.payment).toMatchObject({ status: "captured", webhookConfirmed: { authorized: true } });
    });
  });

  describe("PAYMENT.CAPTURE.COMPLETED", () => {
    it("confirms a capture the orchestrator already recorded", () => {
      const result = apply(payment("captured"), captureCompleted());
      expect(result.payment).toMatchObject({ status: "captured", capturedMinor: 9000, webhookConfirmed: { captured: true } });
      expect(types(result)).toEqual(["payment.webhook"]);
      expect(apply(result.payment, captureCompleted())).toMatchObject({ changed: false, events: [] });
    });

    it("advances an authorized payment whose ids match (a pending capture that completed)", () => {
      const pending = payment("authorized", {
        captureId: CAPTURE_ID,
        lastError: { issue: "CAPTURE_PENDING", message: "pending", debugId: null, at: new Date(NOW).toISOString() },
      });
      const result = apply(pending, captureCompleted());
      expect(result.payment).toMatchObject({
        status: "captured",
        captureId: CAPTURE_ID,
        capturedMinor: 9000,
        lastError: null,
        webhookConfirmed: { captured: true },
      });
      expect(types(result)).toEqual(["payment.webhook", "payment.captured"]);
      expect(result.events[1].title).toBe("PayPal captured $90.00 — the seller is paid");
    });

    it("records a partial capture for exactly the amount PayPal reports", () => {
      const partial = captureCompleted({ ...captureResource, amount: { currency_code: "USD", value: "45.00" } });
      expect(apply(payment("authorized"), partial).payment).toMatchObject({ status: "captured", capturedMinor: 4500, authorizedMinor: 9000 });
    });

    it("supplies the capture id for a capture that was adopted without one", () => {
      const adopted = payment("captured", { captureId: null });
      const result = apply(adopted, captureCompleted());
      expect(result.payment).toMatchObject({ captureId: CAPTURE_ID, webhookConfirmed: { captured: true } });
    });

    it("refuses a capture for a different authorization or capture id", () => {
      const otherAuthorization = captureCompleted({
        ...captureResource,
        supplementary_data: { related_ids: { order_id: ORDER_ID, authorization_id: "0AW9999999999999X" } },
      });
      const result = apply(payment("authorized"), otherAuthorization);
      expect(result).toMatchObject({ changed: false, payment: { status: "authorized", capturedMinor: 0 } });
      expect(types(result)).toEqual(["payment.webhook"]);
      expect(result.events[0].title).toContain("names different PayPal ids");

      const otherCapture = captureCompleted({ ...captureResource, id: "9ZZ99999999999999" });
      expect(apply(payment("captured"), otherCapture)).toMatchObject({ changed: false, payment: { webhookConfirmed: { captured: false } } });
    });

    it("refuses a capture that references none of this payment's ids", () => {
      const unrelated = captureCompleted({ id: "9ZZ99999999999999", amount: AMOUNT });
      const result = apply(payment("authorized"), unrelated);
      expect(result.changed).toBe(false);
      expect(result.events[0].title).toContain("does not reference this payment");
    });

    it.each([
      ["more than was authorized", "90.01"],
      ["zero", "0.00"],
    ])("refuses a captured amount that is %s", (_label, value) => {
      const result = apply(payment("authorized"), captureCompleted({ ...captureResource, amount: { currency_code: "USD", value } }));
      expect(result).toMatchObject({ changed: false, payment: { status: "authorized", capturedMinor: 0 } });
      expect(result.events[0].data).toMatchObject({ mismatch: true });
    });

    it("refuses a capture whose amount cannot be read", () => {
      const result = apply(payment("authorized"), captureCompleted({ ...captureResource, amount: { currency_code: "EUR", value: "90.00" } }));
      expect(result.changed).toBe(false);
    });

    it("refuses to confirm a capture whose amount differs from the recorded one", () => {
      const result = apply(payment("captured", { capturedMinor: 4500 }), captureCompleted());
      expect(result).toMatchObject({ changed: false, payment: { capturedMinor: 4500, webhookConfirmed: { captured: false } } });
      expect(result.events[0].title).toContain("differs from the amount on record");
    });

    it.each(["voided", "expired", "failed", "approved", "created"] as const)("never turns a %s payment into a captured one", (status) => {
      const before = payment(status, status === "failed" ? { authorizationId: AUTHORIZATION_ID, authorizedMinor: 9000 } : {});
      const result = apply(before, captureCompleted());
      expect(result).toMatchObject({ changed: false, payment: { status, capturedMinor: 0 } });
      // The contradiction is loud: money may have moved for a payment PACT considers closed.
      expect(result.events[0].title).toContain(`PACT records the payment as ${status}`);
    });
  });

  describe("PAYMENT.CAPTURE.PENDING / DENIED", () => {
    it("notes a pending capture without changing the authorized payment", () => {
      const result = apply(payment("authorized"), capturePending());
      expect(result).toMatchObject({ changed: false, payment: { status: "authorized" } });
      expect(types(result)).toEqual(["payment.webhook"]);
      expect(apply(payment("captured"), capturePending())).toMatchObject({ changed: false, events: [] });
    });

    it("fails an authorized payment whose capture PayPal denied", () => {
      const result = apply(payment("authorized", { captureId: CAPTURE_ID }), captureDenied());
      expect(result.payment).toMatchObject({ status: "failed", capturedMinor: 0, lastError: { issue: "CAPTURE_DENIED", at: LATER.toISOString() } });
      expect(types(result)).toEqual(["payment.webhook", "payment.failed"]);
    });

    it("never regresses a captured payment on a denial; it flags the contradiction", () => {
      const result = apply(payment("captured"), captureDenied());
      expect(result).toMatchObject({ changed: false, payment: { status: "captured", capturedMinor: 9000 } });
      expect(result.events[0].data).toMatchObject({ mismatch: true });
    });

    it("has nothing to say about a denial on a payment that is already closed", () => {
      for (const status of ["voided", "expired"] as const) {
        expect(apply(payment(status), captureDenied())).toMatchObject({ changed: false, events: [] });
      }
    });
  });

  describe("PAYMENT.AUTHORIZATION.VOIDED", () => {
    it("confirms a void the orchestrator already recorded", () => {
      const result = apply(payment("voided"), authorizationVoided());
      expect(result.payment).toMatchObject({ status: "voided", webhookConfirmed: { voided: true } });
      expect(types(result)).toEqual(["payment.webhook"]);
      expect(apply(result.payment, authorizationVoided())).toMatchObject({ changed: false, events: [] });
    });

    it("marks an authorized payment voided when PayPal released the hold before its expiry", () => {
      const result = apply(payment("authorized"), authorizationVoided());
      expect(result.payment).toMatchObject({ status: "voided", capturedMinor: 0, webhookConfirmed: { voided: true } });
      expect(types(result)).toEqual(["payment.webhook", "payment.voided"]);
      expect(result.events[1].title).toBe("Authorization voided at PayPal — $90.00 released back to the payer");
    });

    it("marks an authorized payment expired when the authorization had run out of time", () => {
      const lapsed = payment("authorized", { authorizationExpiresAt: "2026-10-06T12:00:00.000Z" });
      const result = apply(lapsed, authorizationVoided());
      expect(result.payment).toMatchObject({ status: "expired", webhookConfirmed: { voided: true } });
      expect(types(result)).toEqual(["payment.webhook", "payment.expired"]);
    });

    it("never regresses a fully captured payment; it flags the contradiction", () => {
      const result = apply(payment("captured"), authorizationVoided());
      expect(result).toMatchObject({ changed: false, payment: { status: "captured", capturedMinor: 9000, webhookConfirmed: { voided: false } } });
      expect(result.events[0].title).toContain("fully captured");
    });

    it("accepts the release of the remainder after a partial capture as nothing new", () => {
      expect(apply(payment("captured", { capturedMinor: 4500 }), authorizationVoided())).toMatchObject({ changed: false, events: [] });
    });

    it("confirms the release for an expired payment", () => {
      expect(apply(payment("expired"), authorizationVoided()).payment).toMatchObject({ status: "expired", webhookConfirmed: { voided: true } });
    });
  });

  describe("PAYMENT.CAPTURE.REFUNDED / REVERSED", () => {
    it("makes a refund visible without changing the captured payment", () => {
      const result = apply(payment("captured"), captureRefunded());
      expect(result).toMatchObject({ changed: false, payment: { status: "captured", capturedMinor: 9000 } });
      expect(types(result)).toEqual(["payment.webhook"]);
      expect(result.events[0].title).toBe("PayPal webhook: $45.00 of the captured payment was refunded or reversed");
    });

    it("flags a refund for a payment PACT does not record as captured", () => {
      const result = apply(payment("authorized", { captureId: CAPTURE_ID }), captureRefunded());
      expect(result.changed).toBe(false);
      expect(result.events[0].data).toMatchObject({ mismatch: true });
    });
  });

  it("never moves a settled payment to another status, whatever the event", () => {
    const effects = [approved(), authorizationCreated(), authorizationVoided(), captureCompleted(), capturePending(), captureDenied(), captureRefunded()];
    for (const status of ["captured", "voided", "expired", "failed"] as const) {
      for (const effect of effects) {
        const before = payment(status, status === "failed" ? { authorizationId: AUTHORIZATION_ID, authorizedMinor: 9000 } : {});
        expect(apply(before, effect).payment.status).toBe(status);
      }
    }
  });

  it("never applies any event to a payment that has no PayPal ids yet", () => {
    for (const effect of [approved(), authorizationCreated(), captureCompleted(), authorizationVoided()]) {
      const result = apply(payment("none"), effect);
      expect(result).toMatchObject({ changed: false, payment: { status: "none" } });
      expect(result.events[0].data).toMatchObject({ mismatch: true });
    }
  });
});
