"use client";

import { Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "./cn";

export interface TooltipProps {
  /** Tooltip text or rich content. When empty, the child is rendered without a tooltip. */
  content: React.ReactNode;
  /** The trigger. Must be a single focusable element (a button or link), so keyboard users get the tooltip too. */
  children: React.ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /** Milliseconds before the tooltip opens on hover. */
  delay?: number;
  className?: string;
}

/**
 * Supplementary hint on hover and keyboard focus. Never put essential information only in a
 * tooltip: touch users cannot reach it.
 */
export function Tooltip({ content, children, side = "top", align = "center", delay = 200, className }: TooltipProps) {
  if (content === null || content === undefined || content === "") return children;
  return (
    <TooltipPrimitive.Provider delayDuration={delay} skipDelayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            align={align}
            sideOffset={6}
            collisionPadding={8}
            className={cn(
              "z-50 max-w-xs animate-fade-in rounded-md bg-inverse px-2.5 py-1.5 text-xs leading-5 text-on-inverse shadow-pop",
              "border border-white/10",
              className,
            )}
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
