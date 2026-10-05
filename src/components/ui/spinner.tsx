import { cn } from "./cn";

export interface SpinnerProps extends Omit<React.ComponentProps<"svg">, "children"> {
  /** Accessible name. Pass `null` when a visible label already describes the busy state. */
  label?: string | null;
}

/** Indeterminate progress indicator. Sized by `className` (default 1rem) and coloured by `currentColor`. */
export function Spinner({ label = "Loading", className, ...props }: SpinnerProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      role={label === null ? undefined : "status"}
      aria-label={label ?? undefined}
      aria-hidden={label === null ? true : undefined}
      className={cn("size-4 shrink-0 animate-spin", className)}
      {...props}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
