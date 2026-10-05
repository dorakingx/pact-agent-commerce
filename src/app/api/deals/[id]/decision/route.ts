/**
 * POST /api/deals/{id}/decision — a human's decision at a gate: approve or decline the spend,
 * cancel before paying, release (fully or partly), request a revision, or reject the delivery.
 *
 * Owner only. The body names the decision — never an amount or a status. Whether the decision
 * is available is judged against the deal's stored state (409 otherwise), and a release still
 * has to pass the settlement guard before any money moves.
 */
import { z } from "zod";
import type { DealResponse } from "@/lib/api/dto";
import { HumanDecisionKindSchema } from "@/lib/domain/schemas";
import { getServiceContext } from "@/lib/services/context";
import { decideDeal, requireOwner } from "@/lib/services/deals";
import { json, readJson, route } from "@/lib/services/http";
import { readSession } from "@/lib/services/session";

/** Cancelling before payment asks PayPal whether anything is held; everything else is database work. */
export const maxDuration = 60;

const DecisionBody = z.object({
  kind: HumanDecisionKindSchema,
  percent: z.number().int().min(1).max(99).optional(),
  // Cleaned and cut to 300 characters by the service; this only bounds what is read.
  reason: z.string().max(1000).optional(),
});

export const POST = route<RouteContext<"/api/deals/[id]/decision">>("deals.decision", async (request, context) => {
  const { id } = await context.params;
  const body = await readJson(request, DecisionBody);
  const ctx = await getServiceContext();
  const sessionId = await requireOwner(ctx, await readSession(), id);
  const deal = await decideDeal(ctx, sessionId, id, body);
  return json({ deal } satisfies DealResponse);
});
