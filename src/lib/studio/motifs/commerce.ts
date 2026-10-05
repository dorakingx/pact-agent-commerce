/**
 * Motif "commerce": a checkout receipt with line items and a pay button, a payment card
 * tilted across its corner, a "paid" badge and a shopping-bag tile.
 */
import { mix } from "../palettes";
import { el, num } from "../svg-markup";
import { centerOf, type Box, type MotifPainter, type Point, type Scene } from "../scene";

function receipt(s: Scene, box: Box, items: number, widths: readonly number[]): string {
  const { u, palette } = s;
  const pad = 2.8 * u;
  const inner = box.w - 2 * pad;
  const tones = [palette.primary[0], s.accent, s.accentAlt];
  const rowsTop = box.y + 9.4 * u;
  const rowH = 6.6 * u;
  const rows = Array.from({ length: items }, (_, i) => {
    const y = rowsTop + i * rowH;
    return (
      s.rect({ x: box.x + pad, y, w: 4.8 * u, h: 4.8 * u }, 1.2 * u, s.tint(tones[i % tones.length], palette.dark ? 0.45 : 0.3)) +
      s.pill(box.x + pad + 6.6 * u, y + 0.8 * u, inner * widths[i % widths.length], 1.3 * u, palette.ink, { opacity: 0.8 }) +
      s.pill(box.x + pad + 6.6 * u, y + 3 * u, inner * 0.2, 1 * u, palette.mute) +
      s.pill(box.x + box.w - pad - 4.6 * u, y + 0.8 * u, 4.6 * u, 1.3 * u, palette.ink, { opacity: 0.55 })
    );
  }).join("");
  const ruleY = rowsTop + items * rowH + 0.4 * u;
  const buttonY = box.y + box.h - pad - 5 * u;
  return (
    s.card(box, { radius: 2.6 * u, depth: 4 }) +
    s.disc(box.x + pad + 1.9 * u, box.y + pad + 1.9 * u, 1.9 * u, s.brand) +
    s.pill(box.x + pad + 5.6 * u, box.y + pad + 0.5 * u, inner * 0.4, 1.5 * u, palette.ink, { opacity: 0.88 }) +
    s.pill(box.x + pad + 5.6 * u, box.y + pad + 2.6 * u, inner * 0.24, 1 * u, palette.mute) +
    rows +
    s.stroke(`M${num(box.x + pad)} ${num(ruleY)}H${num(box.x + box.w - pad)}`, palette.line, Math.max(1.2, 0.16 * u), {
      "stroke-dasharray": `${num(0.9 * u)} ${num(0.9 * u)}`,
    }) +
    s.pill(box.x + pad, ruleY + 2.2 * u, inner * 0.22, 1.2 * u, palette.mute) +
    s.pill(box.x + box.w - pad - 9 * u, ruleY + 1.8 * u, 9 * u, 2 * u, palette.ink, { opacity: 0.9 }) +
    s.pill(box.x + pad, buttonY, inner, 5 * u, s.brand) +
    s.pill(box.x + box.w / 2 - 4.4 * u, buttonY + 1.95 * u, 8.8 * u, 1.1 * u, "#FFFFFF", { opacity: 0.92 })
  );
}

function payCard(s: Scene, box: Box): string {
  const { u } = s;
  const radius = 2.4 * u;
  const outline = el("rect", { x: box.x, y: box.y, width: box.w, height: box.h, rx: radius });
  const inside = s.clip(outline);
  const chip: Box = { x: box.x + 3 * u, y: box.y + 6.4 * u, w: 5 * u, h: 3.8 * u };
  const waves = [0, 1, 2]
    .map((i) => {
      const r = (1.1 + i * 1.1) * u;
      const cx = chip.x + chip.w + 2.2 * u;
      const cy = chip.y + chip.h / 2;
      return s.stroke(
        `M${num(cx + r * 0.7)} ${num(cy - r * 0.7)}A${num(r)} ${num(r)} 0 0 1 ${num(cx + r * 0.7)} ${num(cy + r * 0.7)}`,
        "#FFFFFF",
        0.32 * u,
        { opacity: 0.75 },
      );
    })
    .join("");
  const digits = [0, 1, 2, 3]
    .map((i) => s.pill(box.x + 3 * u + i * 7.2 * u, box.y + box.h - 8.4 * u, 5.6 * u, 1.4 * u, "#FFFFFF", { opacity: 0.88 }))
    .join("");
  return (
    s.shadow(box, radius, 4) +
    s.rect(box, radius, s.brand) +
    s.group(
      [
        s.disc(box.x + box.w * 0.92, box.y + box.h * 0.1, box.h * 0.62, "#FFFFFF", { opacity: 0.1 }),
        s.disc(box.x + box.w * 0.72, box.y + box.h * 1.05, box.h * 0.5, "#FFFFFF", { opacity: 0.08 }),
      ],
      { "clip-path": inside },
    ) +
    s.pill(box.x + 3 * u, box.y + 2.6 * u, 8.6 * u, 1.5 * u, "#FFFFFF", { opacity: 0.9 }) +
    s.rect(chip, 0.9 * u, mix(s.accentAlt, "#FFFFFF", 0.55)) +
    s.stroke(
      `M${num(chip.x)} ${num(chip.y + chip.h / 2)}H${num(chip.x + chip.w)}M${num(chip.x + chip.w / 2)} ${num(chip.y)}V${num(chip.y + chip.h)}`,
      s.accentAlt,
      0.18 * u,
      { opacity: 0.8 },
    ) +
    waves +
    digits +
    s.pill(box.x + 3 * u, box.y + box.h - 4.6 * u, 10 * u, 1.1 * u, "#FFFFFF", { opacity: 0.6 }) +
    s.disc(box.x + box.w - 7.6 * u, box.y + box.h - 4.4 * u, 2.5 * u, "#FFFFFF", { opacity: 0.9 }) +
    s.disc(box.x + box.w - 4.6 * u, box.y + box.h - 4.4 * u, 2.5 * u, s.accent, { opacity: 0.92 })
  );
}

