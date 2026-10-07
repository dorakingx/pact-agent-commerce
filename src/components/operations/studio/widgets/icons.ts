/**
 * Widget-menu icons for the PACT widgets, drawn on the same 32px grid and with the same theme
 * variables as Studio's own, so they sit in the widget picker as if they shipped with it.
 */
const LINE = "var(--ag-border-color, #b3b4b4)";
const FILL_A = "var(--ag-chart-palette-fills-1-color, #0b7a5b)";
const FILL_B = "var(--ag-chart-palette-fills-2-color, #b45309)";
const FILL_C = "var(--ag-chart-palette-fills-3-color, #b42318)";

const svg = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="none" viewBox="0 0 32 32">${body}</svg>`;

/** Three stations on a line, the last one filled: held, held, captured. */
export const RAIL_ICON = svg(
  `<path stroke="${LINE}" stroke-width="2" d="M5 16h22"/>` +
    `<circle cx="6" cy="16" r="4" fill="${FILL_B}"/><circle cx="16" cy="16" r="4" fill="${FILL_B}"/><circle cx="26" cy="16" r="4.5" fill="${FILL_A}"/>` +
    `<path stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="m24 16 1.5 1.5 2.5-3"/>`,
);

/** A stack of cards waiting for a person. */
export const QUEUE_ICON = svg(
  `<rect x="4" y="5" width="24" height="6" rx="1.5" fill="${FILL_B}"/>` +
    `<rect x="4" y="13" width="24" height="6" rx="1.5" fill="${FILL_B}" fill-opacity=".55"/>` +
    `<rect x="4" y="21" width="24" height="6" rx="1.5" fill="${FILL_B}" fill-opacity=".3"/>` +
    `<path fill="${LINE}" d="M0 0h1v32H0z"/>`,
);

/** A checklist: pass, pass, fail. */
export const VERDICT_ICON = svg(
  `<circle cx="7" cy="8" r="3" fill="${FILL_A}"/><circle cx="7" cy="16" r="3" fill="${FILL_A}"/><circle cx="7" cy="24" r="3" fill="${FILL_C}"/>` +
    `<path stroke="${LINE}" stroke-width="2" stroke-linecap="round" d="M13 8h15M13 16h15M13 24h10"/>`,
);
