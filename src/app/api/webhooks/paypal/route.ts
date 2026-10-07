/**
 * POST /api/webhooks/paypal — PayPal's event notifications.
 *
 * Not same-origin by nature, and not authenticated by a session: the only thing that counts is
 * PayPal's signature over the exact bytes of the body, which is why the body is read as raw
 * text and handed over untouched. An event that does not verify changes nothing and gets a bare
 * 400 — no detail for whoever is probing the endpoint.
 *
 *   200 { received: true }  the event was verified and applied, or needs no action
 *   400 (empty)             not verified, not a usable event, or too large
 *   503 (empty)             the deal is in the middle of a step; PayPal redelivers the event
 */
import { getServiceContext } from "@/lib/services/context";
import { handlePayPalWebhook } from "@/lib/services/deals";
import { json, readBodyText, route } from "@/lib/services/http";

export const maxDuration = 60;

/** PayPal's events are a few kilobytes. Anything near this size is not one of them. */
const MAX_BODY_BYTES = 256 * 1024;
const RETRY_AFTER_SECONDS = "5";

function refuse(status: 400 | 503, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export const POST = route(
  "webhooks.paypal",
  async (request) => {
    // Read with the limit applied to the stream itself: this endpoint is open to anyone.
    const rawBody = await readBodyText(request, MAX_BODY_BYTES);
    if (rawBody === null) return refuse(400);
    const outcome = await handlePayPalWebhook(await getServiceContext(), request.headers, rawBody);
    if (outcome.accepted) return json({ received: true });
    // Only a non-2xx answer makes PayPal deliver the event again once the running step has finished.
    return outcome.reason === "busy" ? refuse(503, { "Retry-After": RETRY_AFTER_SECONDS }) : refuse(400);
  },
  { crossOrigin: true },
);
