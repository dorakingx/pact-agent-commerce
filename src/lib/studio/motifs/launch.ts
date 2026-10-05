/**
 * Motif "launch": a rocket climbing off a curved horizon along a soft contrail, with a ringed
 * moon, a few stars and a release card showing the rollout in progress.
 */
import { mix } from "../palettes";
import { el, num } from "../svg-markup";
import { centerOf, type Box, type MotifPainter, type Point, type Scene } from "../scene";

/** Star positions as fractions of the canvas; the rocket and cards are avoided at paint time. */
const STAR_SLOTS: readonly Point[] = [
  [0.12, 0.12],
  [0.27, 0.2],
  [0.44, 0.09],
  [0.6, 0.16],
  [0.8, 0.1],
  [0.9, 0.3],
  [0.18, 0.4],
  [0.36, 0.34],
  [0.93, 0.56],
  [0.08, 0.62],
  [0.7, 0.36],
  [0.52, 0.3],
];

/** The rocket in its own coordinate system: nose up, `a` is half the body width. */
function rocket(s: Scene, a: number): string {
  const { palette } = s;
  const hull = palette.dark ? palette.ink : palette.surface;
  const metal = palette.dark ? palette.mute : mix(palette.ink, "#FFFFFF", 0.3);
  const n = (value: number): string => num(value * a);
  const body =
    `M0 ${n(-3)}C${n(0.9)} ${n(-2.2)} ${n(1)} ${n(-1.1)} ${n(1)} 0V${n(1.6)}H${n(-1)}V0` +
    `C${n(-1)} ${n(-1.1)} ${n(-0.9)} ${n(-2.2)} 0 ${n(-3)}Z`;
  const inside = s.clip(el("path", { d: body }));
  const fin = (side: 1 | -1): string =>
    el("path", {
      d: `M${n(side)} ${n(0.4)}C${n(1.9 * side)} ${n(0.9)} ${n(2.15 * side)} ${n(1.7)} ${n(2 * side)} ${n(2.4)}L${n(side)} ${n(1.6)}Z`,
      fill: palette.primary[1],
    });
  const flame = (scale: number, fill: string, opacity: number | null): string =>
    el("path", {
      d:
        `M${n(-0.44 * scale)} ${n(1.95)}C${n(-0.62 * scale)} ${n(1.95 + 1.05 * scale)} ${n(-0.2 * scale)} ${n(1.95 + 1.85 * scale)} 0 ${n(1.95 + 2.5 * scale)}` +
        `C${n(0.2 * scale)} ${n(1.95 + 1.85 * scale)} ${n(0.62 * scale)} ${n(1.95 + 1.05 * scale)} ${n(0.44 * scale)} ${n(1.95)}Z`,
      fill,
      opacity,
    });
  return (
    flame(1, s.linear(s.accent, mix(s.accent, "#FFFFFF", 0.35), "down"), null) +
    flame(0.52, "#FFFFFF", 0.85) +
    fin(1) +
    fin(-1) +
    el("path", { d: `M${n(-0.56)} ${n(1.6)}H${n(0.56)}L${n(0.42)} ${n(2.02)}H${n(-0.42)}Z`, fill: metal }) +
    el("path", { d: body, fill: hull }) +
    s.group(
      [
        el("rect", { x: 0, y: n(-3), width: n(1), height: n(4.6), fill: palette.shadow, opacity: 0.1 }),
        el("rect", { x: n(-1), y: n(-3), width: n(2), height: n(1.15), fill: s.accent }),
        el("rect", { x: n(-1), y: n(1.05), width: n(2), height: n(0.55), fill: palette.primary[0] }),
      ],
      { "clip-path": inside },
    ) +
    el("circle", { cx: 0, cy: n(-0.55), r: n(0.5), fill: s.brand, stroke: mix(hull, palette.shadow, 0.22), "stroke-width": n(0.16) }) +
    el("circle", { cx: n(-0.16), cy: n(-0.72), r: n(0.13), fill: "#FFFFFF", opacity: 0.8 })
  );
}

