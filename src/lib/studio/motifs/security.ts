/**
 * Motif "security": a shield with a verified mark at the centre of two orbit rings that carry
 * small lock, key and keypad badges, with a passcode card and a settings card in front.
 */
import { el, num } from "../svg-markup";
import { centerOf, type Box, type MotifPainter, type Point, type Scene } from "../scene";
import { arc, onEllipse } from "./shared";

type Glyph = "lock" | "key" | "keypad";

function shieldPath(cx: number, cy: number, a: number): string {
  const x = (value: number): string => num(cx + value * a);
  const y = (value: number): string => num(cy + value * a);
  return (
    `M${x(0)} ${y(-1.2)}C${x(0.36)} ${y(-0.95)} ${x(0.7)} ${y(-0.85)} ${x(1)} ${y(-0.85)}V${y(-0.05)}` +
    `C${x(1)} ${y(0.62)} ${x(0.55)} ${y(1.02)} ${x(0)} ${y(1.25)}` +
    `C${x(-0.55)} ${y(1.02)} ${x(-1)} ${y(0.62)} ${x(-1)} ${y(-0.05)}V${y(-0.85)}` +
    `C${x(-0.7)} ${y(-0.85)} ${x(-0.36)} ${y(-0.95)} ${x(0)} ${y(-1.2)}Z`
  );
}

function lockGlyph(s: Scene, cx: number, cy: number, size: number, color: string): string {
  const w = size;
  const shackle = `M${num(cx - w * 0.28)} ${num(cy - w * 0.08)}V${num(cy - w * 0.3)}A${num(w * 0.28)} ${num(w * 0.28)} 0 0 1 ${num(cx + w * 0.28)} ${num(cy - w * 0.3)}V${num(cy - w * 0.08)}`;
  return (
    s.stroke(shackle, color, w * 0.16) +
    s.rect({ x: cx - w * 0.45, y: cy - w * 0.1, w: w * 0.9, h: w * 0.68 }, w * 0.14, color)
  );
}

function glyph(s: Scene, kind: Glyph, cx: number, cy: number, size: number, color: string): string {
  switch (kind) {
    case "lock":
      return lockGlyph(s, cx, cy, size, color);
    case "key":
      return (
        s.ring(cx - size * 0.24, cy, size * 0.24, color, size * 0.16) +
        s.stroke(
          `M${num(cx)} ${num(cy)}H${num(cx + size * 0.5)}M${num(cx + size * 0.3)} ${num(cy)}V${num(cy + size * 0.22)}`,
          color,
          size * 0.16,
        )
      );
    case "keypad":
      return [-1, 0, 1]
        .flatMap((col) => [-1, 1].map((row) => s.disc(cx + col * size * 0.32, cy + row * size * 0.18, size * 0.11, color)))
        .join("");
  }
}

function badge(s: Scene, at: Point, kind: Glyph, color: string): string {
  const { u, palette } = s;
  const r = 3.3 * u;
  return (
    s.shadow({ x: at[0] - r, y: at[1] - r, w: 2 * r, h: 2 * r }, r, 2) +
    s.disc(at[0], at[1], r, palette.surface, { stroke: palette.line, "stroke-width": Math.max(1, 0.12 * u) }) +
    glyph(s, kind, at[0], at[1], 3 * u, color)
  );
}

function passcodeCard(s: Scene, box: Box, filled: number): string {
  const { u, palette } = s;
  const cy = box.y + box.h / 2;
  const icon: Box = { x: box.x + 2 * u, y: cy - 2.7 * u, w: 5.4 * u, h: 5.4 * u };
  const dots = Array.from({ length: 6 }, (_, i) =>
    s.disc(box.x + 10.4 * u + i * 2.3 * u, cy, 0.75 * u, i < filled ? palette.ink : palette.mute, { opacity: i < filled ? 0.85 : null }),
  ).join("");
  return (
    s.card(box, { radius: 2.6 * u, depth: 3 }) +
    s.rect(icon, 1.4 * u, s.tint(palette.primary[0], palette.dark ? 0.3 : 0.18)) +
    lockGlyph(s, icon.x + icon.w / 2, cy + 0.2 * u, 2.9 * u, palette.primary[0]) +
    dots +
    s.checkBadge(box.x + box.w - 4.2 * u, cy, 2.1 * u, s.accent)
  );
}

function toggle(s: Scene, x: number, cy: number, on: boolean): string {
  const { u, palette } = s;
  return (
    s.pill(x, cy - 1.5 * u, 5.6 * u, 3 * u, on ? s.accent : palette.mute) +
    s.disc(on ? x + 4.1 * u : x + 1.5 * u, cy, 1.1 * u, "#FFFFFF")
  );
}

