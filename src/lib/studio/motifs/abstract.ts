/**
 * Motif "abstract": a stack of rounded isometric plates in front of a large disc, with a
 * floating sphere, a capsule and an arc — a brand composition for subjects without a literal motif.
 */
import { mix } from "../palettes";
import { el, num } from "../svg-markup";
import { centerOf, type MotifPainter, type Point, type Scene } from "../scene";
import { arc } from "./shared";

type TopMark = "disc" | "grid" | "bars";

/** A rounded square lying flat in isometric projection, with a visible edge underneath. */
function plate(s: Scene, cx: number, cy: number, side: number, face: string, edge: string, marks: string): string {
  const iso = (dy: number): string => `translate(${num(cx)} ${num(cy + dy)}) scale(1 0.58) rotate(45)`;
  const square = (fill: string): string =>
    el("rect", { x: -side / 2, y: -side / 2, width: side, height: side, rx: side * 0.14, fill });
  return (
    s.group([square(edge)], { transform: iso(side * 0.065) }) +
    s.group([square(face), marks], { transform: iso(0) })
  );
}

function topMarks(s: Scene, kind: TopMark, side: number): string {
  const { palette } = s;
  const k = side / 2;
  switch (kind) {
    case "disc":
      return (
        s.disc(-k * 0.3, -k * 0.3, k * 0.3, s.brand) +
        s.textLines(k * 0.1, -k * 0.5, [k * 0.6, k * 0.4], k * 0.1, k * 0.1, palette.mute) +
        s.pill(-k * 0.6, k * 0.3, k * 1.2, k * 0.16, palette.surfaceAlt) +
        s.pill(-k * 0.6, k * 0.3, k * 0.75, k * 0.16, s.accent)
      );
    case "grid":
      return [-1, 0, 1]
        .flatMap((col) =>
          [-1, 0, 1].map((row) =>
            s.rect(
              { x: col * k * 0.46 - k * 0.17, y: row * k * 0.46 - k * 0.17, w: k * 0.34, h: k * 0.34 },
              k * 0.08,
              col === row ? s.accent : (col + row) % 2 === 0 ? palette.primary[0] : palette.surfaceAlt,
            ),
          ),
        )
        .join("");
    case "bars":
      return [0.5, 0.8, 0.62, 1]
        .map((h, i) => s.rect({ x: -k * 0.62 + i * k * 0.34, y: k * 0.55 - k * 1.1 * h, w: k * 0.22, h: k * 1.1 * h }, k * 0.07, i === 3 ? s.accent : palette.primary[0]))
        .join("");
  }
}

function sphere(s: Scene, cx: number, cy: number, r: number, color: string): string {
  return (
    s.disc(cx, cy, r, s.linear(mix(color, "#FFFFFF", 0.5), color)) +
    s.disc(cx - r * 0.32, cy - r * 0.36, r * 0.22, "#FFFFFF", { opacity: 0.55 })
  );
}

export const paintAbstract: MotifPainter = (s) => {
  const { u, palette, rng, focal } = s;
  // Seeded variation first, in a fixed order, so every ratio shows the same composition.
  const layers = rng.int(3, 4);
  const mark = rng.pick<TopMark>(["disc", "grid", "bars"]);
  const sunSide = rng.pick([-1, 1] as const);
  const capsuleTilt = rng.range(-38, -22);
  const sweep = rng.range(0.55, 0.75);

  const [fx, fy] = centerOf(focal);
  // Portrait canvases draw the group larger, but never taller than the focal area allows.
  const k = s.byMode({ wide: 1.1, square: 1.1, tall: Math.min(1.2, focal.h / (68 * u)) });
  const side = 30 * u * k;
  const gap = 8.6 * u * k;
  const sunR = 19 * u * k;
  const stackH = (layers - 1) * gap;
  // The disc rises above the stack, so the stack sits below centre to keep the group balanced.
  const above = stackH / 2 + 5 * u * k + sunR;
  const below = stackH / 2 + side * 0.41 + 4 * u;
  const center: Point = [fx + s.byMode({ wide: 2 * u, square: 0, tall: 0 }), fy + (above - below) / 2];
  const baseY = center[1] + stackH / 2 + 2 * u;

  const sun: Point = [center[0] + sunSide * 13 * u * k, center[1] - stackH / 2 - 5 * u * k];
  const backdrop =
    s.disc(sun[0], sun[1], sunR, s.linear(mix(s.accent, "#FFFFFF", 0.35), s.accent, "down"), { opacity: 0.92 }) +
    s.ring(sun[0], sun[1], sunR + 3.4 * u, s.accent, Math.max(1.5, 0.22 * u), { opacity: 0.5 });

  const faces = [palette.primary[1], palette.primary[0], mix(palette.primary[0], palette.surface, 0.55), palette.surface];
  const used = faces.slice(faces.length - layers);
  const plates = used
    .map((face, i) => {
      const isTop = i === used.length - 1;
      const edge = mix(face, palette.shadow, palette.dark ? 0.45 : 0.22);
      return plate(s, center[0], baseY - i * gap, side, face, edge, isTop ? topMarks(s, mark, side) : "");
    })
    .join("");
  const floor = el("ellipse", {
    cx: center[0],
    cy: baseY + 6 * u,
    rx: side * 0.62,
    ry: side * 0.2,
    fill: palette.shadow,
    opacity: palette.dark ? 0.6 : 0.24,
    filter: s.blur(1.6 * u),
  });

  const reach = side * 0.72;
  const ballAt: Point = [center[0] - sunSide * (reach + 5 * u), center[1] - stackH / 2 - 9 * u * k];
  const capsuleAt: Point = [center[0] + sunSide * (reach + 6 * u), baseY - 3 * u];
  const arcAt: Point = [center[0] - sunSide * (reach + 8 * u), baseY + 1 * u];
  const accents =
    sphere(s, ballAt[0], ballAt[1], 4.6 * u, s.accentAlt) +
    s.rotated(capsuleTilt, capsuleAt[0], capsuleAt[1], [
      s.pill(capsuleAt[0] - 8 * u, capsuleAt[1] - 2.5 * u, 16 * u, 5 * u, s.brand),
      s.disc(capsuleAt[0] + 5.5 * u, capsuleAt[1], 1.5 * u, "#FFFFFF", { opacity: 0.85 }),
    ]) +
    arc(s, arcAt[0], arcAt[1], 6.5 * u, 0, sweep, s.accentAlt, 2.2 * u) +
    sphere(s, sun[0] + sunSide * sunR * 0.5, sun[1] - sunR * 0.55, 1.9 * u, palette.primary[0]);

  // Portrait canvases get a second, bolder group of shapes under the stack instead of empty space.
  const { support } = s;
  const extras =
    s.mode === "tall"
      ? arc(s, support.x + 13 * u, support.y + 14 * u, 11 * u, 0.5, 1, mix(palette.primary[0], palette.surface, 0.35), 4.4 * u) +
        s.rotated(capsuleTilt, support.x + support.w - 22 * u, support.y + 13 * u, [
          s.pill(support.x + support.w - 39 * u, support.y + 8.5 * u, 34 * u, 9 * u, s.linear(mix(s.accent, "#FFFFFF", 0.35), s.accent, "right")),
          s.disc(support.x + support.w - 9.5 * u, support.y + 13 * u, 2.6 * u, "#FFFFFF", { opacity: 0.85 }),
        ]) +
        sphere(s, support.x + 30 * u, support.y + 19 * u, 3.4 * u, palette.primary[0])
      : "";

  return backdrop + floor + plates + accents + extras;
};
