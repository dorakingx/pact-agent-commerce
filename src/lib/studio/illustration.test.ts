import { describe, expect, it } from "vitest";
import { ASPECT_RATIOS, type AspectRatio } from "../domain/schemas";
import {
  MOTIFS,
  PALETTES,
  RATIO_DIMENSIONS,
  readArtSignature,
  renderIllustration,
  type ArtDirection,
  type Motif,
} from "./illustration";
import { computeStage } from "./scene";
import { sanitizeSvg } from "./svg-sanitize";

const MAX_BYTES = 30 * 1024;

function direction(motif: Motif, overrides: Partial<ArtDirection> = {}): ArtDirection {
  return {
    motif,
    palette: "cobalt",
    title: `${motif} illustration`,
    description: `A ${motif} scene for the test suite.`,
    seed: 20261006,
    ...overrides,
  };
}

const CASES = MOTIFS.flatMap((motif) => ASPECT_RATIOS.map((ratio) => [motif, ratio] as const));

describe("RATIO_DIMENSIONS", () => {
  it("gives every contract ratio pixel dimensions with exactly that ratio", () => {
    for (const ratio of ASPECT_RATIOS) {
      const [w, h] = ratio.split(":").map(Number);
      const { width, height } = RATIO_DIMENSIONS[ratio];
      expect(width * h).toBe(height * w);
    }
    expect(RATIO_DIMENSIONS["16:9"]).toEqual({ width: 1600, height: 900 });
    expect(RATIO_DIMENSIONS["1:1"]).toEqual({ width: 1200, height: 1200 });
    expect(RATIO_DIMENSIONS["9:16"]).toEqual({ width: 900, height: 1600 });
  });
});