function bagTile(s: Scene, box: Box, count: number): string {
  const { u, palette } = s;
  const cx = box.x + box.w / 2;
  const bag: Box = { x: cx - box.w * 0.24, y: box.y + box.h * 0.4, w: box.w * 0.48, h: box.h * 0.38 };
  const handle = `M${num(cx - bag.w * 0.26)} ${num(bag.y + 0.4 * u)}V${num(bag.y - bag.w * 0.14)}A${num(bag.w * 0.26)} ${num(bag.w * 0.26)} 0 0 1 ${num(cx + bag.w * 0.26)} ${num(bag.y - bag.w * 0.14)}V${num(bag.y + 0.4 * u)}`;
  const dots = Array.from({ length: count }, (_, i) =>
    s.disc(cx + (i - (count - 1) / 2) * 1.5 * u, bag.y + bag.h * 0.55, 0.45 * u, "#FFFFFF", { opacity: 0.9 }),
  ).join("");
  return (
    s.card(box, { radius: 3 * u, depth: 3 }) +
    s.stroke(handle, palette.primary[1], 0.5 * u) +
    s.rect(bag, 1.1 * u, s.brand) +
    dots +
    s.disc(box.x + box.w - 1.4 * u, box.y + 1.4 * u, 2.3 * u, s.accent, { stroke: palette.surface, "stroke-width": 0.5 * u }) +
    s.plus(box.x + box.w - 1.4 * u, box.y + 1.4 * u, 0.9 * u, "#FFFFFF")
  );
}

function statusCard(s: Scene, box: Box, progress: number): string {
  const { u, palette } = s;
  const cy = box.y + box.h / 2;
  const trackX = box.x + 9 * u;
  const trackW = box.w - 11.4 * u;
  return (
    s.card(box, { radius: 2.6 * u, depth: 3 }) +
    s.checkBadge(box.x + 4.6 * u, cy, 2.4 * u, s.accent) +
    s.pill(trackX, cy - 2.6 * u, trackW * 0.55, 1.4 * u, palette.ink, { opacity: 0.85 }) +
    s.pill(trackX, cy + 0.8 * u, trackW, 1.6 * u, palette.surfaceAlt) +
    s.pill(trackX, cy + 0.8 * u, trackW * progress, 1.6 * u, s.brand)
  );
}

export const paintCommerce: MotifPainter = (s) => {
  const { u, palette, rng, focal } = s;
  // Seeded variation first, in a fixed order, so every ratio shows the same checkout.
  const items = rng.int(2, 3);
  const widths = [rng.range(0.3, 0.42), rng.range(0.24, 0.36), rng.range(0.3, 0.4)];
  const cardTilt = rng.range(-12, -7);
  const bagCount = rng.int(2, 3);
  const progress = rng.range(0.55, 0.85);

  const [fx, fy] = centerOf(focal);
  const baseH = (items === 3 ? 46 : 40) * u;
  // Portrait canvases have the height for a larger receipt, as long as it stays inside the focal area.
  const scale = s.byMode({ wide: 1.22, square: 1.12, tall: Math.min(1.45, (focal.h - 6 * u) / baseH) });
  const size = { w: 31 * u * scale, h: baseH * scale };
  const cardSize = { w: 35 * u * scale, h: 22 * u * scale };
  const overhang = cardSize.w * 0.6;
  // Receipt and card are centred as one group: the card hangs off the receipt's lower-left corner.
  const left = fx - (overhang + size.w) / 2 + s.byMode({ wide: 2 * u, square: 0, tall: 0 });
  const top = s.byMode({ wide: fy, square: fy - 1 * u, tall: fy }) - size.h / 2 - cardSize.h * 0.14;
  const paper: Box = { x: left + overhang, y: top, ...size };
  const card: Box = { x: left, y: paper.y + paper.h - cardSize.h * 0.66, ...cardSize };
  const cardCenter: Point = centerOf(card);

  const badgeAt: Point = [paper.x + paper.w - 0.6 * u, paper.y + 0.8 * u];
  const paid =
    s.shadow({ x: badgeAt[0] - 4.4 * u, y: badgeAt[1] - 4.4 * u, w: 8.8 * u, h: 8.8 * u }, 4.4 * u, 2) +
    s.disc(badgeAt[0], badgeAt[1], 4.9 * u, palette.surface) +
    s.checkBadge(badgeAt[0], badgeAt[1], 4 * u, s.accent);

  const extras = s.byMode({
    wide: [bagTile(s, { x: paper.x + paper.w + 4 * u, y: paper.y + paper.h - 24 * u, w: 15 * u, h: 15 * u }, bagCount)],
    square: [bagTile(s, { x: paper.x + paper.w - 5 * u, y: paper.y + paper.h - 9 * u, w: 15 * u, h: 15 * u }, bagCount)],
    tall: [
      bagTile(s, { x: s.support.x + 2 * u, y: s.support.y + 6 * u, w: 17 * u, h: 17 * u }, bagCount),
      statusCard(s, { x: s.support.x + s.support.w - 50 * u, y: s.support.y + 8.5 * u, w: 49 * u, h: 12 * u }, progress),
    ],
  });

  return (
    receipt(s, paper, items, widths) +
    paid +
    s.rotated(cardTilt, cardCenter[0], cardCenter[1], [payCard(s, card)]) +
    extras.join("")
  );
};
