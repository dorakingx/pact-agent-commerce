/**
 * The shared canvas behind every motif: a soft gradient, two colour fields, a dot grid that
 * fades away from the focal group, and a few quiet marks in the open areas. Keeping this
 * identical across motifs is a large part of why a delivery reads as one cohesive set.
 */
import { el, num } from "./svg-markup";
import { centerOf, type Scene } from "./scene";

/** Candidate positions for decorative marks, as fractions of the canvas. */
const MARK_SLOTS: readonly (readonly [number, number])[] = [
  [0.07, 0.14],
  [0.2, 0.08],
  [0.38, 0.1],
  [0.93, 0.1],
  [0.05, 0.5],
  [0.95, 0.52],
  [0.08, 0.88],
  [0.3, 0.93],
  [0.62, 0.94],
  [0.92, 0.9],
  [0.16, 0.3],
  [0.84, 0.05],
];

export function paintBackdrop(s: Scene): string {
  const { width, height, palette, u, focal, rng } = s;
  const [fx, fy] = centerOf(focal);
  const reach = Math.max(focal.w, focal.h);
  // Drawn before layout-dependent work so every ratio of one illustration gets the same marks.
  const slots = rng.shuffle(MARK_SLOTS).slice(0, 6);

  const canvas = el("rect", {
    width,
    height,
    fill: s.linear(palette.canvas[0], palette.canvas[1]),
  });

  const corner = s.byMode<readonly [number, number]>({
    wide: [width * 0.1, height * 1.02],
    square: [width * 0.06, height * 0.04],
    tall: [width * 0.9, height * 0.98],
  });
  const glows =
    s.disc(fx, fy, reach * 0.78, s.halo(palette.glow[0], palette.dark ? 0.5 : 0.75)) +
    s.disc(corner[0], corner[1], Math.max(width, height) * 0.42, s.halo(palette.glow[1], palette.dark ? 0.3 : 0.6));

  const step = 3.4 * u;
  const patternId = s.define("grid", (id) =>
    el("pattern", { id, width: step, height: step, patternUnits: "userSpaceOnUse" }, [
      el("circle", { cx: step / 2, cy: step / 2, r: Math.max(1, u * 0.17), fill: palette.ink }),
    ]),
  );
  const maskId = s.define("gridfade", (id) =>
    el("mask", { id }, [s.disc(fx, fy, reach * 0.95, s.halo("#FFFFFF", 1))]),
  );
  const grid = el("rect", {
    width,
    height,
    fill: `url(#${patternId})`,
    mask: `url(#${maskId})`,
    opacity: palette.dark ? 0.3 : 0.22,
  });

  const rings =
    s.ring(fx, fy, reach * 0.56, palette.line, Math.max(1, u * 0.14), { opacity: 0.7 }) +
    s.ring(fx, fy, reach * 0.74, palette.line, Math.max(1, u * 0.14), {
      opacity: 0.45,
      "stroke-dasharray": `${num(u * 0.9)} ${num(u * 1.3)}`,
    });

  const clear = 5 * u;
  const marks = slots
    .map(([px, py], i) => {
      const x = px * width;
      const y = py * height;
      const insideFocal =
        x > focal.x - clear && x < focal.x + focal.w + clear && y > focal.y - clear && y < focal.y + focal.h + clear;
      if (insideFocal) return "";
      if (i % 3 === 0) return s.plus(x, y, u * 0.9, palette.ink, 0.35);
      if (i % 3 === 1) return s.ring(x, y, u * 0.8, s.accent, Math.max(1.5, u * 0.26), { opacity: 0.7 });
      return s.disc(x, y, u * 0.5, palette.primary[0], { opacity: 0.6 });
    })
    .join("");

  return canvas + glows + grid + rings + marks;
}
