"use client";

import { Label as LabelPrimitive } from "radix-ui";
import { cn } from "./cn";

export function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn(
        "text-sm leading-5 font-medium text-fg select-none peer-disabled:opacity-50 has-[:disabled]:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
