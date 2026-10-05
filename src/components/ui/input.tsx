import { cn } from "./cn";

/** Shared look for text fields; exported so composite controls can match it exactly. */
export const fieldClassName = [
  "w-full rounded-control border border-hairline-strong bg-surface px-3 text-sm text-fg",
  "placeholder:text-faint",
  "transition-[border-color,box-shadow] duration-150 ease-out outline-none",
  "hover:border-fg/30 focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-accent/20",
  "disabled:cursor-not-allowed disabled:bg-subtle disabled:opacity-60",
  "aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/20",
  // 16px text on touch devices stops iOS Safari zooming the page on focus.
  "pointer-coarse:text-base",
].join(" ");

export function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return <input type={type} className={cn(fieldClassName, "h-10 pointer-coarse:h-11", className)} {...props} />;
}
