/**
 * Motif "dashboard": a product window with navigation, KPI tiles and an area chart, with a
 * donut card and a confirmation toast floating in front of it.
 */
import { num } from "../svg-markup";
import type { Box, MotifPainter, Scene } from "../scene";
import { arc, fitBox, gridLines, plotPoints, risingSeries } from "./shared";

const NAV_WIDTHS = [0.62, 0.46, 0.7, 0.52, 0.4, 0.58] as const;

function titleBar(s: Scene, win: Box, height: number): string {
  const { u, palette } = s;
  const dots = [0, 1, 2]
    .map((i) => s.disc(win.x + 2.4 * u + i * 2 * u, win.y + height / 2, 0.6 * u, palette.mute))
    .join("");
  const address = s.pill(win.x + win.w * 0.36, win.y + height / 2 - 0.95 * u, win.w * 0.28, 1.9 * u, palette.surfaceAlt);
  const rule = s.stroke(`M${num(win.x)} ${num(win.y + height)}H${num(win.x + win.w)}`, palette.line, Math.max(1, u * 0.1));
  return dots + address + rule;
}

function sidebar(s: Scene, area: Box, navCount: number, active: number, rail: boolean): string {
  const { u, palette } = s;
  const rule = s.stroke(
    `M${num(area.x + area.w)} ${num(area.y)}V${num(area.y + area.h)}`,
    palette.line,
    Math.max(1, u * 0.1),
  );
  const logo = s.rect({ x: area.x + (rail ? area.w / 2 - 1.5 * u : 2.2 * u), y: area.y + 2.4 * u, w: 3 * u, h: 3 * u }, 0.9 * u, s.brand);
  const rows = Array.from({ length: navCount }, (_, i) => {
    const y = area.y + 9 * u + i * 4.4 * u;
    const isActive = i === active;
    const highlight = isActive
      ? s.rect({ x: area.x + 1.2 * u, y: y - 1.7 * u, w: area.w - 2.4 * u, h: 3.4 * u }, 1 * u, palette.surfaceAlt)
      : "";
    const iconX = rail ? area.x + area.w / 2 : area.x + 3.2 * u;
    const icon = s.disc(iconX, y, (rail ? 1 : 0.8) * u, isActive ? palette.primary[0] : palette.mute);
    const label = rail
      ? ""
      : s.pill(
          area.x + 5.2 * u,
          y - 0.6 * u,
          (area.w - 7.6 * u) * NAV_WIDTHS[i % NAV_WIDTHS.length],
          1.2 * u,
          isActive ? palette.ink : palette.mute,
          { opacity: isActive ? 0.85 : null },
        );
    return highlight + icon + label;
  }).join("");
  return rule + logo + rows;
}

function kpiTiles(s: Scene, row: Box, count: number, hot: number): string {
  const { u, palette } = s;
  const gap = 1.8 * u;
  const w = (row.w - gap * (count - 1)) / count;
  return Array.from({ length: count }, (_, i) => {
    const x = row.x + i * (w + gap);
    const isHot = i === hot % count;
    const tile = s.rect({ x, y: row.y, w, h: row.h }, 1.5 * u, isHot ? s.brand : palette.surfaceAlt);
    const label = s.pill(x + 1.8 * u, row.y + 2 * u, w * 0.36, 1.1 * u, isHot ? "#FFFFFF" : palette.mute, {
      opacity: isHot ? 0.7 : null,
    });
    const value = s.pill(x + 1.8 * u, row.y + row.h - 4.3 * u, w * 0.52, 2.2 * u, isHot ? "#FFFFFF" : palette.ink, {
      opacity: isHot ? null : 0.85,
    });
    const delta = s.pill(x + w - 5.6 * u, row.y + 1.6 * u, 3.8 * u, 1.9 * u, isHot ? "#FFFFFF" : s.accent, {
      opacity: isHot ? 0.3 : null,
    });
    return tile + label + value + delta;
  }).join("");
}

