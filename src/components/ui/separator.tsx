import { cn } from "./cn";

export interface SeparatorProps extends Omit<React.ComponentProps<"div">, "children"> {
  orientation?: "horizontal" | "vertical";
  /** Decorative separators are hidden from assistive technology (default). */
  decorative?: boolean;
}

export function Separator({ orientation = "horizontal", decorative = true, className, ...props }: SeparatorProps) {
  return (
    <div
      role={decorative ? "none" : "separator"}
      aria-orientation={decorative || orientation === "horizontal" ? undefined : "vertical"}
      className={cn("shrink-0 bg-hairline", orientation === "horizontal" ? "h-px w-full" : "w-px self-stretch", className)}
      {...props}
    />
  );
}
