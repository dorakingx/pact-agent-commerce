/**
 * The drawing surface every motif composes on.
 *
 * A Scene fixes the things that make a set of illustrations look like one designer made them:
 * how the canvas is divided for each aspect ratio, how cards, shadows and "text" marks are
 * drawn, and where gradients and filters are registered. Motifs only decide WHAT goes where.
 */
import { mix, type Palette } from "./palettes";
import type { Rng } from "./random";
import { el, num, type Attrs } from "./svg-markup";

export type LayoutMode = "wide" | "square" | "tall";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Point = readonly [x: number, y: number];

export interface Stage {
  mode: LayoutMode;
  /** The unit every detail is sized in (about one percent of the shorter side). */
  u: number;
  /** Where the hero object lives. */
  focal: Box;
  /** Free area for supporting elements: left of the focal group when wide, below it when tall. */
  support: Box;
}

/**
 * One percent of the shorter canvas side, except on portrait canvases, where details are drawn
 * a little larger: tall formats are viewed on phones and the focal group has less width to use.
 */
function unitFor(width: number, height: number): number {
  return width / height <= TALL_MAX_ASPECT ? width / 90 : Math.min(width, height) / 100;
}

const WIDE_MIN_ASPECT = 1.25;
const TALL_MAX_ASPECT = 0.85;
/** Height reserved under the focal group for the supporting row of a tall layout, in units. */
const TALL_SUPPORT_UNITS = 24;

/**
 * Divide the canvas for an aspect ratio. This is a re-composition, not a crop:
 *  - wide:   focal group right of centre, the left third is breathing room;
 *  - square: focal group centred, supporting elements overlap its corners;
 *  - tall:   focal group on top, supporting elements stacked underneath, the stack centred.
 */
export function computeStage(width: number, height: number): Stage {
  const aspect = width / height;
  const u = unitFor(width, height);
  if (aspect >= WIDE_MIN_ASPECT) {
    const h = height * 0.74;
    const w = Math.min(h * 1.3, width * 0.62);
    const x = width / 2 + (width - height) * 0.3 - w / 2;
    const focal = { x, y: (height - h) / 2, w, h };
    const margin = width * 0.06;
    return { mode: "wide", u, focal, support: { x: margin, y: height * 0.2, w: x - margin, h: height * 0.6 } };
  }
  if (aspect <= TALL_MAX_ASPECT) {
    const w = width * 0.84;
    const h = Math.min(w * 1.3, height * 0.54);
    const gap = 4 * u;
    const supportH = TALL_SUPPORT_UNITS * u;
    const top = Math.max(height * 0.07, (height - (h + gap + supportH)) / 2);
    const focal = { x: (width - w) / 2, y: top, w, h };
    return { mode: "tall", u, focal, support: { x: focal.x, y: top + h + gap, w, h: supportH } };
  }
  const side = Math.min(width, height) * 0.72;
  const focal = { x: (width - side) / 2, y: (height - side) / 2, w: side, h: side };
  return {
    mode: "square",
    u,
    focal,
    support: { x: width * 0.06, y: height * 0.62, w: width * 0.36, h: height * 0.3 },
  };
}

export interface CardOptions {
  radius?: number;
  fill?: string;
  /** Shadow strength in scene units; 0 draws no shadow. */
  depth?: number;
  border?: boolean;
}

export class Scene {
  readonly mode: LayoutMode;
  readonly focal: Box;
  readonly support: Box;
  /** The unit every detail is sized in (see Stage.u). */
  readonly u: number;
  /** The pop colour of this illustration; which of the palette's two accents leads is seeded. */
  readonly accent: string;
  readonly accentAlt: string;

