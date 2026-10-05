/**
 * GET    /api/wallet                    — delegated wallet status (never the vault id).
 * DELETE /api/wallet?scope=session|demo — disconnect the session's wallet, or — with the
 *                                         operator token — the shared demo wallet.
 */
import { z } from "zod";
import { getServiceContext } from "@/lib/services/context";
import { clientKey, json, route } from "@/lib/services/http";
import { enforceRateLimit, rateLimitKey } from "@/lib/services/rate-limit";
import { readSession } from "@/lib/services/session";
import {
  ADMIN_TOKEN_HEADER,
  OPERATOR_ATTEMPT_LIMIT,
  WALLET_SCOPES,
  disconnectWallet,
  getWalletStatus,
  resolveWalletOwner,
} from "@/lib/services/wallet";

export const maxDuration = 60;

const ScopeSchema = z.enum(WALLET_SCOPES);

export const GET = route("wallet.status", async () => {
  const sessionId = await readSession();
  return json(await getWalletStatus(await getServiceContext(), sessionId));
});

export const DELETE = route("wallet.disconnect", async (request) => {
  const scope = ScopeSchema.parse(new URL(request.url).searchParams.get("scope"));
  const ctx = await getServiceContext();
  const sessionId = await readSession();
  if (scope === "demo") {
    // Guessing the operator token is throttled per network address: a new session is free, an address is not.
    const { scope: rule, limit, windowSeconds } = OPERATOR_ATTEMPT_LIMIT;
    await enforceRateLimit(ctx, rateLimitKey(rule, clientKey(request) ?? "unknown"), limit, windowSeconds);
  }
  const owner = resolveWalletOwner({ scope, sessionId, adminToken: request.headers.get(ADMIN_TOKEN_HEADER) });
  // No session means no wallet of one's own: disconnecting it is already done.
  if (owner !== null) await disconnectWallet(ctx, owner);
  return json(await getWalletStatus(ctx, sessionId));
});
