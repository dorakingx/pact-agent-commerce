/**
 * Geometry of the PACT mark, on a 24×24 grid.
 *
 * Two half-frames (the two parties) close around a check (the verified delivery). The gaps sit
 * on a diagonal so the halves read as interlocking rather than as a split square. Kept as raw
 * path data so the React component, the Open Graph image and the favicon stay identical.
 */
export const MARK_VIEWBOX = "0 0 24 24";
export const MARK_STROKE_WIDTH = 2.2;
export const MARK_PARTY_A = "M11.5 3.5H8A4.5 4.5 0 0 0 3.5 8v8A4.5 4.5 0 0 0 8 20.5";
export const MARK_PARTY_B = "M12.5 20.5H16a4.5 4.5 0 0 0 4.5-4.5V8A4.5 4.5 0 0 0 16 3.5";
export const MARK_CHECK = "M8.6 12.3l2.4 2.4 4.5-5.1";

/** Brand colours that must not follow the theme (favicon, social image). */
export const BRAND = {
  ink: "#0B1220",
  emerald: "#0B7A5B",
  emeraldBright: "#34D399",
  paper: "#F2F4F7",
  slate: "#9AA4B2",
} as const;