function areaChart(s: Scene, plot: Box, series: readonly number[], baseline: readonly number[]): string {
  const { u, palette } = s;
  const points = plotPoints(series, plot);
  const line = s.smooth(points);
  const area = `${line}L${num(plot.x + plot.w)} ${num(plot.y + plot.h)}L${num(plot.x)} ${num(plot.y + plot.h)}Z`;
  const marker = points[points.length - 3] ?? points[0];
  if (marker === undefined) return "";
  const guide = s.stroke(`M${num(marker[0])} ${num(marker[1])}V${num(plot.y + plot.h)}`, palette.primary[0], Math.max(1, u * 0.14), {
    "stroke-dasharray": `${num(u * 0.6)} ${num(u * 0.7)}`,
    opacity: 0.7,
  });
  const tooltipY = Math.max(plot.y - 1.2 * u, marker[1] - 5.6 * u);
  const tooltip =
    s.pill(marker[0] - 3.8 * u, tooltipY, 7.6 * u, 3.2 * u, palette.ink) +
    s.pill(marker[0] - 2.2 * u, tooltipY + 1.1 * u, 4.4 * u, 1 * u, palette.surface, { opacity: 0.9 });
  return (
    gridLines(s, plot, 4) +
    s.stroke(s.smooth(plotPoints(baseline, plot)), palette.mute, Math.max(1.2, u * 0.26), {
      "stroke-dasharray": `${num(u * 0.9)} ${num(u * 0.9)}`,
    }) +
    s.path(area, { fill: s.fade(palette.primary[0], palette.dark ? 0.42 : 0.3, 0) }) +
    s.stroke(line, palette.primary[0], 0.55 * u) +
    guide +
    s.disc(marker[0], marker[1], 1.15 * u, palette.surface, { stroke: palette.primary[0], "stroke-width": 0.5 * u }) +
    tooltip
  );
}

function progressRows(s: Scene, area: Box, rows: number, fills: readonly number[]): string {
  const { u, palette } = s;
  return Array.from({ length: rows }, (_, i) => {
    const y = area.y + (area.h * (i + 0.5)) / rows;
    const trackX = area.x + area.w * 0.3;
    const trackW = area.w * 0.7;
    return (
      s.pill(area.x, y - 0.6 * u, area.w * 0.2, 1.2 * u, palette.mute) +
      s.pill(trackX, y - 0.8 * u, trackW, 1.6 * u, palette.surfaceAlt) +
      s.pill(trackX, y - 0.8 * u, trackW * fills[i % fills.length], 1.6 * u, i === 0 ? s.brand : i === 1 ? s.accent : palette.primary[0], {
        opacity: i > 1 ? 0.55 : null,
      })
    );
  }).join("");
}

function donutCard(s: Scene, box: Box, share: number): string {
  const { u, palette } = s;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h * 0.47;
  const r = Math.min(box.w, box.h) * 0.27;
  const weight = r * 0.42;
  const legendY = box.y + box.h - 4.6 * u;
  return (
    s.card(box, { depth: 3 }) +
    s.pill(box.x + 2.2 * u, box.y + 2.4 * u, box.w * 0.42, 1.3 * u, palette.ink, { opacity: 0.8 }) +
    s.ring(cx, cy, r, palette.surfaceAlt, weight) +
    arc(s, cx, cy, r, 0, share, s.brand, weight) +
    arc(s, cx, cy, r, share + 0.03, share + 0.03 + (1 - share) * 0.55, s.accent, weight) +
    s.pill(cx - r * 0.42, cy - 0.8 * u, r * 0.84, 1.6 * u, palette.ink, { opacity: 0.8 }) +
    s.disc(box.x + 2.9 * u, legendY, 0.7 * u, palette.primary[0]) +
    s.pill(box.x + 4.4 * u, legendY - 0.55 * u, box.w * 0.22, 1.1 * u, palette.mute) +
    s.disc(box.x + box.w * 0.56, legendY, 0.7 * u, s.accent) +
    s.pill(box.x + box.w * 0.56 + 1.5 * u, legendY - 0.55 * u, box.w * 0.22, 1.1 * u, palette.mute)
  );
}

function toast(s: Scene, box: Box): string {
  const { u, palette } = s;
  const r = box.h * 0.29;
  return (
    s.card(box, { radius: box.h / 2, depth: 3 }) +
    s.checkBadge(box.x + box.h / 2, box.y + box.h / 2, r, s.accent) +
    s.textLines(box.x + box.h, box.y + box.h / 2 - 1.75 * u, [box.w * 0.42, box.w * 0.28], 1.25 * u, 1 * u, palette.mute)
  );
}

