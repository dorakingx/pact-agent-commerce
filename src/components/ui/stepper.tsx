import { Check, Minus, X } from "lucide-react";
import { cn } from "./cn";
import type { StatusTone } from "./tone";

export const STEP_STATES = ["done", "current", "upcoming", "failed", "skipped"] as const;
export type StepState = (typeof STEP_STATES)[number];

export interface StepperStep {
  /** Stable key. */
  id: string;
  label: React.ReactNode;
  /** Secondary line: a timestamp, an amount, a reason. */
  description?: React.ReactNode;
  state: StepState;
  /**
   * Colour of a `done` or `current` step. Defaults to `success`. Use `hold` for a reached
   * AUTHORIZED step: funds are held, which is not the same as settled.
   */
  tone?: Extract<StatusTone, "success" | "hold" | "info" | "review">;
  /** Replaces the default glyph inside the node, e.g. `<Lock />`. */
  icon?: React.ReactNode;
}

export interface StepperProps extends Omit<React.ComponentProps<"ol">, "children"> {
  steps: readonly StepperStep[];
  orientation?: "horizontal" | "vertical";
  size?: "sm" | "md";
}

/** Spoken after the label so the state is never conveyed by colour or glyph alone. */
const STATE_TEXT: Record<StepState, string> = {
  done: "completed",
  current: "current step",
  upcoming: "not started",
  failed: "failed",
  skipped: "skipped",
};

type ActiveTone = NonNullable<StepperStep["tone"]>;

/** `solid` fills a done node; `ring` outlines the current one. */
const TONE_NODE: Record<ActiveTone, { solid: string; ring: string }> = {
  success: { solid: "border-success bg-success text-on-accent", ring: "border-success text-success" },
  hold: { solid: "border-hold bg-hold text-surface", ring: "border-hold text-hold" },
  info: { solid: "border-info bg-info text-surface", ring: "border-info text-info" },
  review: { solid: "border-review bg-review text-surface", ring: "border-review text-review" },
};

function nodeClass(step: StepperStep): string {
  const tone = TONE_NODE[step.tone ?? "success"];
  switch (step.state) {
    case "done":
      return tone.solid;
    case "current":
      return cn("bg-surface", tone.ring);
    case "failed":
      return "border-danger-solid bg-danger-solid text-on-danger";
    case "skipped":
      return "border-dashed border-hairline-strong bg-surface text-faint";
    case "upcoming":
      return "border-hairline-strong bg-surface text-faint";
    default: {
      const exhaustive: never = step.state;
      return exhaustive;
    }
  }
}

function NodeGlyph({ step, index }: { step: StepperStep; index: number }) {
  if (step.icon) return <>{step.icon}</>;
  switch (step.state) {
    case "done":
      return <Check strokeWidth={3} />;
    case "failed":
      return <X strokeWidth={3} />;
    case "skipped":
      return <Minus strokeWidth={3} />;
    case "current":
      return <span className="block size-2 animate-pulse-dot rounded-full bg-current" />;
    case "upcoming":
      return <span className="font-mono text-[10px] leading-none font-medium">{index + 1}</span>;
    default: {
      const exhaustive: never = step.state;
      return exhaustive;
    }
  }
}

const REACHED: readonly StepState[] = ["done", "current", "failed"];

/**
 * A connector is "travelled" when the flow got past it, i.e. some later step was reached. Looking
 * ahead (rather than at the step itself) keeps the line continuous across a skipped step.
 */
function isTravelled(steps: readonly StepperStep[], index: number): boolean {
  return steps.slice(index + 1).some((step) => REACHED.includes(step.state));
}

/**
 * Progress rail. Rendered as an ordered list; the current step carries `aria-current="step"`
 * and every step announces its state as text.
 *
 * Horizontal rails need roughly 96px per step; switch to `orientation="vertical"` on narrow
 * containers, or wrap the rail in a horizontally scrollable element.
 */
export function Stepper({ steps, orientation = "horizontal", size = "md", className, ...props }: StepperProps) {
  const horizontal = orientation === "horizontal";
  const node = size === "sm" ? "size-5 [&_svg]:size-3" : "size-6 [&_svg]:size-3.5";
  // Half of the node size: where the connector line has to sit to pass through node centres.
  const half = size === "sm" ? "0.625rem" : "0.75rem";

  return (
    <ol
      data-orientation={orientation}
      className={cn("flex", horizontal ? "w-full flex-row" : "flex-col", className)}
      {...props}
    >
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        const emphasised = step.state === "current" || step.state === "failed";
        return (
          <li
            key={step.id}
            aria-current={step.state === "current" ? "step" : undefined}
            data-state={step.state}
            className={cn("relative flex min-w-0", horizontal ? "flex-1 flex-col items-center px-1 text-center" : "gap-3 pb-5 last:pb-0")}
          >
            {last ? null : (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute",
                  isTravelled(steps, index) ? "bg-success" : "bg-hairline-strong",
                  horizontal ? "h-0.5 -translate-y-1/2" : "w-0.5 -translate-x-1/2",
                )}
                style={
                  horizontal
                    ? { top: half, left: `calc(50% + ${half} + 4px)`, right: `calc(-50% + ${half} + 4px)` }
                    : { left: half, top: `calc(${half} * 2 + 4px)`, bottom: "4px" }
                }
              />
            )}
            <span
              aria-hidden="true"
              className={cn(
                "relative z-10 flex shrink-0 items-center justify-center rounded-full border-[1.5px]",
                node,
                nodeClass(step),
              )}
            >
              <NodeGlyph step={step} index={index} />
            </span>
            <span className={cn("flex min-w-0 flex-col", horizontal ? "mt-2 items-center" : "pt-0.5")}>
              <span
                className={cn(
                  "leading-5",
                  size === "sm" ? "text-xs" : "text-[13px]",
                  emphasised ? "font-semibold text-fg" : step.state === "done" ? "font-medium text-fg" : "font-medium text-muted",
                  step.state === "failed" && "text-danger",
                )}
              >
                {step.label}
                <span className="sr-only"> ({STATE_TEXT[step.state]})</span>
              </span>
              {step.description ? (
                <span className={cn("text-muted", size === "sm" ? "text-[11px] leading-4" : "text-xs leading-5")}>
                  {step.description}
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
