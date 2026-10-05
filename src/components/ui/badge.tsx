import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn";
import type { StatusTone } from "./tone";

const badgeVariants = cva(
  "inline-flex h-[22px] shrink-0 items-center gap-1 rounded-md border px-1.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "",
        info: "",
        hold: "",
        success: "",
        review: "",
        danger: "",
      } satisfies Record<StatusTone, string>,
      variant: { soft: "", outline: "bg-transparent" },
    },
    compoundVariants: [
      { variant: "soft", tone: "neutral", class: "border-transparent bg-neutral-soft text-neutral" },
      { variant: "soft", tone: "info", class: "border-transparent bg-info-soft text-info" },
      { variant: "soft", tone: "hold", class: "border-transparent bg-hold-soft text-hold" },
      { variant: "soft", tone: "success", class: "border-transparent bg-success-soft text-success" },
      { variant: "soft", tone: "review", class: "border-transparent bg-review-soft text-review" },
      { variant: "soft", tone: "danger", class: "border-transparent bg-danger-soft text-danger" },
      { variant: "outline", tone: "neutral", class: "border-hairline-strong text-muted" },
      { variant: "outline", tone: "info", class: "border-info/30 text-info" },
      { variant: "outline", tone: "hold", class: "border-hold/35 text-hold" },
      { variant: "outline", tone: "success", class: "border-success/30 text-success" },
      { variant: "outline", tone: "review", class: "border-review/30 text-review" },
      { variant: "outline", tone: "danger", class: "border-danger/30 text-danger" },
    ],
    defaultVariants: { tone: "neutral", variant: "soft" },
  },
);

export interface BadgeProps extends React.ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

/** A small static label (category, evaluator, "Demo fault"). For lifecycle state use `StatusPill`. */
export function Badge({ tone, variant, className, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone, variant }), className)} {...props} />;
}