  private readonly definitions: string[] = [];
  private readonly paints = new Map<string, string>();
  private counter = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly palette: Palette,
    readonly rng: Rng,
    /** Prefix for element ids, unique per rendered file so inlined SVGs never share an id. */
    private readonly idPrefix: string,
  ) {
    const stage = computeStage(width, height);
    this.mode = stage.mode;
    this.focal = stage.focal;
    this.support = stage.support;
    this.u = stage.u;
    const swap = rng.chance(0.5);
    this.accent = swap ? palette.accentAlt : palette.accent;
    this.accentAlt = swap ? palette.accent : palette.accentAlt;
  }

  byMode<T>(options: Readonly<Record<LayoutMode, T>>): T {
    return options[this.mode];
  }

  /* ----------------------------- definitions ----------------------------- */

  private register(key: string, build: (id: string) => string): string {
    const known = this.paints.get(key);
    if (known !== undefined) return known;
    const id = `${this.idPrefix}${this.counter.toString(36)}`;
    this.counter += 1;
    this.definitions.push(build(id));
    this.paints.set(key, id);
    return id;
  }

  /** Two-stop linear gradient; returns a paint reference. */
  linear(from: string, to: string, direction: "diagonal" | "down" | "right" = "diagonal"): string {
    const end = direction === "down" ? { x2: 0, y2: 1 } : direction === "right" ? { x2: 1, y2: 0 } : { x2: 1, y2: 1 };
    const id = this.register(`lin:${from}:${to}:${direction}`, (gid) =>
      el("linearGradient", { id: gid, x1: 0, y1: 0, ...end }, [
        el("stop", { offset: 0, "stop-color": from }),
        el("stop", { offset: 1, "stop-color": to }),
      ]),
    );
    return `url(#${id})`;
  }

  /** The palette's brand gradient. */
  get brand(): string {
    return this.linear(this.palette.primary[0], this.palette.primary[1]);
  }

  /** A single colour fading out along one axis (area-chart fills, light trails). */
  fade(color: string, fromOpacity: number, toOpacity: number, direction: "down" | "right" = "down"): string {
    const end = direction === "down" ? { x2: 0, y2: 1 } : { x2: 1, y2: 0 };
    const id = this.register(`fade:${color}:${fromOpacity}:${toOpacity}:${direction}`, (gid) =>
      el("linearGradient", { id: gid, x1: 0, y1: 0, ...end }, [
        el("stop", { offset: 0, "stop-color": color, "stop-opacity": fromOpacity }),
        el("stop", { offset: 1, "stop-color": color, "stop-opacity": toOpacity }),
      ]),
    );
    return `url(#${id})`;
  }

  /** Radial colour field that fades to nothing at its edge. */
  halo(color: string, opacity: number): string {
    const id = this.register(`halo:${color}:${opacity}`, (gid) =>
      el("radialGradient", { id: gid, cx: 0.5, cy: 0.5, r: 0.5 }, [
        el("stop", { offset: 0, "stop-color": color, "stop-opacity": opacity }),
        el("stop", { offset: 1, "stop-color": color, "stop-opacity": 0 }),
      ]),
    );
    return `url(#${id})`;
  }

  /** Gaussian blur filter with enough margin that soft shadows are never clipped. */
  blur(deviation: number): string {
    const rounded = Math.max(0.5, Math.round(deviation * 2) / 2);
    const id = this.register(`blur:${rounded}`, (fid) =>
      el("filter", { id: fid, x: "-50%", y: "-50%", width: "200%", height: "200%" }, [
        el("feGaussianBlur", { stdDeviation: rounded }),
      ]),
    );
    return `url(#${id})`;
  }

  clip(shape: string): string {
    const id = this.register(`clip:${shape}`, (cid) => el("clipPath", { id: cid }, shape));
    return `url(#${id})`;
  }

  /** Register an arbitrary definition (pattern, mask) and return its id. */
  define(key: string, build: (id: string) => string): string {
    return this.register(key, build);
  }

  defsMarkup(): string {
    return this.definitions.length === 0 ? "" : el("defs", {}, this.definitions);
  }

  /* ------------------------------ primitives ----------------------------- */

  /** A tint of `color` over the card surface, as a solid colour. */
  tint(color: string, amount: number): string {
    return mix(this.palette.surface, color, amount);
  }

  shadow(box: Box, radius: number, depth: number): string {
    if (depth <= 0) return "";
    const { u, palette } = this;
    return el("rect", {
      x: box.x + depth * u * 0.15,
      y: box.y + depth * u * 0.7,
      width: box.w - depth * u * 0.3,
      height: box.h,
      rx: radius,
      fill: palette.shadow,
      opacity: palette.dark ? 0.5 : 0.17,
      filter: this.blur(depth * u * 0.85),
    });
  }

  card(box: Box, options: CardOptions = {}): string {
    const { u, palette } = this;
    const radius = options.radius ?? 2.2 * u;
    const border = options.border ?? true;
    return (
      this.shadow(box, radius, options.depth ?? 2) +
      el("rect", {
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        rx: radius,
        fill: options.fill ?? palette.surface,
        stroke: border ? palette.line : null,
        "stroke-width": border ? Math.max(1, u * 0.12) : null,
      })
    );
  }

  rect(box: Box, radius: number, fill: string, extra: Attrs = {}): string {
    return el("rect", { x: box.x, y: box.y, width: box.w, height: box.h, rx: radius || null, fill, ...extra });
  }

  /** A fully rounded bar: the stand-in for a word, a button or a progress track. */
  pill(x: number, y: number, w: number, h: number, fill: string, extra: Attrs = {}): string {
    return el("rect", { x, y, width: Math.max(w, h), height: h, rx: h / 2, fill, ...extra });
  }

  /** Stacked bars standing in for lines of text. Widths are given in pixels. */
  textLines(x: number, y: number, widths: readonly number[], h: number, gap: number, fill: string): string {
    return widths.map((w, i) => this.pill(x, y + i * (h + gap), w, h, fill)).join("");
  }

  disc(cx: number, cy: number, r: number, fill: string, extra: Attrs = {}): string {
    return el("circle", { cx, cy, r, fill, ...extra });
  }

  ring(cx: number, cy: number, r: number, stroke: string, strokeWidth: number, extra: Attrs = {}): string {
    return el("circle", { cx, cy, r, fill: "none", stroke, "stroke-width": strokeWidth, ...extra });
  }

  path(d: string, attrs: Attrs): string {
    return el("path", { d, ...attrs });
  }

  stroke(d: string, color: string, strokeWidth: number, extra: Attrs = {}): string {
    return el("path", {
      d,
      fill: "none",
      stroke: color,
      "stroke-width": strokeWidth,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      ...extra,
    });
  }

  group(children: readonly string[], attrs: Attrs = {}): string {
    const inner = children.join("");
    return inner === "" ? "" : el("g", attrs, inner);
  }

  rotated(degrees: number, cx: number, cy: number, children: readonly string[]): string {
    return this.group(children, { transform: `rotate(${num(degrees)} ${num(cx)} ${num(cy)})` });
  }

  /** A check mark centred on (cx, cy); `size` is its overall width. */
  check(cx: number, cy: number, size: number, color: string, strokeWidth: number): string {
    const s = size / 2;
    const d = `M${num(cx - s)} ${num(cy + s * 0.05)}L${num(cx - s * 0.3)} ${num(cy + s * 0.7)}L${num(cx + s)} ${num(cy - s * 0.65)}`;
    return this.stroke(d, color, strokeWidth);
  }

  /** A round badge with a check: "done", "verified", "paid". */
  checkBadge(cx: number, cy: number, r: number, fill: string): string {
    return this.disc(cx, cy, r, fill) + this.check(cx, cy, r * 0.9, "#FFFFFF", r * 0.24);
  }

  /** Four-point sparkle used for stars and highlights. */
  sparkle(cx: number, cy: number, size: number, fill: string, opacity = 1): string {
    const s = size;
    const d = `M${num(cx)} ${num(cy - s)}Q${num(cx)} ${num(cy)} ${num(cx + s)} ${num(cy)}Q${num(cx)} ${num(cy)} ${num(cx)} ${num(cy + s)}Q${num(cx)} ${num(cy)} ${num(cx - s)} ${num(cy)}Q${num(cx)} ${num(cy)} ${num(cx)} ${num(cy - s)}Z`;
    return el("path", { d, fill, opacity: opacity === 1 ? null : opacity });
  }

  /** Small "+" mark: a quiet decorative accent in open areas. */
  plus(cx: number, cy: number, size: number, color: string, opacity = 1): string {
    const d = `M${num(cx - size)} ${num(cy)}H${num(cx + size)}M${num(cx)} ${num(cy - size)}V${num(cy + size)}`;
    return this.stroke(d, color, Math.max(1.5, this.u * 0.28), { opacity: opacity === 1 ? null : opacity });
  }

  /** A person glyph in a coloured disc. Shoulders follow the disc so nothing needs clipping. */
  avatar(cx: number, cy: number, r: number, background: string, figure: string): string {
    const shoulderX = r * 0.62;
    const shoulderY = r * 0.78;
    const shoulders =
      `M${num(cx - shoulderX)} ${num(cy + shoulderY)}` +
      `A${num(shoulderX)} ${num(r * 0.6)} 0 0 1 ${num(cx + shoulderX)} ${num(cy + shoulderY)}` +
      `A${num(r)} ${num(r)} 0 0 1 ${num(cx - shoulderX)} ${num(cy + shoulderY)}Z`;
    return (
      this.disc(cx, cy, r, background) +
      this.disc(cx, cy - r * 0.2, r * 0.34, figure) +
      el("path", { d: shoulders, fill: figure })
    );
  }

  /** Catmull-Rom spline through the points, as a cubic Bézier path. */
  smooth(points: readonly Point[]): string {
    const first = points[0];
    if (first === undefined) return "";
    let d = `M${num(first[0])} ${num(first[1])}`;
    for (let i = 0; i < points.length - 1; i += 1) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(points.length - 1, i + 2)];
      const c1: Point = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2: Point = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += `C${num(c1[0])} ${num(c1[1])} ${num(c2[0])} ${num(c2[1])} ${num(p2[0])} ${num(p2[1])}`;
    }
    return d;
  }
}

/** A motif paints the focal group and its supporting elements; the backdrop is shared. */
export type MotifPainter = (scene: Scene) => string;

export function centerOf(box: Box): Point {
  return [box.x + box.w / 2, box.y + box.h / 2];
}
