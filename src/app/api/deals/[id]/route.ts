/**
 * GET /api/deals/{id} — the deal as the caller may see it.
 *
 * Reading needs no session: ids are unguessable, a view carries no secret, and showcase deals
 * are public by design. The buyer's private mandate is included only for the owning session
 * (`isOwner`), and nothing can be changed from here.
 */
import type { DealResponse } from "@/lib/api/dto";
import { getServiceContext } from "@/lib/services/context";
import { getDealView } from "@/lib/services/deals";
import { json, route } from "@/lib/services/http";
import { readSession } from "@/lib/services/session";

export const maxDuration = 60;

export const GET = route<RouteContext<"/api/deals/[id]">>("deals.get", async (_request, context) => {
  const { id } = await context.params;
  const deal = await getDealView(await getServiceContext(), await readSession(), id);
  return json({ deal } satisfies DealResponse);
});
