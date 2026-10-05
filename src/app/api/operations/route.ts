/**
 * GET /api/operations — the operations ledger: the caller's own deals plus the seeded showcase
 * deals, with their payment events, verification checks and totals. Read-only. Without a
 * session only the showcase is returned.
 */
import { getServiceContext } from "@/lib/services/context";
import { json, route } from "@/lib/services/http";
import { getOpsSnapshot } from "@/lib/services/operations";
import { readSession } from "@/lib/services/session";

export const maxDuration = 60;

export const GET = route("operations.snapshot", async () => {
  const sessionId = await readSession();
  return json(await getOpsSnapshot(await getServiceContext(), sessionId));
});
