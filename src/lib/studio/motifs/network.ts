/**
 * Motif "network": a central hub wired to a ring of service tiles, with data packets travelling
 * along the links and a request card (code-like lines) plugged into the hub.
 */
import { mix } from "../palettes";
import { num } from "../svg-markup";
import { centerOf, type Box, type MotifPainter, type Point, type Scene } from "../scene";
import { onEllipse } from "./shared";

const TILE_GLYPHS = ["bars", "database", "code", "person", "document", "grid"] as const;
type TileGlyph = (typeof TILE_GLYPHS)[number];

function tileGlyph(s: Scene, kind: TileGlyph, cx: number, cy: number, size: number, color: string): string {
  const w = size;
  switch (kind) {
    case "bars":
      return [0.45, 0.75, 1]
        .map((h, i) => s.rect({ x: cx - w * 0.42 + i * w * 0.31, y: cy + w * 0.4 - w * 0.8 * h, w: w * 0.22, h: w * 0.8 * h }, w * 0.07, color))
        .join("");
    case "database":
      return [-1, 0, 1].map((row) => s.pill(cx - w * 0.42, cy + row * w * 0.3 - w * 0.11, w * 0.84, w * 0.22, color)).join("");
    case "code":
      return s.stroke(
        `M${num(cx - w * 0.16)} ${num(cy - w * 0.3)}L${num(cx - w * 0.44)} ${num(cy)}L${num(cx - w * 0.16)} ${num(cy + w * 0.3)}` +
          `M${num(cx + w * 0.16)} ${num(cy - w * 0.3)}L${num(cx + w * 0.44)} ${num(cy)}L${num(cx + w * 0.16)} ${num(cy + w * 0.3)}`,
        color,
        w * 0.15,
      );
    case "person":
      return s.avatar(cx, cy, w * 0.46, s.tint(color, 0.3), color);
    case "document":
      return (
        s.rect({ x: cx - w * 0.34, y: cy - w * 0.44, w: w * 0.68, h: w * 0.88 }, w * 0.12, s.tint(color, 0.35)) +
        s.textLines(cx - w * 0.2, cy - w * 0.22, [w * 0.4, w * 0.4, w * 0.24], w * 0.1, w * 0.1, color)
      );
    case "grid":
      return [-1, 1]
        .flatMap((col) => [-1, 1].map((row) => s.rect({ x: cx + col * w * 0.24 - w * 0.17, y: cy + row * w * 0.24 - w * 0.17, w: w * 0.34, h: w * 0.34 }, w * 0.09, color)))
        .join("");
  }
}

function hub(s: Scene, cx: number, cy: number, r: number): string {
  const { palette } = s;
  const spokes = [-90, 30, 150]
    .map((angle) => {
      const [x, y] = onEllipse(cx, cy, r * 0.5, r * 0.5, angle);
      return s.stroke(`M${num(cx)} ${num(cy)}L${num(x)} ${num(y)}`, "#FFFFFF", r * 0.09) + s.disc(x, y, r * 0.13, "#FFFFFF");
    })
    .join("");
  return (
    s.disc(cx, cy, r * 1.62, palette.primary[0], { opacity: palette.dark ? 0.16 : 0.13 }) +
    s.disc(cx, cy, r * 1.3, palette.primary[0], { opacity: palette.dark ? 0.24 : 0.2 }) +
    s.shadow({ x: cx - r, y: cy - r, w: 2 * r, h: 2 * r }, r, 3) +
    s.disc(cx, cy, r, s.brand) +
    spokes +
    s.disc(cx, cy, r * 0.2, "#FFFFFF")
  );
}

function requestCard(s: Scene, box: Box, lines: readonly number[]): string {
  const { u, palette } = s;
  const tones = [palette.primary[0], s.accent, palette.mute, s.accentAlt, palette.mute];
  const rowH = (box.h - 8.4 * u) / lines.length;
  const rows = lines
    .map((width, i) => {
      const y = box.y + 6.6 * u + i * rowH;
      const indent = (i === 0 || i === lines.length - 1 ? 0 : 2.4) * u;
      return (
        s.disc(box.x + 3 * u, y + 0.6 * u, 0.5 * u, palette.mute) +
        s.pill(box.x + 5.4 * u + indent, y, (box.w - 9 * u) * width, 1.3 * u, tones[i % tones.length])
      );
    })
    .join("");
  return (
    s.card(box, { depth: 3 }) +
    [0, 1, 2].map((i) => s.disc(box.x + 2.8 * u + i * 1.9 * u, box.y + 2.6 * u, 0.6 * u, palette.mute)).join("") +
    s.pill(box.x + box.w - 9.4 * u, box.y + 1.5 * u, 7 * u, 2.3 * u, s.tint(s.accent, palette.dark ? 0.32 : 0.2)) +
    s.disc(box.x + box.w - 7.9 * u, box.y + 2.65 * u, 0.6 * u, s.accent) +
    s.pill(box.x + box.w - 6.6 * u, box.y + 2.2 * u, 3 * u, 0.9 * u, s.accent) +
    rows
  );
}

