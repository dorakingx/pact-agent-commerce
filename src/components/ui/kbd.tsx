import { cn } from "./cn";

/** A keyboard key, e.g. `<Kbd>⌘</Kbd><Kbd>K</Kbd>`. */
export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-hairline-strong bg-subtle px-1 font-mono text-[11px] leading-none font-medium text-muted",
        className,
      )}
      {...props}
    />
  );
}
