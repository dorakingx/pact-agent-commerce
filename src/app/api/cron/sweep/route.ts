/**
 * GET /api/cron/sweep — run the next step of deals that hold money and that nobody is advancing.
 *
 * For a scheduler, not for browsers: the caller must present the deployment's CRON_SECRET as
 * `Authorization: Bearer <secret>` (what Vercel Cron sends). Without a configured secret the
 * endpoint is closed. It carries no session and changes no deal a human still has to act on;
 * see src/lib/services/sweep.ts for what it does and why.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { getAppUrl, getCronSecret } from "@/lib/config";
import { getServiceContext } from "@/lib/services/context";
import { forbidden, notFound } from "@/lib/services/errors";
import { json, requestOrigin, route } from "@/lib/services/http";
import { sweepStalledDeals } from "@/lib/services/sweep";

/** A sweep starts no new step after 15 s, and the slowest step (verification) takes 40 s. */
export const maxDuration = 60;

const BEARER = /^Bearer (.+)$/;

/** Compared as digests in constant time, so neither the secret's content nor its length leaks through timing. */
function presentsSecret(request: Request, secret: string): boolean {
  const presented = BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
  if (presented === undefined) return false;
  const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(secret), digest(presented));
}

export const GET = route("cron.sweep", async (request) => {
  const secret = getCronSecret();
  // Closed, and indistinguishable from a route that does not exist, until the operator sets a secret.
  if (secret === undefined) throw notFound();
  if (!presentsSecret(request, secret)) throw forbidden();
  const result = await sweepStalledDeals(await getServiceContext(), getAppUrl(requestOrigin(request)));
  return json(result);
});
