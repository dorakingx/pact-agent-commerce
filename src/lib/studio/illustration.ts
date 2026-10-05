/**
 * The studio's illustration engine: a parametric scene renderer that turns an art direction
 * (motif + palette + seed) into a finished flat-vector SVG at the exact pixel size of the
 * requested aspect ratio.
 *
 * Output is fully deterministic — the same (direction, ratio) always yields byte-identical
 * markup — and self-contained: no raster images, no fonts, no external references, no text
 * beyond the accessible <title> and <desc>. Every file is already in the canonical form of
 * the SVG sanitizer.
 */
import type { AspectRatio } from "../domain/schemas";
import { paintBackdrop } from "./backdrop";
import { paintAbstract } from "./motifs/abstract";
import { paintCollaboration } from "./motifs/collaboration";
import { paintCommerce } from "./motifs/commerce";
import { paintDashboard } from "./motifs/dashboard";
import { paintGrowth } from "./motifs/growth";
import { paintLaunch } from "./motifs/launch";
import { paintNetwork } from "./motifs/network";
import { paintSecurity } from "./motifs/security";
import { PALETTE_SPECS, PALETTES, type PaletteName } from "./palettes";
import { createRng, hash32 } from "./random";
import { Scene, type MotifPainter } from "./scene";
import { el, escapeText } from "./svg-markup";

export { PALETTES, type PaletteName };

/** Exact pixel dimensions delivered for each contract aspect ratio. */
export const RATIO_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "16:9": { width: 1600, height: 900 },
  "1:1": { width: 1200, height: 1200 },
  "4:3": { width: 1600, height: 1200 },
  "3:2": { width: 1500, height: 1000 },
  "4:5": { width: 1200, height: 1500 },
  "9:16": { width: 900, height: 1600 },
};

export const MOTIFS = [
  "dashboard",
  "launch",
  "collaboration",
  "security",
  "commerce",
  "growth",
  "network",
  "abstract",
] as const;
export type Motif = (typeof MOTIFS)[number];

export interface ArtDirection {
  motif: Motif;
  palette: PaletteName;
  /** Short name of the illustration; becomes the SVG <title>. */
  title: string;
  /** What is drawn, in one or two sentences; becomes the SVG <desc>. */
  description: string;
  /** Drives every variable choice inside the composition. */
  seed: number;
}

const PAINTERS: Readonly<Record<Motif, MotifPainter>> = {
  dashboard: paintDashboard,
  launch: paintLaunch,
  collaboration: paintCollaboration,
  security: paintSecurity,
  commerce: paintCommerce,
  growth: paintGrowth,
  network: paintNetwork,
  abstract: paintAbstract,
};

const SIGNATURE_CLASS = "pact-art";

/**
 * Render one illustration at the pixel size of `ratio`. The composition is re-laid-out for the
 * ratio (it is never a crop or a stretch), while the seed keeps the content of the scene the
 * same across ratios so that variants are recognisably the same illustration.
 */
export function renderIllustration(
  direction: ArtDirection,
  ratio: AspectRatio,
): { svg: string; width: number; height: number } {
  const { width, height } = RATIO_DIMENSIONS[ratio];
  const seed = direction.seed >>> 0;
  // Ids are prefixed per file: several illustrations inlined into one page must not share gradients.
  const idPrefix = `p${hash32(direction.motif, direction.palette, seed, ratio).toString(36)}`;
  const scene = new Scene(width, height, PALETTE_SPECS[direction.palette], createRng(seed), idPrefix);

  const body = paintBackdrop(scene) + PAINTERS[direction.motif](scene);
  const svg = el(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      // The signature lets a later revision re-create a missing variant of the same illustration.
      class: `${SIGNATURE_CLASS} motif-${direction.motif} palette-${direction.palette} seed-${seed}`,
    },
    [
      el("title", {}, escapeText(direction.title)),
      el("desc", {}, escapeText(direction.description)),
      scene.defsMarkup(),
      body,
    ],
  );
  return { svg, width, height };
}

/** Recover the motif, palette and seed a studio-rendered SVG was drawn with, if it is one. */
export function readArtSignature(svg: string): Pick<ArtDirection, "motif" | "palette" | "seed"> | null {
  const rootEnd = svg.indexOf(">");
  const match = /class="pact-art motif-([a-z]+) palette-([a-z]+) seed-(\d{1,10})"/.exec(
    rootEnd === -1 ? "" : svg.slice(0, rootEnd),
  );
  if (match === null) return null;
  const motif = MOTIFS.find((candidate) => candidate === match[1]);
  const palette = PALETTES.find((candidate) => candidate === match[2]);
  const seed = Number(match[3]);
  if (motif === undefined || palette === undefined || !Number.isSafeInteger(seed)) return null;
  return { motif, palette, seed: seed >>> 0 };
}
