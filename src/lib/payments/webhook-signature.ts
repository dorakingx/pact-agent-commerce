/**
 * Local verification of PayPal webhook signatures (PayPal's preferred method).
 *
 * PayPal signs `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(rawBody)}` with
 * RSA-SHA256 and names the signing certificate in the `paypal-cert-url` header. Two things are
 * not in PayPal's sample and are added here because the header is attacker-controlled:
 *  - the certificate is only ever fetched from a paypal.com host over https, otherwise anyone
 *    could sign an event with their own key and point the header at their own certificate;
 *  - transmissions outside a time window are refused, so a captured event cannot be replayed later.
 */
import { createPublicKey, createVerify, type KeyObject } from "node:crypto";
import { crc32 } from "node:zlib";

/** PayPal retries failed deliveries for days, but each event only needs to be accepted once. */
export const MAX_TRANSMISSION_AGE_MS = 6 * 60 * 60 * 1000;
/** Tolerated clock skew between PayPal and this server. */
export const MAX_TRANSMISSION_SKEW_MS = 10 * 60 * 1000;
/** The only algorithm PayPal uses; anything else cannot be verified locally. */
export const SUPPORTED_AUTH_ALGO = "SHA256withRSA";

const MAX_CACHED_CERTIFICATES = 8;
/** How long a certificate URL that could not be loaded is left alone. */
const FAILED_FETCH_TTL_MS = 5 * 60 * 1000;
/** Bounded like the key cache: the URL is attacker-chosen, so the list of failures must not grow with the attack. */
const MAX_REMEMBERED_FAILURES = 256;

export interface WebhookSignatureHeaders {
  transmissionId: string;
  transmissionTime: string;
  /** Base64 RSA signature. */
  signature: string;
  certUrl: string;
  authAlgo: string | null;
}

/** Returns null when any header needed to check the signature is missing. */
export function readSignatureHeaders(headers: Headers): WebhookSignatureHeaders | null {
  const transmissionId = headers.get("paypal-transmission-id");
  const transmissionTime = headers.get("paypal-transmission-time");
  const signature = headers.get("paypal-transmission-sig");
  const certUrl = headers.get("paypal-cert-url");
  if (!transmissionId || !transmissionTime || !signature || !certUrl) return null;
  return { transmissionId, transmissionTime, signature, certUrl, authAlgo: headers.get("paypal-auth-algo") };
}

/** True only for https URLs on paypal.com or one of its subdomains, on the default port. */
export function isTrustedCertUrl(certUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(certUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return false;
  return url.hostname === "paypal.com" || url.hostname.endsWith(".paypal.com");
}

export type TransmissionTimeProblem = "invalid_transmission_time" | "stale_transmission" | "transmission_from_future";

/** Replay window check on the (signed) transmission time. */
export function transmissionTimeProblem(transmissionTime: string, nowMs: number): TransmissionTimeProblem | null {
  const sentAtMs = Date.parse(transmissionTime);
  if (Number.isNaN(sentAtMs)) return "invalid_transmission_time";
  if (nowMs - sentAtMs > MAX_TRANSMISSION_AGE_MS) return "stale_transmission";
  if (sentAtMs - nowMs > MAX_TRANSMISSION_SKEW_MS) return "transmission_from_future";
  return null;
}

/** The exact string PayPal signs. The CRC is over the raw bytes, rendered as an unsigned decimal. */
export function signedMessage(headers: WebhookSignatureHeaders, webhookId: string, rawBody: string): string {
  const checksum = crc32(Buffer.from(rawBody, "utf8")) >>> 0;
  return `${headers.transmissionId}|${headers.transmissionTime}|${webhookId}|${checksum}`;
}

export function verifySignature(key: KeyObject, message: string, signatureBase64: string): boolean {
  try {
    return createVerify("SHA256").update(message, "utf8").verify(key, signatureBase64, "base64");
  } catch {
    // A key of the wrong type or a malformed signature is simply "not verified".
    return false;
  }
}

export interface CertificateFetchOptions {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  /** Epoch milliseconds; defaults to the wall clock. */
  now?: () => number;
}

function evictOldest<K, V>(map: Map<K, V>): void {
  const oldest = map.keys().next();
  if (!oldest.done) map.delete(oldest.value);
}

/**
 * In-memory cache of PayPal's signing keys, keyed by certificate URL. PayPal rotates the
 * certificate rarely and under a new URL, so entries never need to be refreshed — only bounded.
 *
 * A URL that could not be loaded is remembered too, for a few minutes: the header that names it
 * is attacker-controlled, and without that memory every forged delivery naming the same dead URL
 * would cost another outbound request.
 */
export class CertificateCache {
  private readonly keys = new Map<string, KeyObject>();
  /** Certificate URL → epoch ms until which it is not fetched again. */
  private readonly failures = new Map<string, number>();

  constructor(private readonly options: CertificateFetchOptions) {}

  /**
   * Public key of the certificate at `certUrl`, or null when it cannot be fetched or parsed
   * (the caller then falls back to PayPal's postback verification).
   * The caller must have checked `isTrustedCertUrl` first. `mayFetch` is asked before a request
   * is made; a cached key costs nothing and is returned without asking.
   */
  async load(certUrl: string, mayFetch: () => Promise<boolean> = async () => true): Promise<KeyObject | null> {
    const cached = this.keys.get(certUrl);
    if (cached) return cached;
    const now = (this.options.now ?? Date.now)();
    const retryAt = this.failures.get(certUrl);
    if (retryAt !== undefined) {
      if (now < retryAt) return null;
      this.failures.delete(certUrl);
    }
    if (!(await mayFetch())) return null;
    const key = await this.fetchKey(certUrl);
    if (key === null) {
      if (this.failures.size >= MAX_REMEMBERED_FAILURES) evictOldest(this.failures);
      this.failures.set(certUrl, now + FAILED_FETCH_TTL_MS);
      return null;
    }
    if (this.keys.size >= MAX_CACHED_CERTIFICATES) evictOldest(this.keys);
    this.keys.set(certUrl, key);
    return key;
  }

  private async fetchKey(certUrl: string): Promise<KeyObject | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.options.fetchImpl(certUrl, {
        method: "GET",
        // A redirect could leave paypal.com after the host check has already passed.
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) return null;
      // Accepts an X.509 certificate (what PayPal serves; the first one of a chain) or a bare public key.
      return createPublicKey(await response.text());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
