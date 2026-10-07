import { CircleAlert, Inbox } from "lucide-react";
import { cn } from "@/components/ui/cn";

export interface WidgetMessageProps {
  tone?: "neutral" | "danger";
  title: string;
  detail?: string;
  /** Replaces the default icon, e.g. a check for "nothing is waiting". */
  icon?: React.ReactNode;
  className?: string;
}

/** The empty and error state of a custom widget: centred, quiet, and sized to the widget rather than a page. */
export function WidgetMessage({ tone = "neutral", title, detail, icon, className }: WidgetMessageProps) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn("flex h-full min-h-24 flex-col items-center justify-center gap-1.5 px-4 py-5 text-center font-sans", className)}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex size-9 items-center justify-center rounded-full border [&_svg]:size-4",
          tone === "danger" ? "border-danger/25 bg-danger-soft text-danger" : "border-hairline bg-subtle text-muted",
        )}
      >
        {icon ?? (tone === "danger" ? <CircleAlert /> : <Inbox />)}
      </span>
      <p className="text-[13px] leading-5 font-semibold text-fg">{title}</p>
      {detail ? <p className="max-w-sm text-xs leading-[18px] text-muted">{detail}</p> : null}
    </div>
  );
}
