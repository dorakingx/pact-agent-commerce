/**
 * POST /api/deals/{id}/advance — execute at most ONE automatic step of the deal.
 *
 * Owner only, and never creates a session. The body is an empty JSON object: the caller cannot
 * say which step runs or with what — the deal's stored status decides. Answers 200 with
 * `busy: true` when another request is already running a step for this deal.
 */
import { z } from "zod";
import type { AdvanceResponse } from "@/lib/api/dto";
import { getAppUrl } from "@/lib/config";
import { getServiceContext } from "@/lib/services/context";
import { advanceDeal, requireOwner } from "@/lib/services/deals";
import { json, readJson, requestOrigin, route } from "@/lib/services/http";
import { readSession } from "@/lib/services/session";

/** One step is one model call (40 s at most, for verification) or one PayPal call, plus database work. */
export const maxDuration = 60;

/** Requiring a JSON body keeps plain HTML forms (which cannot send one cross-site) away from this endpoint. */
const AdvanceBody = z.object({});
const MAX_BODY_BYTES = 1024;

export const POST = route<RouteContext<"/api/deals/[id]/advance">>("deals.advance", async (request, context) => {
  const { id } = await context.params;
  await readJson(request, AdvanceBody, MAX_BODY_BYTES);
  const ctx = await getServiceContext();
  const sessionId = await requireOwner(ctx, await readSession(), id);
  const result = await advanceDeal(ctx, sessionId, id, getAppUrl(requestOrigin(request)));
  return json(result satisfies AdvanceResponse);
});
