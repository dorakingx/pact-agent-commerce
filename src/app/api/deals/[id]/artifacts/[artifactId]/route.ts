/**
 * GET /api/deals/{id}/artifacts/{artifactId} — one deliverable as a file download.
 *
 * A deliverable is seller-supplied content. The SVG was sanitised when it was delivered, but
 * this response does not rely on that: it is an attachment (never rendered in PACT's origin by
 * navigation), under a sandboxing content security policy that forbids scripts, plugins and
 * every network request, and with MIME sniffing switched off.
 */
import { getServiceContext } from "@/lib/services/context";
import { getArtifactFile } from "@/lib/services/deals";
import { route } from "@/lib/services/http";

export const maxDuration = 60;

/**
 * Nothing may load, run or be embedded. The sanitiser already strips styles as well; inline
 * style is the one thing left permitted because it can only change how the file itself looks.
 */
const ARTIFACT_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export const GET = route<RouteContext<"/api/deals/[id]/artifacts/[artifactId]">>("deals.artifact", async (_request, context) => {
  const { id, artifactId } = await context.params;
  const file = await getArtifactFile(await getServiceContext(), id, artifactId);
  return new Response(file.body, {
    status: 200,
    headers: {
      "Content-Type": file.contentType,
      // The name is built from a fixed alphabet (see toArtifactFile), so it cannot break out of the quotes.
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Content-Security-Policy": ARTIFACT_CSP,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
});
