/**
 * GET /api/paypal/return?deal=<id>&token=<orderId>
 *
 * Where PayPal sends the payer after the approval page. Nothing in this URL is trusted: the
 * order to authorize is the one stored for the deal (a different `token` is refused), and the
 * orchestrator re-reads that order from PayPal — status, amount, contract hash — before it
 * authorizes. A forged or premature return therefore achieves nothing.
 *
 * Always answers with a redirect to the deal's own page on this site: a browser is waiting,
 * not an API client, and the target is never taken from the request beyond a validated deal id.
 */
import { assertNever } from "@/lib/domain/format";
import { log } from "@/lib/observability/logger";
import { getServiceContext } from "@/lib/services/context";
import { completePayPalApproval, isDealId, payPalReturnPath, type PayPalReturnResult } from "@/lib/services/deals";
import { route } from "@/lib/services/http";

/** Authorizing is two PayPal calls (read the order, authorize it) plus database work. */
export const maxDuration = 60;

/** PayPal order ids are short alphanumeric strings; anything else is not worth comparing. */
const ORDER_TOKEN = /^[A-Za-z0-9-]{1,64}$/;

/** A relative Location keeps the browser on the host it is on, whatever the request headers claim. */
function seeOther(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: path, "Cache-Control": "no-store" } });
}

async function resultOf(dealId: string, token: string | null): Promise<PayPalReturnResult> {
  // A malformed token cannot be this deal's order.
  if (token !== null && !ORDER_TOKEN.test(token)) return "error";
  const { outcome } = await completePayPalApproval(await getServiceContext(), { dealId, orderId: token });
  switch (outcome) {
    case "authorized":
      return "approved";
    case "pending":
      return "pending";
    case "failed":
      return "error";
    default:
      return assertNever(outcome);
  }
}

export const GET = route("paypal.return", async (request, _context, { requestId }) => {
  const params = new URL(request.url).searchParams;
  const dealId = params.get("deal");
  if (dealId === null || !isDealId(dealId)) return seeOther(payPalReturnPath(null, "error"));
  try {
    return seeOther(payPalReturnPath(dealId, await resultOf(dealId, params.get("token"))));
  } catch (error) {
    log.error("paypal.return_failed", { requestId, dealId, error });
    return seeOther(payPalReturnPath(dealId, "error"));
  }
});
