import { cn } from "./cn";
import { TONE_CLASSES, type StatusTone } from "./tone";

export interface StatusPillProps extends React.ComponentProps<"span"> {
  tone?: StatusTone;
  /** Replaces the dot with an icon element, e.g. `<Lock />`. */
  icon?: React.ReactNode;
  /** Animates the dot to signal that the state is live / in progress. */
  pulse?: boolean;
  size?: "sm" | "md";
}

/**
 * Lifecycle state as a pill: tone colour + dot (or icon) + text. The text is mandatory so that
 * colour is never the only signal.
 */
export function StatusPill({ tone = "neutral", icon, pulse = false, size = "md", className, children, ...props }: StatusPillProps) {
  const t = TONE_CLASSES[tone];
  return (
    <span
      data-tone={tone}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border font-medium whitespace-nowrap",
        size === "sm" ? "h-[22px] gap-1.5 px-2 text-xs" : "h-[26px] gap-1.5 px-2.5 text-[13px]",
        t.soft,
        t.text,
        t.line,
        "[&_svg]:size-3.5 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {icon ?? (
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 rounded-full bg-current", pulse && "animate-pulse-dot")}
        />
      )}
      {children}
    </span>
  );
}
