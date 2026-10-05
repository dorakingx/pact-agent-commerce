/**
 * POST /api/simulated/approve { orderId } — the simulated payer approves an order, and PACT then
 * authorizes it exactly as after a real PayPal return.
 *
 * Exists only while the simulator stands in for PayPal (no credentials configured): with real
 * PayPal active this endpoint answers 404. Approving is the payer's act, so it takes the
 * session that owns the deal.
 */
import { z } from "zod";
import { getServiceContext } from "@/lib/services/context";
import { approveSimulatedOrder } from "@/lib/services/deals";
import { notFound } from "@/lib/services/errors";
import { json, readJson, route } from "@/lib/services/http";
import { readSession } from "@/lib/services/session";

export const maxDuration = 60;

const ApproveBody = z.object({ orderId: z.string().min(1).max(64) });
const MAX_BODY_BYTES = 1024;

export const POST = route("simulated.approve", async (request) => {
  const ctx = await getServiceContext();
  // Checked before the body is even read: with real PayPal there is nothing here to talk to.
  if (ctx.provider.kind !== "simulated") throw notFound();
  const { orderId } = await readJson(request, ApproveBody, MAX_BODY_BYTES);
  return json(await approveSimulatedOrder(ctx, await readSession(), orderId));
});
