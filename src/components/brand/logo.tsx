import { cn } from "@/components/ui/cn";
import { MARK_CHECK, MARK_PARTY_A, MARK_PARTY_B, MARK_STROKE_WIDTH, MARK_VIEWBOX } from "./mark";

export interface PactMarkProps extends Omit<React.ComponentProps<"svg">, "children"> {
  /** Rendered size in px (the mark is square). */
  size?: number;
  /** Accessible name. Omit when the mark sits next to the wordmark or other text (decorative). */
  title?: string;
  /** `brand`: frame in the text colour, check in the accent. `mono`: everything in `currentColor`. */
  tone?: "brand" | "mono";
}

/** The PACT mark: two parties closing around one verified deal. Legible from 16px. */
export function PactMark({ size = 24, title, tone = "brand", className, ...props }: PactMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={MARK_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={MARK_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={cn("shrink-0", className)}
      {...props}
    >
      <path d={MARK_PARTY_A} />
      <path d={MARK_PARTY_B} />
      <path d={MARK_CHECK} className={tone === "brand" ? "stroke-accent" : undefined} />
    </svg>
  );
}

export interface PactLogoProps extends Omit<React.ComponentProps<"span">, "children"> {
  size?: "sm" | "md" | "lg";
  tone?: "brand" | "mono";
}

const LOGO_SIZE = {
  sm: { mark: 18, text: "text-[14px]", gap: "gap-1.5" },
  md: { mark: 22, text: "text-[16px]", gap: "gap-2" },
  lg: { mark: 30, text: "text-[22px]", gap: "gap-2.5" },
} as const;

/** Mark + wordmark lockup. The wordmark is real text, so the logo has an accessible name. */
export function PactLogo({ size = "md", tone = "brand", className, ...props }: PactLogoProps) {
  const s = LOGO_SIZE[size];
  return (
    <span className={cn("inline-flex items-center text-fg select-none", s.gap, className)} {...props}>
      <PactMark size={s.mark} tone={tone} />
      <span className={cn("leading-none font-semibold tracking-[0.08em]", s.text)}>PACT</span>
    </span>
  );
}
