/**
 * POST /api/deals — turn a request in words into a deal. The body carries the words, optionally
 *                   a demo scenario and the browser's UTC offset; anything else is dropped. No
 *                   amount, status or seller can be supplied: they are derived on the server.
 * GET  /api/deals — the calling session's own deals, newest first. Never creates a session.
 */
import { z } from "zod";
import type { CreateDealResponse, DealListResponse } from "@/lib/api/dto";
import { getServiceContext } from "@/lib/services/context";
import { createDeal, listMyDeals } from "@/lib/services/deals";
import { clientKey, json, readJson, route } from "@/lib/services/http";
import { ensureSession, readSession } from "@/lib/services/session";

/** Parsing the request is a model call (25 s at most); the rest is database work. */
export const maxDuration = 60;

/** Coarse bounds only: the real limits (10–600 characters after cleaning) are enforced by the service. */
const CreateDealBody = z.object({
  intent: z.string().max(4000),
  scenarioId: z.string().min(1).max(40).optional(),
  // Date#getTimezoneOffset(): UTC+14 is -840, UTC-12 is 720.
  tzOffsetMinutes: z.number().int().min(-840).max(720).optional(),
});

export const POST = route("deals.create", async (request) => {
  const body = await readJson(request, CreateDealBody);
  const sessionId = await ensureSession();
  const deal = await createDeal(await getServiceContext(), { sessionId, clientKey: clientKey(request) }, body);
  return json({ deal } satisfies CreateDealResponse, { status: 201 });
});

export const GET = route("deals.list", async () => {
  const sessionId = await readSession();
  const deals = sessionId === null ? [] : await listMyDeals(await getServiceContext(), sessionId);
  return json({ deals } satisfies DealListResponse);
});
