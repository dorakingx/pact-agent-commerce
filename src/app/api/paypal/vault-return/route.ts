/**
 * GET /api/paypal/vault-return?scope=session|demo
 *
 * Where PayPal sends the payer after the wallet consent. Nothing in the URL is trusted: the
 * setup token to exchange is the one stored for the pending connection, and for the shared
 * demo wallet the returning browser must be the operator session that started it. Always
 * answers with a redirect back to the policies page — a browser is waiting, not an API client.
 */
import { z } from "zod";
import { log } from "@/lib/observability/logger";
import { getServiceContext } from "@/lib/services/context";
import { route } from "@/lib/services/http";
import { readSession } from "@/lib/services/session";
import { WALLET_SCOPES, completeWalletConnect, resolveReturningOwner } from "@/lib/services/wallet";

export const maxDuration = 60;

const ScopeSchema = z.enum(WALLET_SCOPES);

/** A relative Location keeps the browser on the host it is on, whatever the request headers claim. */
function backToPolicies(outcome: "connected" | "error"): Response {
  return new Response(null, { status: 303, headers: { Location: `/policies?wallet=${outcome}`, "Cache-Control": "no-store" } });
}

export const GET = route("paypal.vault_return", async (request, _context, { requestId }) => {
  const scope = ScopeSchema.safeParse(new URL(request.url).searchParams.get("scope"));
  if (!scope.success) return backToPolicies("error");
  try {
    const sessionId = await readSession();
    const owner = resolveReturningOwner(scope.data, sessionId);
    if (owner === null) return backToPolicies("error");
    const result = await completeWalletConnect(await getServiceContext(), { owner, sessionId });
    return backToPolicies(result.connected ? "connected" : "error");
  } catch (error) {
    log.error("wallet.return_failed", { requestId, scope: scope.data, error });
    return backToPolicies("error");
  }
});
