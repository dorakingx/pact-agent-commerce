import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { cn } from "./cn";

export type CalloutTone = "info" | "warning" | "danger" | "success";

const TONE: Record<CalloutTone, { box: string; icon: string; glyph: React.ReactNode }> = {
  info: { box: "border-info/25 bg-info-soft", icon: "text-info", glyph: <Info /> },
  warning: { box: "border-hold/30 bg-hold-soft", icon: "text-hold", glyph: <TriangleAlert /> },
  danger: { box: "border-danger/25 bg-danger-soft", icon: "text-danger", glyph: <CircleAlert /> },
  success: { box: "border-success/25 bg-success-soft", icon: "text-success", glyph: <CircleCheck /> },
};

export interface CalloutProps extends Omit<React.ComponentProps<"div">, "title"> {
  tone?: CalloutTone;
  title?: React.ReactNode;
  /** Overrides the default tone icon. */
  icon?: React.ReactNode;
  /** Trailing action, e.g. a small button. */
  action?: React.ReactNode;
}

/**
 * Inline message attached to a piece of UI. `danger` and `warning` are announced immediately
 * (role="alert"); `info` and `success` are polite status messages.
 */
export function Callout({ tone = "info", title, icon, action, className, children, ...props }: CalloutProps) {
  const t = TONE[tone];
  return (
    <div
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
      className={cn("flex gap-3 rounded-card border px-4 py-3 text-sm leading-6 text-fg", t.box, className)}
      {...props}
    >
      <span aria-hidden="true" className={cn("mt-1 shrink-0 [&_svg]:size-4", t.icon)}>
        {icon ?? t.glyph}
      </span>
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={cn("text-fg/85", title && "mt-0.5")}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  );
}
