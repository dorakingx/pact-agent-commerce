/**
 * POST /api/wallet/connect { scope: "session" | "demo" } → { approveUrl }
 *
 * Starts the one-time PayPal consent for a delegated agent wallet. "session" connects the
 * caller's own wallet; "demo" connects the shared wallet of the public demo and requires the
 * operator token in the x-admin-token header.
 */
import { z } from "zod";
import { getAppUrl } from "@/lib/config";
import { getServiceContext } from "@/lib/services/context";
import { forbidden } from "@/lib/services/errors";
import { clientKey, json, readJson, requestOrigin, route } from "@/lib/services/http";
import { enforceRateLimit, rateLimitKey } from "@/lib/services/rate-limit";
import { ensureSession } from "@/lib/services/session";
import {
  ADMIN_TOKEN_HEADER,
  OPERATOR_ATTEMPT_LIMIT,
  WALLET_CONNECT_LIMIT,
  WALLET_SCOPES,
  resolveWalletOwner,
  startWalletConnect,
} from "@/lib/services/wallet";

export const maxDuration = 60;

const ConnectSchema = z.strictObject({ scope: z.enum(WALLET_SCOPES) });

export const POST = route("wallet.connect", async (request) => {
  const { scope } = await readJson(request, ConnectSchema, 1_024);
  const ctx = await getServiceContext();
  const sessionId = await ensureSession();
  await enforceRateLimit(
    ctx,
    rateLimitKey(WALLET_CONNECT_LIMIT.scope, sessionId),
    WALLET_CONNECT_LIMIT.limit,
    WALLET_CONNECT_LIMIT.windowSeconds,
  );
  if (scope === "demo") {
    // Guessing the operator token is throttled per network address: a new session is free, an address is not.
    const { scope: rule, limit, windowSeconds } = OPERATOR_ATTEMPT_LIMIT;
    await enforceRateLimit(ctx, rateLimitKey(rule, clientKey(request) ?? "unknown"), limit, windowSeconds);
  }
  const owner = resolveWalletOwner({ scope, sessionId, adminToken: request.headers.get(ADMIN_TOKEN_HEADER) });
  if (owner === null) throw forbidden();
  const appUrl = getAppUrl(requestOrigin(request));
  return json(await startWalletConnect(ctx, { owner, appUrl, initiatedBy: sessionId }));
});
