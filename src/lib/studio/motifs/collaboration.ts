/**
 * Motif "collaboration": a shared board of cards being edited by several people at once —
 * live cursors, a selected card, a comment thread and a presence bar floating around it.
 */
import { num } from "../svg-markup";
import type { Box, MotifPainter, Scene } from "../scene";
import { fitBox } from "./shared";

/** How full each column is, as a share of the rows that fit; shuffled per seed. */
const COLUMN_LOADS = [1, 0.75, 0.5] as const;

function cursor(s: Scene, x: number, y: number, color: string, labelWidth: number): string {
  const { u } = s;
  const k = 0.9 * u;
  const arrow =
    `M${num(x)} ${num(y)}L${num(x)} ${num(y + 3.4 * k)}L${num(x + 0.95 * k)} ${num(y + 2.55 * k)}` +
    `L${num(x + 1.6 * k)} ${num(y + 4 * k)}L${num(x + 2.25 * k)} ${num(y + 3.7 * k)}` +
    `L${num(x + 1.62 * k)} ${num(y + 2.3 * k)}L${num(x + 2.9 * k)} ${num(y + 2.3 * k)}Z`;
  return (
    s.path(arrow, { fill: color, stroke: "#FFFFFF", "stroke-width": 0.22 * u, "stroke-linejoin": "round" }) +
    s.pill(x + 2.6 * k, y + 3.6 * k, labelWidth, 2.6 * u, color) +
    s.pill(x + 2.6 * k + 1.5 * u, y + 3.6 * k + 0.9 * u, labelWidth - 3 * u, 0.8 * u, "#FFFFFF", { opacity: 0.85 })
  );
}

function note(s: Scene, box: Box, color: string, selected: boolean): string {
  const { u, palette } = s;
  const frame = selected
    ? s.rect({ x: box.x - 0.7 * u, y: box.y - 0.7 * u, w: box.w + 1.4 * u, h: box.h + 1.4 * u }, 1.8 * u, "none", {
        stroke: s.accent,
        "stroke-width": 0.28 * u,
        "stroke-dasharray": `${num(0.9 * u)} ${num(0.7 * u)}`,
      })
    : "";
  return (
    s.rect(box, 1.3 * u, s.tint(color, palette.dark ? 0.3 : 0.16)) +
    s.pill(box.x + 1.4 * u, box.y + 1.4 * u, 4.2 * u, 1.3 * u, color) +
    s.pill(box.x + 1.4 * u, box.y + 3.8 * u, box.w * 0.66, 1.2 * u, palette.ink, { opacity: 0.7 }) +
    s.pill(box.x + 1.4 * u, box.y + 5.9 * u, box.w * 0.42, 1.2 * u, palette.ink, { opacity: 0.35 }) +
    s.disc(box.x + box.w - 2.2 * u, box.y + box.h - 2.2 * u, 1.1 * u, color, { opacity: 0.85 }) +
    frame
  );
}

function avatarStack(s: Scene, right: number, cy: number, r: number, colors: readonly string[]): string {
  const { u, palette } = s;
  return colors
    .map((color, i) => {
      const cx = right - r - i * r * 1.45;
      return s.disc(cx, cy, r + 0.35 * u, palette.surface) + s.avatar(cx, cy, r, s.tint(color, 0.32), color);
    })
    .reverse()
    .join("");
}

function commentCard(s: Scene, box: Box, color: string): string {
  const { u, palette } = s;
  const r = 2.5 * u;
  return (
    s.card(box, { depth: 3 }) +
    s.avatar(box.x + 2.2 * u + r, box.y + 2.2 * u + r, r, s.tint(color, 0.32), color) +
    s.pill(box.x + 8.6 * u, box.y + 2.6 * u, box.w * 0.34, 1.4 * u, palette.ink, { opacity: 0.85 }) +
    s.textLines(box.x + 8.6 * u, box.y + 5.4 * u, [box.w * 0.54, box.w * 0.38], 1.2 * u, 1.1 * u, palette.mute) +
    s.pill(box.x + box.w - 8.6 * u, box.y + box.h - 4.4 * u, 6.4 * u, 2.6 * u, s.tint(s.accent, 0.22)) +
    s.disc(box.x + box.w - 6.9 * u, box.y + box.h - 3.1 * u, 0.7 * u, s.accent) +
    s.pill(box.x + box.w - 5.6 * u, box.y + box.h - 3.6 * u, 2.2 * u, 1 * u, s.accent)
  );
}

