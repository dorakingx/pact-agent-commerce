"use client";

import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "./cn";

/** On/off toggle that applies immediately. Give it a name with `<Label htmlFor>` or `aria-label`. */
export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "peer relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border border-transparent bg-hairline-strong transition-colors duration-150 ease-out focus-ring",
        "disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-accent",
        // Enlarges the touch target to 44px without changing the visual size.
        "pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5 pointer-coarse:after:content-['']",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-[18px] translate-x-[2px] rounded-full bg-white shadow-[0_1px_2px_rgb(11_18_32/0.3)] transition-transform duration-150 ease-out data-[state=checked]:translate-x-[18px] dark:data-[state=checked]:bg-on-accent" />
    </SwitchPrimitive.Root>
  );
}
