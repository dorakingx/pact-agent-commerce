/**
 * GET /api/paypal/cancel?deal=<id>
 *
 * Where PayPal sends a payer who backed out of the approval page. Nothing changes: the order
 * still exists at PayPal and can be approved later, so the deal keeps waiting for payment.
 * Cancelling the deal itself is the owner's explicit decision on the deal page.
 *
 * Deliberately writes nothing — not even an audit note: this is an unauthenticated GET, and
 * "the payer looked and left" is not a fact PACT can verify.
 */
import { log } from "@/lib/observability/logger";
import { isDealId, payPalReturnPath } from "@/lib/services/deals";
import { route } from "@/lib/services/http";

export const maxDuration = 60;

export const GET = route("paypal.cancel", async (request, _context, { requestId }) => {
  const dealId = new URL(request.url).searchParams.get("deal");
  const known = dealId !== null && isDealId(dealId) ? dealId : null;
  log.info("paypal.cancel_return", { requestId, dealId: known });
  // A relative Location keeps the browser on the host it is on, whatever the request headers claim.
  return new Response(null, {
    status: 303,
    headers: { Location: payPalReturnPath(known, "cancelled"), "Cache-Control": "no-store" },
  });
});