function presenceBar(s: Scene, box: Box, colors: readonly string[]): string {
  const { u, palette } = s;
  const cy = box.y + box.h / 2;
  return (
    s.card(box, { radius: box.h / 2, depth: 3 }) +
    avatarStack(s, box.x + 2 * u + 3 * 2.1 * u * 1.45 + 0.8 * u, cy, 2.1 * u, colors) +
    s.pill(box.x + box.w - 11.6 * u, cy - 1.7 * u, 9.6 * u, 3.4 * u, s.brand) +
    s.pill(box.x + box.w - 9.4 * u, cy - 0.5 * u, 5.2 * u, 1 * u, "#FFFFFF", { opacity: 0.9 }) +
    s.disc(box.x + box.w - 15 * u, cy, 0.8 * u, palette.mute)
  );
}

export const paintCollaboration: MotifPainter = (s) => {
  const { u, palette, rng, focal, mode } = s;
  // Seeded variation first, in a fixed order, so every ratio shows the same board.
  const loads = rng.shuffle(COLUMN_LOADS);
  const people = rng.shuffle([palette.primary[0], s.accent, s.accentAlt]);
  const selectedColumn = rng.int(0, 1);
  const cursorShift = [rng.range(0.25, 0.6), rng.range(0.3, 0.7)];

  const board = s.byMode({ wide: fitBox(focal, 1.42), square: fitBox(focal, 1.2), tall: focal });
  const pad = 3 * u;
  const columns = mode === "tall" ? 2 : 3;
  const headerY = board.y + pad;

  const header =
    s.rect({ x: board.x + pad, y: headerY, w: 3.6 * u, h: 3.6 * u }, 1 * u, s.brand) +
    s.pill(board.x + pad + 5.4 * u, headerY + 0.4 * u, 16 * u, 1.7 * u, palette.ink, { opacity: 0.88 }) +
    s.pill(board.x + pad + 5.4 * u, headerY + 2.7 * u, 9 * u, 1.1 * u, palette.mute) +
    s.stroke(`M${num(board.x)} ${num(headerY + 6.2 * u)}H${num(board.x + board.w)}`, palette.line, Math.max(1, 0.1 * u));

  const gap = 2 * u;
  const lanesTop = headerY + 8.6 * u;
  const laneW = (board.w - 2 * pad - gap * (columns - 1)) / columns;
  const noteH = (mode === "tall" ? 11.6 : 9.6) * u;
  const room = Math.max(1, Math.floor((board.y + board.h - pad - lanesTop - 3.6 * u + 1.6 * u) / (noteH + 1.6 * u)));
  const selectedBoxes: Box[] = [];
  const lanes = Array.from({ length: columns }, (_, column) => {
    const x = board.x + pad + column * (laneW + gap);
    const count = Math.max(1, Math.round(room * loads[column]));
    const title =
      s.pill(x, lanesTop, laneW * 0.4, 1.4 * u, palette.ink, { opacity: 0.6 }) +
      s.disc(x + laneW - 1 * u, lanesTop + 0.7 * u, 1 * u, palette.surfaceAlt);
    const notes = Array.from({ length: count }, (_, row) => {
      const box: Box = { x, y: lanesTop + 3.6 * u + row * (noteH + 1.6 * u), w: laneW, h: noteH };
      const selected = column === selectedColumn && row === 0;
      if (selected) selectedBoxes.push(box);
      return note(s, box, people[(column + row) % people.length], selected);
    }).join("");
    return title + notes;
  }).join("");

  const anchor = selectedBoxes[0] ?? { x: board.x + pad, y: lanesTop, w: laneW, h: noteH };
  const cursors =
    cursor(s, anchor.x + anchor.w * cursorShift[0], anchor.y + anchor.h * 0.72, s.accent, 8.4 * u) +
    cursor(
      s,
      board.x + board.w - pad - laneW * cursorShift[1],
      Math.min(board.y + board.h - 12 * u, lanesTop + 16 * u),
      palette.primary[1],
      7 * u,
    );

  const commentSize = { w: 27 * u, h: 12.5 * u };
  const presenceSize = { w: 29 * u, h: 7.4 * u };
  const floats = s.byMode({
    wide: [
      commentCard(s, { x: board.x - 15 * u, y: board.y + board.h - 22 * u, ...commentSize }, people[1]),
      presenceBar(s, { x: board.x + board.w - 20 * u, y: board.y - 3.6 * u, ...presenceSize }, people),
    ],
    square: [
      commentCard(s, { x: board.x - 6 * u, y: board.y + board.h - 8 * u, ...commentSize }, people[1]),
      presenceBar(s, { x: board.x + board.w - 23 * u, y: board.y - 4 * u, ...presenceSize }, people),
    ],
    tall: [
      commentCard(s, { x: s.support.x + 1 * u, y: s.support.y - 6 * u, w: 40 * u, h: 14 * u }, people[1]),
      presenceBar(s, { x: s.support.x + s.support.w - 37 * u, y: s.support.y + 12 * u, w: 36 * u, h: 9 * u }, people),
    ],
  });

  return s.card(board, { radius: 2.6 * u, depth: 4 }) + header + lanes + cursors + floats.join("");
};