function barsCard(s: Scene, box: Box, fills: readonly number[]): string {
  const { u, palette } = s;
  return (
    s.card(box, { depth: 3 }) +
    s.pill(box.x + 2.2 * u, box.y + 2.4 * u, box.w * 0.34, 1.3 * u, palette.ink, { opacity: 0.8 }) +
    progressRows(s, { x: box.x + 2.2 * u, y: box.y + 5.4 * u, w: box.w - 4.4 * u, h: box.h - 7.4 * u }, 4, fills)
  );
}

export const paintDashboard: MotifPainter = (s) => {
  const { u, palette, rng, focal, mode } = s;
  // Seeded variation is drawn up front, in a fixed order, so every ratio shows the same dashboard.
  const navCount = rng.int(4, 6);
  const activeNav = rng.int(0, 2);
  const hotTile = rng.int(0, 2);
  const series = risingSeries(rng, 9);
  const baseline = series.map((value) => Math.max(0.05, value * rng.range(0.5, 0.72)));
  const share = rng.range(0.5, 0.7);
  const fills = [rng.range(0.6, 0.9), rng.range(0.4, 0.7), rng.range(0.3, 0.55), rng.range(0.15, 0.4)];

  const win = s.byMode({ wide: fitBox(focal, 1.42), square: fitBox(focal, 1.2), tall: focal });
  const barH = 4.4 * u;
  const rail = mode === "tall";
  const sideW = rail ? 7.5 * u : win.w * 0.19;
  const pad = 2.6 * u;
  const main: Box = { x: win.x + sideW + pad, y: win.y + barH + pad, w: win.w - sideW - 2 * pad, h: win.h - barH - 2 * pad };

  const header =
    s.pill(main.x, main.y + 0.3 * u, 15 * u, 1.8 * u, palette.ink, { opacity: 0.88 }) +
    s.pill(main.x, main.y + 3.2 * u, 9.5 * u, 1.2 * u, palette.mute) +
    s.pill(main.x + main.w - 14.6 * u, main.y + 0.6 * u, 9.6 * u, 3.3 * u, s.brand) +
    s.pill(main.x + main.w - 12 * u, main.y + 1.75 * u, 4.4 * u, 1 * u, "#FFFFFF", { opacity: 0.9 }) +
    s.avatar(main.x + main.w - 1.9 * u, main.y + 2.25 * u, 1.9 * u, s.tint(s.accent, 0.3), s.accent);

  const tiles: Box = { x: main.x, y: main.y + 7.2 * u, w: main.w, h: 10 * u };
  const chartTop = tiles.y + tiles.h + 3.4 * u;
  // Only a window with real height to spare gets the extra breakdown rows under the chart.
  const footerH = main.y + main.h - chartTop > 50 * u ? 17 * u : 0;
  const plot: Box = { x: main.x, y: chartTop, w: main.w, h: main.y + main.h - chartTop - footerH };
  const footer =
    footerH > 0 ? progressRows(s, { x: main.x, y: plot.y + plot.h + 3 * u, w: main.w, h: footerH - 3 * u }, 3, fills) : "";

  const windowMarkup =
    s.card(win, { radius: 2.6 * u, depth: 4 }) +
    titleBar(s, win, barH) +
    sidebar(s, { x: win.x, y: win.y + barH, w: sideW, h: win.h - barH }, navCount, activeNav, rail) +
    header +
    kpiTiles(s, tiles, rail ? 2 : 3, hotTile) +
    areaChart(s, plot, series, baseline) +
    footer;

  const donutSize = { w: 22 * u, h: 26 * u };
  const toastSize = { w: 25 * u, h: 8 * u };
  const floats = s.byMode({
    wide: [
      donutCard(s, { x: win.x - 12 * u, y: win.y + win.h - 20 * u, ...donutSize }, share),
      toast(s, { x: win.x + win.w - 17 * u, y: win.y - 3.6 * u, ...toastSize }),
    ],
    square: [
      donutCard(s, { x: win.x - 5 * u, y: win.y + win.h - 16 * u, ...donutSize }, share),
      toast(s, { x: win.x + win.w - 19 * u, y: win.y - 4 * u, ...toastSize }),
    ],
    tall: [
      toast(s, { x: win.x + win.w - 21 * u, y: win.y - 4 * u, ...toastSize }),
      donutCard(s, { x: s.support.x + 1 * u, y: s.support.y - 7 * u, ...donutSize }, share),
      barsCard(s, { x: s.support.x + s.support.w - 47 * u, y: s.support.y, w: 46 * u, h: 22 * u }, fills),
    ],
  });

  return windowMarkup + floats.join("");
};
