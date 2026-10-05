/**
 * Status tones — the six semantic colours of the product. Every status surface (pills, badges,
 * callouts, stepper nodes, confidence bars) picks from this one list so that amber always means
 * "funds held", emerald always means "verified / captured", and so on.
 */
export const STATUS_TONES = ["neutral", "info", "hold", "success", "review", "danger"] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

interface ToneClasses {
  /** Foreground: text and icons. AA on both the soft fill and on `surface`. */
  text: string;
  /** Soft background fill. */
  soft: string;
  /** Solid fill, for dots, bars and filled stepper nodes. */
  solid: string;
  /** Translucent border matching the tone. */
  line: string;
}

/* Class names are spelled out in full so Tailwind's scanner can see them. */
export const TONE_CLASSES: Record<StatusTone, ToneClasses> = {
  neutral: { text: "text-neutral", soft: "bg-neutral-soft", solid: "bg-neutral", line: "border-neutral/25" },
  info: { text: "text-info", soft: "bg-info-soft", solid: "bg-info", line: "border-info/25" },
  hold: { text: "text-hold", soft: "bg-hold-soft", solid: "bg-hold", line: "border-hold/30" },
  success: { text: "text-success", soft: "bg-success-soft", solid: "bg-success", line: "border-success/25" },
  review: { text: "text-review", soft: "bg-review-soft", solid: "bg-review", line: "border-review/25" },
  danger: { text: "text-danger", soft: "bg-danger-soft", solid: "bg-danger", line: "border-danger/25" },
};
