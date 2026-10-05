import { cn } from "./cn";

/** Placeholder block for content that is loading. Size it with `className`. */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div aria-hidden="true" className={cn("animate-shimmer rounded-md bg-subtle-strong", className)} {...props} />;
}