function settingsCard(s: Scene, box: Box, secondOn: boolean): string {
  const { u, palette } = s;
  const row = (index: number, width: number, on: boolean): string => {
    const cy = box.y + 3.7 * u + index * 5.2 * u;
    return (
      s.pill(box.x + 2.2 * u, cy - 1.3 * u, width, 1.3 * u, palette.ink, { opacity: 0.8 }) +
      s.pill(box.x + 2.2 * u, cy + 0.7 * u, width * 0.62, 1 * u, palette.mute) +
      toggle(s, box.x + box.w - 7.8 * u, cy, on)
    );
  };
  return s.card(box, { depth: 3 }) + row(0, box.w * 0.38, true) + row(1, box.w * 0.3, secondOn);
}

export const paintSecurity: MotifPainter = (s) => {
  const { u, palette, rng, focal } = s;
  // Seeded variation first, in a fixed order, so every ratio shows the same scene.
  const emblem = rng.pick(["check", "keyhole"] as const);
  const jitter = [rng.range(-9, 9), rng.range(-9, 9), rng.range(-9, 9)];
  const kinds = rng.shuffle<Glyph>(["lock", "key", "keypad"]);
  const filled = rng.int(4, 6);
  const secondOn = rng.chance(0.4);
  const sweep = rng.range(0, 0.5);

  const [fx, fy] = centerOf(focal);
  const a = s.byMode({ wide: 15, square: 15, tall: 17.5 }) * u;
  const center: Point = s.byMode<Point>({
    wide: [fx + 3 * u, fy],
    square: [fx, fy - 1 * u],
    tall: [fx, focal.y + focal.h * 0.5],
  });
  const [cx, cy] = center;
  const orbit = 2.05 * a;

  const rings =
    s.disc(cx, cy, 1.62 * a, palette.primary[0], { opacity: palette.dark ? 0.16 : 0.12 }) +
    s.ring(cx, cy, 1.62 * a, palette.primary[0], Math.max(1.2, 0.16 * u), { opacity: 0.5 }) +
    s.ring(cx, cy, orbit, palette.dark ? palette.mute : palette.primary[0], Math.max(1.2, 0.16 * u), {
      opacity: 0.55,
      "stroke-dasharray": `${num(0.8 * u)} ${num(1.2 * u)}`,
    }) +
    arc(s, cx, cy, 1.62 * a, sweep, sweep + 0.14, s.accent, 0.5 * u) +
    arc(s, cx, cy, 1.62 * a, sweep + 0.5, sweep + 0.6, s.accent, 0.5 * u);

  const shield = shieldPath(cx, cy, a);
  const inside = s.clip(el("path", { d: shield }));
  const mark =
    emblem === "check"
      ? s.check(cx, cy + 0.02 * a, 0.86 * a, "#FFFFFF", 0.17 * a)
      : s.disc(cx, cy - 0.16 * a, 0.24 * a, "#FFFFFF") +
        s.path(`M${num(cx - 0.1 * a)} ${num(cy - 0.02 * a)}H${num(cx + 0.1 * a)}L${num(cx + 0.17 * a)} ${num(cy + 0.46 * a)}H${num(cx - 0.17 * a)}Z`, {
          fill: "#FFFFFF",
        });
  const hero =
    el("ellipse", {
      cx,
      cy: cy + 1.5 * a,
      rx: 0.8 * a,
      ry: 0.13 * a,
      fill: palette.shadow,
      opacity: palette.dark ? 0.55 : 0.22,
      filter: s.blur(0.9 * u),
    }) +
    s.path(shield, { fill: s.brand }) +
    s.group([el("rect", { x: cx - a, y: cy - 1.3 * a, width: a, height: 2.7 * a, fill: "#FFFFFF", opacity: 0.16 })], {
      "clip-path": inside,
    }) +
    s.path(shieldPath(cx, cy, a * 0.8), { fill: "none", stroke: "#FFFFFF", "stroke-width": 0.035 * a, opacity: 0.45 }) +
    mark;

  const badgeColors = [palette.primary[0], s.accent, s.accentAlt];
  const badges = [-148, -18, 92]
    .map((angle, i) => badge(s, onEllipse(cx, cy, orbit, orbit, angle + jitter[i]), kinds[i], badgeColors[i]))
    .join("");

  const cards = s.byMode({
    wide: [
      passcodeCard(s, { x: cx - 43 * u, y: cy + 11 * u, w: 30 * u, h: 9.6 * u }, filled),
      settingsCard(s, { x: cx + 13 * u, y: cy - 30 * u, w: 25 * u, h: 13 * u }, secondOn),
    ],
    square: [
      passcodeCard(s, { x: cx - 42 * u, y: cy + 14 * u, w: 30 * u, h: 9.6 * u }, filled),
      settingsCard(s, { x: cx + 14 * u, y: cy - 34 * u, w: 25 * u, h: 13 * u }, secondOn),
    ],
    tall: [
      passcodeCard(s, { x: s.support.x + 1 * u, y: s.support.y - 2 * u, w: 40 * u, h: 11 * u }, filled),
      settingsCard(s, { x: s.support.x + s.support.w - 34 * u, y: s.support.y + 8 * u, w: 33 * u, h: 13.6 * u }, secondOn),
    ],
  });

  return rings + hero + badges + cards.join("");
};
