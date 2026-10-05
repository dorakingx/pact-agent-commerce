/**
 * Motif "growth": a bar chart whose trend line breaks out of the card as an arrow, with a KPI
 * card and a progress ring floating in front.
 */
import { num } from "../svg-markup";
import type { Box, MotifPainter, Point, Scene } from "../scene";
import { arc, fitBox, gridLines, risingSeries } from "./shared";

function kpiCard(s: Scene, box: Box, spark: readonly number[]): string {
  const { u, palette } = s;
  const plot: Box = { x: box.x + 2.4 * u, y: box.y + box.h - 5.6 * u, w: box.w - 4.8 * u, h: 3.4 * u };
  const points: Point[] = spark.map((value, i) => [plot.x + (plot.w * i) / (spark.length - 1), plot.y + plot.h * (1 - value)]);
  const chipX = box.x + box.w - 9.4 * u;
  return (
    s.card(box, { depth: 3 }) +
    s.pill(box.x + 2.4 * u, box.y + 2.4 * u, box.w * 0.3, 1.2 * u, palette.mute) +
    s.pill(box.x + 2.4 * u, box.y + 5 * u, box.w * 0.44, 2.8 * u, palette.ink, { opacity: 0.9 }) +
    s.pill(chipX, box.y + 5.1 * u, 7 * u, 2.6 * u, s.tint(s.accent, palette.dark ? 0.32 : 0.2)) +
    s.path(`M${num(chipX + 1.4 * u)} ${num(box.y + 6.9 * u)}L${num(chipX + 2.3 * u)} ${num(box.y + 5.8 * u)}L${num(chipX + 3.2 * u)} ${num(box.y + 6.9 * u)}Z`, {
      fill: s.accent,
    }) +
    s.pill(chipX + 3.8 * u, box.y + 5.9 * u, 2.2 * u, 1 * u, s.accent) +
    s.stroke(s.smooth(points), palette.primary[0], 0.42 * u)
  );
}

function ringCard(s: Scene, box: Box, value: number): string {
  const { palette } = s;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const r = box.w * 0.29;
  return (
    s.card(box, { depth: 3 }) +
    s.ring(cx, cy, r, palette.surfaceAlt, r * 0.36) +
    arc(s, cx, cy, r, 0, value, s.brand, r * 0.36) +
    s.pill(cx - r * 0.45, cy - r * 0.16, r * 0.9, r * 0.32, palette.ink, { opacity: 0.85 })
  );
}

export const paintGrowth: MotifPainter = (s) => {
  const { u, palette, rng, focal } = s;
  // Seeded variation first, in a fixed order, so every ratio shows the same chart.
  const count = rng.int(6, 8);
  const heights = risingSeries(rng, count);
  const spark = risingSeries(rng, 7);
  const ringValue = rng.range(0.62, 0.84);
  const activeRange = rng.int(0, 2);

  const chart = s.byMode({ wide: fitBox(focal, 1.36), square: fitBox(focal, 1.14), tall: focal });
  const pad = 3.2 * u;
  const header =
    s.pill(chart.x + pad, chart.y + pad, 17 * u, 1.9 * u, palette.ink, { opacity: 0.88 }) +
    s.pill(chart.x + pad, chart.y + pad + 3.2 * u, 10 * u, 1.2 * u, palette.mute) +
    [0, 1, 2]
      .map((i) =>
        s.pill(chart.x + pad + i * 7 * u, chart.y + pad + 6.8 * u, 5.8 * u, 2.6 * u, i === activeRange ? s.brand : palette.surfaceAlt),
      )
      .join("");

  const plot: Box = {
    x: chart.x + pad,
    y: chart.y + pad + 14 * u,
    w: chart.w - 2 * pad,
    h: chart.h - 2 * pad - 14 * u - 3.4 * u,
  };
  const slot = plot.w / count;
  const barW = slot * 0.54;
  const tops: Point[] = [];
  const bars = heights
    .map((value, i) => {
      const h = plot.h * (0.14 + 0.72 * value);
      const x = plot.x + slot * i + (slot - barW) / 2;
      const y = plot.y + plot.h - h;
      tops.push([x + barW / 2, y]);
      const recent = i >= count - 2;
      return (
        s.rect({ x, y, w: barW, h }, Math.min(1.2 * u, barW / 2), recent ? s.brand : s.tint(palette.primary[0], palette.dark ? 0.5 : 0.36)) +
        s.pill(x + barW * 0.15, plot.y + plot.h + 1.6 * u, barW * 0.7, 1 * u, palette.mute)
      );
    })
    .join("");

  // The trend floats above the bars and leaves the card through its top-right corner.
  const lift = 5.5 * u;
  const tip: Point = [chart.x + chart.w + 2.5 * u, Math.min(chart.y - 3 * u, tops[count - 1][1] - lift - 9 * u)];
  const trendPoints: Point[] = [...tops.map(([x, y]): Point => [x, y - lift]), tip];
  const last = trendPoints[trendPoints.length - 2];
  const direction = Math.atan2(tip[1] - last[1], tip[0] - last[0]);
  const head = (offset: number): Point => [
    tip[0] - Math.cos(direction + offset) * 3 * u,
    tip[1] - Math.sin(direction + offset) * 3 * u,
  ];
  const [left, right] = [head(0.5), head(-0.5)];
  const trend =
    s.disc(tip[0], tip[1], 6 * u, s.halo(s.accent, 0.45)) +
    s.stroke(s.smooth(trendPoints), s.accent, 0.75 * u) +
    s.stroke(`M${num(left[0])} ${num(left[1])}L${num(tip[0])} ${num(tip[1])}L${num(right[0])} ${num(right[1])}`, s.accent, 0.75 * u) +
    tops
      .filter((_, i) => i % 2 === 1 && i < count - 1)
      .map(([x, y]) => s.disc(x, y - lift, 0.95 * u, palette.surface, { stroke: s.accent, "stroke-width": 0.42 * u }))
      .join("");

  const kpiSize = { w: 25 * u, h: 15.5 * u };
  const ringSize = { w: 16 * u, h: 16 * u };
  const floats = s.byMode({
    wide: [
      kpiCard(s, { x: chart.x - 13 * u, y: chart.y + 21 * u, ...kpiSize }, spark),
      ringCard(s, { x: chart.x + chart.w - 11 * u, y: chart.y + chart.h - 12 * u, ...ringSize }, ringValue),
    ],
    square: [
      kpiCard(s, { x: chart.x - 7 * u, y: chart.y + 19 * u, ...kpiSize }, spark),
      ringCard(s, { x: chart.x + chart.w - 12 * u, y: chart.y + chart.h - 11 * u, ...ringSize }, ringValue),
    ],
    tall: [
      kpiCard(s, { x: s.support.x + 1 * u, y: s.support.y - 4 * u, w: 38 * u, h: 17 * u }, spark),
      ringCard(s, { x: s.support.x + s.support.w - 23 * u, y: s.support.y + 2 * u, w: 22 * u, h: 22 * u }, ringValue),
    ],
  });

  return s.card(chart, { radius: 2.6 * u, depth: 4 }) + header + gridLines(s, plot, 4) + bars + trend + floats.join("");
};
