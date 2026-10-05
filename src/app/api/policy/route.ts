/**
 * GET /api/policy — the calling session's spending policy (the default until one is saved) and
 *                   what it has committed against today's limit. Never creates a session.
 * PUT /api/policy — replace the session's policy. Applies to that session only, and only to
 *                   what happens next: a signed contract keeps the thresholds it was signed with.
 */
import type { PolicyResponse } from "@/lib/api/dto";
import { PolicySchema } from "@/lib/domain/schemas";
import { getServiceContext } from "@/lib/services/context";
import { json, readJson, route } from "@/lib/services/http";
import { getPolicy, updatePolicy } from "@/lib/services/policy";
import { ensureSession, readSession } from "@/lib/services/session";

export const maxDuration = 60;

export const GET = route("policy.get", async () => {
  const policy = await getPolicy(await getServiceContext(), await readSession());
  return json(policy satisfies PolicyResponse);
});

export const PUT = route("policy.update", async (request) => {
  const body = await readJson(request, PolicySchema);
  // Setting a policy is a legitimate first act, before any deal exists, so it may start the session.
  const sessionId = await ensureSession();
  const policy = await updatePolicy(await getServiceContext(), sessionId, body);
  return json(policy satisfies PolicyResponse);
});