function moon(s: Scene, cx: number, cy: number, r: number, tilt: number, craters: readonly number[]): string {
  const body = s.linear(mix(s.accentAlt, "#FFFFFF", 0.45), s.accentAlt);
  const dent = mix(s.accentAlt, s.palette.shadow, 0.25);
  const ring = el("ellipse", {
    cx,
    cy,
    rx: r * 1.75,
    ry: r * 0.42,
    fill: "none",
    stroke: s.palette.dark ? s.palette.ink : s.palette.primary[1],
    "stroke-width": r * 0.11,
    opacity: 0.75,
  });
  // The top half of the moon is repainted over the ring so the ring passes behind it.
  const front = el("path", {
    d: `M${num(cx - r)} ${num(cy)}A${num(r)} ${num(r)} 0 0 1 ${num(cx + r)} ${num(cy)}Z`,
    fill: body,
  });
  return s.rotated(tilt, cx, cy, [
    s.disc(cx, cy, r, body),
    s.disc(cx + r * craters[0], cy + r * 0.38, r * 0.2, dent, { opacity: 0.45 }),
    ring,
    front,
    s.disc(cx + r * craters[1], cy - r * 0.4, r * 0.15, dent, { opacity: 0.45 }),
  ]);
}

function releaseCard(s: Scene, box: Box, progress: number): string {
  const { u, palette } = s;
  const trackY = box.y + box.h - 4.6 * u;
  const trackW = box.w - 10.4 * u;
  return (
    s.card(box, { depth: 3 }) +
    s.pill(box.x + 2.4 * u, box.y + 2.4 * u, 8.4 * u, 2.8 * u, s.brand) +
    s.pill(box.x + 4.2 * u, box.y + 3.3 * u, 4.8 * u, 1 * u, "#FFFFFF", { opacity: 0.9 }) +
    s.pill(box.x + 12.4 * u, box.y + 3.1 * u, box.w * 0.3, 1.4 * u, palette.ink, { opacity: 0.85 }) +
    s.textLines(box.x + 2.4 * u, box.y + 7.2 * u, [box.w * 0.62, box.w * 0.44], 1.2 * u, 1.2 * u, palette.mute) +
    s.pill(box.x + 2.4 * u, trackY, trackW, 1.8 * u, palette.surfaceAlt) +
    s.pill(box.x + 2.4 * u, trackY, trackW * progress, 1.8 * u, s.accent) +
    s.checkBadge(box.x + box.w - 4.4 * u, trackY + 0.9 * u, 2.2 * u, palette.primary[0])
  );
}

