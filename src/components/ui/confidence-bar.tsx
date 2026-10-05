import { cn } from "./cn";
import { clamp01, formatPercent } from "./format";
import { TONE_CLASSES, type StatusTone } from "./tone";

export interface ConfidenceBarProps extends Omit<React.ComponentProps<"div">, "children"> {
  /** Confidence, 0–1. */
  value: number;
  /** Decision threshold, 0–1, drawn as a marker (e.g. the auto-capture minimum). */
  threshold?: number;
  /** Accessible name, e.g. "Verifier confidence". */
  label?: string;
  /** Print the percentage next to the bar. */
  showValue?: boolean;
  /** Overrides the automatic tone (success at or above the threshold, review below it). */
  tone?: StatusTone;
}

/**
 * A 0–1 score against a threshold. Below the threshold the bar turns violet ("a human should
 * look"); at or above it, emerald. The percentage and threshold are also exposed as text.
 */
export function ConfidenceBar({
  value,
  threshold,
  label = "Confidence",
  showValue = true,
  tone,
  className,
  ...props
}: ConfidenceBarProps) {
  const v = clamp01(value);
  const t = threshold === undefined ? undefined : clamp01(threshold);
  const resolved: StatusTone = tone ?? (t === undefined || v >= t ? "success" : "review");
  const valueText =
    t === undefined
      ? formatPercent(v)
      : `${formatPercent(v)}, ${v >= t ? "meets" : "below"} the ${formatPercent(t)} threshold`;

  return (
    <div className={cn("flex items-center gap-2.5", className)} {...props}>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(v * 100)}
        aria-valuetext={valueText}
        className="relative h-1.5 min-w-16 flex-1 rounded-full bg-subtle-strong"
      >
        <div
          className={cn("h-full rounded-full transition-[width] duration-200 ease-out", TONE_CLASSES[resolved].solid)}
          style={{ width: `${v * 100}%` }}
        />
        {t === undefined ? null : (
          <span
            aria-hidden="true"
            className="absolute -top-1 h-3.5 w-0.5 -translate-x-1/2 rounded-full bg-fg ring-2 ring-surface"
            style={{ left: `${t * 100}%` }}
          />
        )}
      </div>
      {showValue ? (
        <span aria-hidden="true" className={cn("w-9 shrink-0 text-right font-mono text-xs tabular-nums", TONE_CLASSES[resolved].text)}>
          {formatPercent(v)}
        </span>
      ) : null}
    </div>
  );
}