export const paintNetwork: MotifPainter = (s) => {
  const { u, palette, rng, focal } = s;
  // Seeded variation first, in a fixed order, so every ratio shows the same network.
  const count = rng.int(5, 6);
  const glyphs = rng.shuffle(TILE_GLYPHS).slice(0, count);
  const nodes = Array.from({ length: count }, () => ({
    jitter: rng.range(-7, 7),
    reach: rng.range(0.86, 1),
    packet: rng.range(0.32, 0.7),
  }));
  const lines = [rng.range(0.4, 0.55), rng.range(0.55, 0.8), rng.range(0.35, 0.6), rng.range(0.5, 0.75), rng.range(0.2, 0.3)];

  const [fx, fy] = centerOf(focal);
  const center: Point = s.byMode<Point>({ wide: [fx + 5 * u, fy], square: [fx + 2 * u, fy - 3 * u], tall: [fx, fy] });
  const [cx, cy] = center;
  const hubR = s.byMode({ wide: 8.4, square: 8.4, tall: 10.4 }) * u;
  const rx = s.byMode({ wide: 36, square: 31, tall: 31 }) * u;
  const ry = s.byMode({ wide: 29, square: 31, tall: Math.min(37, focal.h / u / 2 - 7) }) * u;

  // The request card occupies one side of the hub; tiles are spread over the remaining arc.
  const gapCenter = s.byMode({ wide: 180, square: 135, tall: 90 });
  const gapHalf = s.byMode({ wide: 34, square: 36, tall: 40 });
  const cardBox: Box = s.byMode<Box>({
    wide: { x: cx - 68 * u, y: cy - 9 * u, w: 29 * u, h: 20 * u },
    square: { x: cx - 41 * u, y: cy + 21 * u, w: 29 * u, h: 20 * u },
    tall: { x: cx - 23 * u, y: s.support.y - 3 * u, w: 46 * u, h: 24 * u },
  });
  const plug: Point = s.byMode<Point>({
    wide: [cardBox.x + cardBox.w, cardBox.y + cardBox.h / 2],
    square: [cardBox.x + cardBox.w * 0.7, cardBox.y],
    tall: [cx, cardBox.y],
  });

  const tones = [palette.primary[0], s.accent, s.accentAlt];
  const wire = mix(palette.line, palette.ink, palette.dark ? 0.3 : 0.2);
  const tileSize = s.byMode({ wide: 9.6, square: 9.6, tall: 11.4 }) * u;
  const placed = nodes.map((node, i) => {
    const angle = gapCenter + gapHalf + ((360 - 2 * gapHalf) * (i + 0.5)) / count + node.jitter;
    return { ...node, at: onEllipse(cx, cy, rx * node.reach, ry * node.reach, angle), tone: tones[i % tones.length], glyph: glyphs[i] };
  });

  const links =
    placed
      .map(({ at, packet, tone }) => {
        const x = cx + (at[0] - cx) * packet;
        const y = cy + (at[1] - cy) * packet;
        return (
          s.stroke(`M${num(cx)} ${num(cy)}L${num(at[0])} ${num(at[1])}`, wire, Math.max(1.5, 0.3 * u)) +
          s.disc(x, y, 1.5 * u, tone, { opacity: 0.25 }) +
          s.disc(x, y, 0.75 * u, tone)
        );
      })
      .join("") +
    s.stroke(`M${num(cx)} ${num(cy)}L${num(plug[0])} ${num(plug[1])}`, palette.primary[0], Math.max(2, 0.42 * u), {
      "stroke-dasharray": `${num(1.1 * u)} ${num(1.1 * u)}`,
    });

  const orbit =
    `M${num(cx - rx)} ${num(cy)}A${num(rx)} ${num(ry)} 0 1 0 ${num(cx + rx)} ${num(cy)}` +
    `A${num(rx)} ${num(ry)} 0 1 0 ${num(cx - rx)} ${num(cy)}Z`;
  const tiles = placed
    .map(({ at, tone, glyph }) => {
      const box: Box = { x: at[0] - tileSize / 2, y: at[1] - tileSize / 2, w: tileSize, h: tileSize };
      return s.card(box, { radius: tileSize * 0.27, depth: 2 }) + tileGlyph(s, glyph, at[0], at[1], tileSize * 0.44, tone);
    })
    .join("");

  return (
    s.stroke(orbit, palette.dark ? palette.mute : palette.primary[0], Math.max(1.2, 0.14 * u), {
      opacity: 0.4,
      "stroke-dasharray": `${num(0.7 * u)} ${num(1.2 * u)}`,
    }) +
    links +
    hub(s, cx, cy, hubR) +
    tiles +
    requestCard(s, cardBox, lines)
  );
};