export const paintLaunch: MotifPainter = (s) => {
  const { u, palette, rng, focal, width, height } = s;
  // Seeded variation first, in a fixed order, so every ratio shows the same launch.
  const stars = rng.shuffle(STAR_SLOTS).slice(0, 8);
  const craters = [rng.range(-0.45, -0.05), rng.range(0, 0.4)];
  const progress = rng.range(0.58, 0.86);
  const tilt = rng.range(-4, 4);
  const moonTilt = rng.range(-28, -12);
  const puffs = [rng.range(0.8, 1.1), rng.range(0.6, 0.9), rng.range(0.9, 1.2), rng.range(0.5, 0.8)];

  const [fx, fy] = centerOf(focal);
  const a = s.byMode({ wide: 5.4, square: 5.6, tall: 7.4 }) * u;
  const angle = s.byMode({ wide: 40, square: 32, tall: 20 }) + tilt;
  const ship: Point = s.byMode<Point>({
    wide: [fx + 5 * u, fy - 5 * u],
    square: [fx + 4 * u, fy - 5 * u],
    tall: [fx + 6 * u, focal.y + focal.h * 0.44],
  });
  const radians = (angle * Math.PI) / 180;
  const heading: Point = [Math.sin(radians), -Math.cos(radians)];

  // The horizon: the top of a very large circle, so its curve stays gentle at every ratio.
  const horizon = s.byMode({ wide: 0.17, square: 0.15, tall: 0.12 }) * height;
  const planetR = Math.max(width, height) * 2.2;
  const planetX = width * 0.5;
  const planetY = height - horizon + planetR;
  const ground =
    s.disc(planetX, planetY, planetR + 2.2 * u, palette.primary[0], { opacity: 0.22 }) +
    s.disc(planetX, planetY, planetR, s.linear(palette.primary[0], palette.primary[1], "down"));

  const pad: Point = s.byMode<Point>({
    wide: [focal.x + 6 * u, height - horizon + 1.5 * u],
    square: [focal.x + 7 * u, height - horizon + 1.5 * u],
    tall: [focal.x + 9 * u, height - horizon + 1.5 * u],
  });
  const tail: Point = [ship[0] - heading[0] * 2.2 * a, ship[1] - heading[1] * 2.2 * a];
  const bend: Point = [tail[0] - heading[0] * 18 * u, tail[1] - heading[1] * 18 * u];
  const trailPath = `M${num(pad[0])} ${num(pad[1])}Q${num(bend[0])} ${num(bend[1])} ${num(tail[0])} ${num(tail[1])}`;
  const vapour = palette.dark ? palette.ink : "#FFFFFF";
  const trail =
    s.stroke(trailPath, s.fade(vapour, 0.1, palette.dark ? 0.5 : 0.95, "right"), 0.7 * a) +
    s.stroke(trailPath, palette.dark ? palette.ink : palette.primary[1], Math.max(1.5, 0.22 * u), {
      "stroke-dasharray": `${num(0.9 * u)} ${num(1.3 * u)}`,
      opacity: 0.55,
    });
  const cloud = [
    s.disc(pad[0] - 3.4 * u, pad[1] - 0.4 * u, 3 * u * puffs[0], vapour),
    s.disc(pad[0] + 0.6 * u, pad[1] - 2 * u, 3.6 * u * puffs[1], vapour),
    s.disc(pad[0] + 4.6 * u, pad[1] - 0.2 * u, 2.8 * u * puffs[2], vapour),
    s.disc(pad[0] + 8 * u, pad[1] + 0.6 * u, 2.2 * u * puffs[3], vapour),
  ].join("");

  const moonAt: Point = s.byMode<Point>({
    wide: [focal.x + 9 * u, focal.y + 10 * u],
    square: [focal.x + 9 * u, focal.y + 8 * u],
    tall: [focal.x + 13 * u, focal.y + 9 * u],
  });
  const moonR = s.byMode({ wide: 5.2, square: 5.4, tall: 6.4 }) * u;

  const cardBox: Box = s.byMode<Box>({
    wide: { x: s.support.x + 1 * u, y: height * 0.52, w: 28 * u, h: 17.5 * u },
    square: { x: focal.x + focal.w - 23 * u, y: focal.y + focal.h - 13 * u, w: 28 * u, h: 17.5 * u },
    tall: { x: focal.x + focal.w - 40 * u, y: s.support.y + 2 * u, w: 40 * u, h: 19 * u },
  });

  const sky = stars
    .map(([px, py], i) => {
      const x = px * width;
      const y = py * (height - horizon);
      const nearShip = Math.hypot(x - ship[0], y - ship[1]) < 5.6 * a;
      const nearMoon = Math.hypot(x - moonAt[0], y - moonAt[1]) < 2.6 * moonR;
      const onCard = x > cardBox.x - 3 * u && x < cardBox.x + cardBox.w + 3 * u && y > cardBox.y - 3 * u && y < cardBox.y + cardBox.h + 3 * u;
      if (nearShip || nearMoon || onCard) return "";
      const color = palette.dark ? palette.ink : i % 2 === 0 ? palette.primary[0] : s.accent;
      return i % 3 === 2 ? s.disc(x, y, 0.45 * u, color, { opacity: 0.8 }) : s.sparkle(x, y, (1 + (i % 3) * 0.5) * u, color, 0.9);
    })
    .join("");

  const shipMarkup = s.group([rocket(s, a)], {
    transform: `translate(${num(ship[0])} ${num(ship[1])}) rotate(${num(angle)})`,
  });

  return (
    sky +
    moon(s, moonAt[0], moonAt[1], moonR, moonTilt, craters) +
    ground +
    trail +
    cloud +
    shipMarkup +
    s.rotated(s.mode === "tall" ? 0 : -4, cardBox.x + cardBox.w / 2, cardBox.y + cardBox.h / 2, [releaseCard(s, cardBox, progress)])
  );
};
