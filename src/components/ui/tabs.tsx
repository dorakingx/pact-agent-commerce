"use client";

import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "./cn";

export function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root className={cn("flex flex-col gap-4", className)} {...props} />;
}

export interface TabsListProps extends React.ComponentProps<typeof TabsPrimitive.List> {
  /** `underline` for page-level sections, `segmented` for a compact view switch. */
  variant?: "underline" | "segmented";
}

export function TabsList({ variant = "underline", className, ...props }: TabsListProps) {
  return (
    <TabsPrimitive.List
      data-variant={variant}
      className={cn(
        "group/tabs flex max-w-full items-center overflow-x-auto",
        variant === "underline"
          ? "gap-5 border-b border-hairline"
          : "w-fit gap-0.5 rounded-control border border-hairline bg-subtle p-0.5",
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "inline-flex shrink-0 items-center gap-2 text-sm font-medium whitespace-nowrap text-muted transition-colors duration-150 ease-out focus-ring",
        "hover:text-fg disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-fg [&_svg]:size-4",
        // underline
        "group-data-[variant=underline]/tabs:-mb-px group-data-[variant=underline]/tabs:h-10 group-data-[variant=underline]/tabs:border-b-2 group-data-[variant=underline]/tabs:border-transparent group-data-[variant=underline]/tabs:data-[state=active]:border-accent",
        // segmented
        "group-data-[variant=segmented]/tabs:h-8 group-data-[variant=segmented]/tabs:rounded-md group-data-[variant=segmented]/tabs:px-3 group-data-[variant=segmented]/tabs:data-[state=active]:bg-surface group-data-[variant=segmented]/tabs:data-[state=active]:shadow-[0_0_0_1px_var(--hairline)]",
        "pointer-coarse:min-h-11",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("rounded-control focus-ring", className)} {...props} />;
}
