/**
 * Geometry and data helpers shared by the motif painters.
 */
import type { Rng } from "../random";
import { num } from "../svg-markup";
import type { Box, Point, Scene } from "../scene";

/** The largest box of the given aspect ratio (w / h) that fits inside `container`, centred. */
export function fitBox(container: Box, aspect: number): Box {
  const w = Math.min(container.w, container.h * aspect);
  const h = w / aspect;
  return { x: container.x + (container.w - w) / 2, y: container.y + (container.h - h) / 2, w, h };
}

/** `count` values in (0, 1) that climb overall but wobble like real data. */
export function risingSeries(rng: Rng, count: number): number[] {
  return Array.from({ length: count }, (_, i) => {
    const base = 0.16 + 0.66 * (i / Math.max(1, count - 1)) ** 1.2;
    return Math.min(0.97, Math.max(0.06, base + rng.range(-0.1, 0.1)));
  });
}

/** Map a 0..1 series onto a plot box (first value at the left edge, 1 at the top). */
export function plotPoints(series: readonly number[], plot: Box): Point[] {
  return series.map((value, i) => [
    plot.x + (plot.w * i) / Math.max(1, series.length - 1),
    plot.y + plot.h * (1 - value),
  ]);
}

/** A circular arc drawn as a dashed circle: `from`/`to` are fractions of a full turn from 12 o'clock. */
export function arc(s: Scene, cx: number, cy: number, r: number, from: number, to: number, color: string, w: number): string {
  const circumference = 2 * Math.PI * r;
  return s.ring(cx, cy, r, color, w, {
    "stroke-dasharray": `${num(circumference * (to - from))} ${num(circumference)}`,
    "stroke-dashoffset": num(-circumference * from),
    transform: `rotate(-90 ${num(cx)} ${num(cy)})`,
  });
}

/** Point on an ellipse; `angle` in degrees, 0 = right, clockwise on screen. */
export function onEllipse(cx: number, cy: number, rx: number, ry: number, angle: number): Point {
  const radians = (angle * Math.PI) / 180;
  return [cx + rx * Math.cos(radians), cy + ry * Math.sin(radians)];
}

/** Horizontal hairlines across a plot area. */
export function gridLines(s: Scene, plot: Box, count: number): string {
  let d = "";
  for (let i = 0; i < count; i += 1) {
    const y = plot.y + (plot.h * i) / (count - 1);
    d += `M${num(plot.x)} ${num(y)}H${num(plot.x + plot.w)}`;
  }
  return s.stroke(d, s.palette.line, Math.max(1, s.u * 0.1), { opacity: s.palette.dark ? 0.9 : 1 });
}