describe("renderIllustration", () => {
  it.each(CASES)("%s at %s is to spec, self-contained and sanitizer-clean", (motif, ratio) => {
    const { width, height } = RATIO_DIMENSIONS[ratio];
    const rendered = renderIllustration(direction(motif), ratio);

    expect(rendered.width).toBe(width);
    expect(rendered.height).toBe(height);
    expect(rendered.svg.startsWith(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" `,
    )).toBe(true);
    expect(rendered.svg).toContain(`<title>${motif} illustration</title>`);
    expect(rendered.svg).toContain(`<desc>A ${motif} scene for the test suite.</desc>`);
    expect(Buffer.byteLength(rendered.svg, "utf8")).toBeLessThan(MAX_BYTES);

    // Deterministic: the same direction and ratio give byte-identical markup.
    expect(renderIllustration(direction(motif), ratio).svg).toBe(rendered.svg);

    // Already in the sanitizer's canonical form: sanitising changes nothing.
    const clean = sanitizeSvg(rendered.svg);
    expect(clean).toEqual({ ok: true, svg: rendered.svg });

    // No active content, no external references, no raster images, no fonts, no text.
    expect(rendered.svg).not.toMatch(/<script|<style|<image|<foreignObject|<a[\s>]|<text|<tspan|font-family/i);
    expect(rendered.svg).not.toMatch(/\son[a-z]+=|javascript:|data:|https?:\/\/(?!www\.w3\.org\/2000\/svg")/i);
    expect(rendered.svg).not.toMatch(/href=/);
    expect(rendered.svg).not.toMatch(/NaN|undefined|Infinity/);
  });

  it.each(CASES)("%s at %s only references ids it defines, and defines each id once", (motif, ratio) => {
    const { svg } = renderIllustration(direction(motif), ratio);
    const defined = [...svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    const referenced = [...svg.matchAll(/url\(#([^)]+)\)/g)].map((match) => match[1]);
    expect(new Set(defined).size).toBe(defined.length);
    expect(defined.length).toBeGreaterThan(0);
    for (const id of referenced) expect(defined).toContain(id);
  });

  it("renders every palette", () => {
    const outputs = PALETTES.map((palette) => renderIllustration(direction("dashboard", { palette }), "16:9").svg);
    expect(new Set(outputs).size).toBe(PALETTES.length);
    for (const svg of outputs) expect(sanitizeSvg(svg).ok).toBe(true);
  });

  it("varies with the seed but keeps the dimensions", () => {
    for (const motif of MOTIFS) {
      const a = renderIllustration(direction(motif, { seed: 1 }), "1:1");
      const b = renderIllustration(direction(motif, { seed: 2 }), "1:1");
      expect(a.svg).not.toBe(b.svg);
      expect([a.width, a.height]).toEqual([b.width, b.height]);
    }
  });

  it("re-composes for the ratio instead of scaling one drawing", () => {
    const wide = renderIllustration(direction("dashboard"), "16:9").svg;
    const tall = renderIllustration(direction("dashboard"), "9:16").svg;
    const body = (svg: string): string => svg.slice(svg.indexOf("</desc>"));
    // Different element counts prove a different layout, not a transformed copy.
    expect(body(wide).split("<rect").length).not.toBe(body(tall).split("<rect").length);
  });

  it("uses file-specific ids so several illustrations can be inlined into one page", () => {
    const ids = (svg: string): string[] => [...svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    const a = ids(renderIllustration(direction("growth"), "16:9").svg);
    const b = ids(renderIllustration(direction("growth"), "1:1").svg);
    const c = ids(renderIllustration(direction("network"), "16:9").svg);
    expect(a.filter((id) => b.includes(id) || c.includes(id))).toEqual([]);
  });

  it("escapes the title and description", () => {
    const { svg } = renderIllustration(
      direction("abstract", { title: 'Fast & "safe" <b>', description: "</desc><script>alert(1)</script>" }),
      "1:1",
    );
    expect(svg).toContain("<title>Fast &amp; \"safe\" &lt;b&gt;</title>");
    expect(svg).toContain("<desc>&lt;/desc&gt;&lt;script&gt;alert(1)&lt;/script&gt;</desc>");
    expect(sanitizeSvg(svg)).toEqual({ ok: true, svg });
  });
});

describe("readArtSignature", () => {
  it("recovers motif, palette and seed from a rendered file", () => {
    for (const motif of MOTIFS) {
      const drawn = direction(motif, { palette: "ember", seed: 4_000_000_123 });
      expect(readArtSignature(renderIllustration(drawn, "4:3").svg)).toEqual({
        motif,
        palette: "ember",
        seed: 4_000_000_123,
      });
    }
  });

  it("returns null for foreign or tampered markup", () => {
    expect(readArtSignature('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>')).toBeNull();
    expect(readArtSignature('<svg class="pact-art motif-castle palette-ember seed-1"><rect/></svg>')).toBeNull();
    expect(readArtSignature('<svg><g class="pact-art motif-launch palette-ember seed-1"/></svg>')).toBeNull();
    expect(readArtSignature("")).toBeNull();
  });
});

describe("computeStage", () => {
  const stage = (ratio: AspectRatio) => {
    const { width, height } = RATIO_DIMENSIONS[ratio];
    return { ...computeStage(width, height), width, height };
  };

  it("puts the focal group right of centre on wide canvases, with room on the left", () => {
    for (const ratio of ["16:9", "3:2", "4:3"] as const) {
      const { mode, focal, width, height } = stage(ratio);
      expect(mode).toBe("wide");
      expect(focal.x + focal.w / 2).toBeGreaterThan(width * 0.55);
      expect(focal.x).toBeGreaterThan(width * 0.25);
      expect(focal.x + focal.w).toBeLessThan(width * 0.95);
      expect(focal.y).toBeGreaterThan(0);
      expect(focal.y + focal.h).toBeLessThan(height);
    }
  });

  it("centres the focal group on a square canvas", () => {
    const { mode, focal, width, height } = stage("1:1");
    expect(mode).toBe("square");
    expect(focal.x + focal.w / 2).toBe(width / 2);
    expect(focal.y + focal.h / 2).toBe(height / 2);
  });

  it("stacks the focal group above a supporting row on tall canvases", () => {
    for (const ratio of ["4:5", "9:16"] as const) {
      const { mode, focal, support, width, height } = stage(ratio);
      expect(mode).toBe("tall");
      expect(focal.x + focal.w / 2).toBe(width / 2);
      expect(support.y).toBeGreaterThan(focal.y + focal.h);
      expect(support.y + support.h).toBeLessThan(height);
      expect(focal.y).toBeGreaterThan(height * 0.05);
    }
  });
});
