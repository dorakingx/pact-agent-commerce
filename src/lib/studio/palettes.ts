/**
 * The studio's colour systems. Each palette is a complete, restrained scheme (a canvas, two
 * surface tones, one brand gradient and two accents), so every illustration rendered with the
 * same palette reads as part of one set regardless of its motif.
 */

export const PALETTES = ["aurora", "cobalt", "ember", "lagoon", "orchid", "graphite"] as const;
export type PaletteName = (typeof PALETTES)[number];

export interface Palette {
  /** Dark canvases need lighter hairlines and heavier shadows to keep depth readable. */
  dark: boolean;
  /** Canvas gradient, top-left to bottom-right. */
  canvas: readonly [string, string];
  /** Two soft colour fields behind the focal group. */
  glow: readonly [string, string];
  /** Card fill. */
  surface: string;
  /** Inset panels and secondary cards. */
  surfaceAlt: string;
  /** Hairlines and card borders. */
  line: string;
  /** Skeleton marks that stand in for text. */
  mute: string;
  /** Strongest neutral: headings-as-bars, icons. */
  ink: string;
  /** Brand gradient, light to deep. */
  primary: readonly [string, string];
  accent: string;
  accentAlt: string;
  shadow: string;
}

export const PALETTE_SPECS: Readonly<Record<PaletteName, Palette>> = {
  aurora: {
    dark: true,
    canvas: ["#0B1030", "#1B1450"],
    glow: ["#6D5BFF", "#22D3EE"],
    surface: "#1C2250",
    surfaceAlt: "#283066",
    line: "#3B4488",
    mute: "#4D58A0",
    ink: "#EEF0FF",
    primary: ["#9D8CFF", "#5B46F0"],
    accent: "#2DD4F0",
    accentAlt: "#FF7AB8",
    shadow: "#03051A",
  },
  cobalt: {
    dark: false,
    canvas: ["#F4F8FF", "#D9E6FF"],
    glow: ["#8FB4FF", "#A5F0F8"],
    surface: "#FFFFFF",
    surfaceAlt: "#EDF3FF",
    line: "#D3DEF5",
    mute: "#C2CFEA",
    ink: "#12224F",
    primary: ["#5C96FF", "#2253E0"],
    accent: "#FFAE1F",
    accentAlt: "#14BFA0",
    shadow: "#1C2D66",
  },
  ember: {
    dark: false,
    canvas: ["#FFF7EE", "#FFE1CC"],
    glow: ["#FFA47A", "#FFD56B"],
    surface: "#FFFFFF",
    surfaceAlt: "#FFF0E4",
    line: "#F2D8C4",
    mute: "#EAC9B2",
    ink: "#3D1C2B",
    primary: ["#FF8562", "#E2434B"],
    accent: "#7B3FE4",
    accentAlt: "#F5B100",
    shadow: "#5E2B1B",
  },
  lagoon: {
    dark: false,
    canvas: ["#EFFCF9", "#CFF2EA"],
    glow: ["#6BE8D4", "#9CC8FF"],
    surface: "#FFFFFF",
    surfaceAlt: "#E4F7F2",
    line: "#C6E8DF",
    mute: "#B0DAD0",
    ink: "#083B3A",
    primary: ["#22C3B0", "#0B7A70"],
    accent: "#FF7A1A",
    accentAlt: "#3B82F6",
    shadow: "#0A3D38",
  },
  orchid: {
    dark: false,
    canvas: ["#FAF5FF", "#E8DBFF"],
    glow: ["#C9A8FF", "#FFB5DA"],
    surface: "#FFFFFF",
    surfaceAlt: "#F3EBFF",
    line: "#DFD0FA",
    mute: "#D1C0F2",
    ink: "#2B1654",
    primary: ["#AE78FF", "#6A36DC"],
    accent: "#FF5C95",
    accentAlt: "#1FB6CF",
    shadow: "#301A62",
  },
  graphite: {
    dark: true,
    canvas: ["#0C0E11", "#1B1F26"],
    glow: ["#34D399", "#5EA2FF"],
    surface: "#1D2128",
    surfaceAlt: "#292E37",
    line: "#3A404C",
    mute: "#4C5463",
    ink: "#F3F5F8",
    primary: ["#5BE38F", "#18A552"],
    accent: "#FACC15",
    accentAlt: "#6AA8FF",
    shadow: "#000000",
  },
};

function channel(hex: string, index: number): number {
  return Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
}

/**
 * Blend two "#RRGGBB" colours (t = 0 gives `from`, t = 1 gives `to`). Tints are computed as
 * solid colours instead of opacity so that overlapping shapes never show through each other.
 */
export function mix(from: string, to: string, t: number): string {
  const clamped = Math.min(1, Math.max(0, t));
  const blended = [0, 1, 2].map((i) => {
    const value = Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * clamped);
    return value.toString(16).padStart(2, "0");
  });
  return `#${blended.join("").toUpperCase()}`;
}
