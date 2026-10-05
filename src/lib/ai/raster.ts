/**
 * SVG -> PNG for the vision verifier.
 *
 * Vision models take raster images, and the deliverables are SVG. Rasterisation is strictly
 * best-effort: the SVG comes from a seller and is untrusted, sharp is a native module that may
 * be missing on some platform, and a failure here must degrade to a text description of the
 * artwork rather than break verification. Hence: never throws, returns null instead.
 */
import "server-only";
import { log } from "../observability/logger";

const DEFAULT_MAX_SIZE = 512;
const MAX_SVG_CHARS = 200_000;
/** librsvg's reference resolution: an SVG's intrinsic pixel size is defined at this density. */
const BASE_DENSITY = 72;
const MIN_DENSITY = 8;
const MAX_DENSITY = 2400;
/** Upper bound on what librsvg may allocate for one image (about 4096 x 4096). */
const MAX_INPUT_PIXELS = 16_777_216;
const RENDER_TIMEOUT_SECONDS = 10;

/**
 * Pick the render density that makes the longest side land near `maxSize`, so large artwork is
 * not rendered at full size only to be thrown away, and small artwork is not upscaled into blur.
 */
function densityFor(width: number | undefined, height: number | undefined, maxSize: number): number {
  const longest = Math.max(width ?? 0, height ?? 0);
  if (longest <= 0) return BASE_DENSITY;
  // Rounded UP so the render is never a pixel short of the box; the resize step trims any excess.
  return Math.min(Math.max(Math.ceil((BASE_DENSITY * maxSize) / longest), MIN_DENSITY), MAX_DENSITY);
}

/**
 * Render an SVG document to a PNG whose longest side is at most `maxSize` pixels.
 * Returns null on ANY failure (invalid markup, oversized input, sharp unavailable, timeout).
 */
export async function rasterizeSvg(svg: string, maxSize: number = DEFAULT_MAX_SIZE): Promise<Uint8Array | null> {
  try {
    if (typeof svg !== "string" || svg.length === 0 || svg.length > MAX_SVG_CHARS) return null;
    const size = Number.isFinite(maxSize) ? Math.min(Math.max(Math.round(maxSize), 16), 2048) : DEFAULT_MAX_SIZE;
    // Loaded lazily: sharp is a native dependency and must not be pulled into every server bundle.
    const { default: sharp } = await import("sharp");
    const input = Buffer.from(svg, "utf8");
    const limits = { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" } as const;
    const intrinsic = await sharp(input, limits).metadata();
    const png = await sharp(input, { ...limits, density: densityFor(intrinsic.width, intrinsic.height, size) })
      .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .png({ compressionLevel: 9 })
      .timeout({ seconds: RENDER_TIMEOUT_SECONDS })
      .toBuffer();
    return new Uint8Array(png);
  } catch (error) {
    log.debug("raster.failed", { error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : String(error) });
    return null;
  }
}
