import { describe, expect, it } from "vitest";
import { rasterizeSvg } from "./raster";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from the PNG IHDR chunk (big-endian, bytes 16-23). */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const WIDE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
  <rect width="1600" height="900" fill="#0f172a"/>
  <circle cx="800" cy="450" r="300" fill="#38bdf8"/>
</svg>`;

describe("rasterizeSvg", () => {
  it("renders an SVG to a PNG that fits the requested box and keeps its aspect ratio", async () => {
    const png = await rasterizeSvg(WIDE_SVG);
    if (!png) throw new Error("expected a PNG");
    expect([...png.slice(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(pngSize(png)).toEqual({ width: 512, height: 288 });
  });

  it("honours a custom maximum size", async () => {
    const png = await rasterizeSvg(WIDE_SVG, 128);
    if (!png) throw new Error("expected a PNG");
    expect(pngSize(png)).toEqual({ width: 128, height: 72 });
  });

  it("renders small artwork at a higher density instead of upscaling it into blur", async () => {
    const tiny = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#22c55e"/></svg>';
    const png = await rasterizeSvg(tiny);
    if (!png) throw new Error("expected a PNG");
    const { width, height } = pngSize(png);
    expect({ width, height }).toEqual({ width: 512, height: 512 });
  });

  it.each([
    ["an empty string", ""],
    ["text that is not SVG", "this is not an image"],
    ["truncated markup", '<svg xmlns="http://www.w3.org/2000/svg"><rect'],
    ["an oversized document", `<svg xmlns="http://www.w3.org/2000/svg">${"<g></g>".repeat(40_000)}</svg>`],
  ])("returns null for %s instead of throwing", async (_label, svg) => {
    await expect(rasterizeSvg(svg)).resolves.toBeNull();
  });

  it("falls back to the default size when given a nonsensical one", async () => {
    const png = await rasterizeSvg(WIDE_SVG, Number.NaN);
    if (!png) throw new Error("expected a PNG");
    expect(pngSize(png).width).toBe(512);
  });
});
