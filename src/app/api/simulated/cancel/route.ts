/**
 * POST /api/simulated/cancel { orderId } — the simulated payer backs out. The simulator voids the
 * order (it can never be approved afterwards), so the deal is cancelled with it, recorded as
 * the owner's own decision.
 *
 * Exists only while the simulator stands in for PayPal: with real PayPal active this endpoint
 * answers 404. Owner only.
 */
import { z } from "zod";
import { getServiceContext } from "@/lib/services/context";
import { cancelSimulatedOrder } from "@/lib/services/deals";
import { notFound } from "@/lib/services/errors";
import { json, readJson, route } from "@/lib/services/http";
import { readSession } from "@/lib/services/session";

export const maxDuration = 60;

const CancelBody = z.object({ orderId: z.string().min(1).max(64) });
const MAX_BODY_BYTES = 1024;

export const POST = route("simulated.cancel", async (request) => {
  const ctx = await getServiceContext();
  // Checked before the body is even read: with real PayPal there is nothing here to talk to.
  if (ctx.provider.kind !== "simulated") throw notFound();
  const { orderId } = await readJson(request, CancelBody, MAX_BODY_BYTES);
  return json(await cancelSimulatedOrder(ctx, await readSession(), orderId));
});
