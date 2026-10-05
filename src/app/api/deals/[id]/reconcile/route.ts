/**
 * POST /api/deals/{id}/reconcile — re-read PayPal's record of the deal and compare it with
 * PACT's ledger. Changes no payment and no status; the deal's owner additionally gets a
 * `payment.reconciled` entry in the audit trail. POST because it costs PayPal (and possibly
 * model) calls and may write that entry.
 *
 * The body is an empty JSON object: there is nothing for the caller to say — which order is
 * read and what it is compared with come from the stored deal.
 */
import { z } from "zod";
import { reconcileWithPayPal } from "@/lib/services/auditor";
import { getServiceContext } from "@/lib/services/context";
import { clientKey, json, readJson, route } from "@/lib/services/http";
import { readSession } from "@/lib/services/session";

/** The auditor agent has 20 s; PayPal reads and the database need the rest. */
export const maxDuration = 60;

/** Requiring a JSON body keeps plain HTML forms (which cannot send one cross-site) away from this endpoint. */
const ReconcileBody = z.object({});
const MAX_BODY_BYTES = 1024;

export const POST = route<RouteContext<"/api/deals/[id]/reconcile">>("deals.reconcile", async (request, context) => {
  const { id } = await context.params;
  await readJson(request, ReconcileBody, MAX_BODY_BYTES);
  const sessionId = await readSession();
  const view = await reconcileWithPayPal(await getServiceContext(), sessionId, id, { clientKey: clientKey(request) });
  return json(view);
});
