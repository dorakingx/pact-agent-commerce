"use client";

import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "./cn";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export type SheetSide = "right" | "left" | "bottom";

const SIDE: Record<SheetSide, string> = {
  right:
    "inset-y-0 right-0 h-dvh w-[min(26rem,calc(100vw-2.5rem))] border-l data-[state=closed]:animate-slide-out-right data-[state=open]:animate-slide-in-right",
  left: "inset-y-0 left-0 h-dvh w-[min(26rem,calc(100vw-2.5rem))] border-r data-[state=closed]:animate-slide-out-left data-[state=open]:animate-slide-in-left",
  bottom:
    "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-card border-t data-[state=closed]:animate-slide-out-bottom data-[state=open]:animate-slide-in-bottom",
};

export interface SheetContentProps extends React.ComponentProps<typeof DialogPrimitive.Content> {
  side?: SheetSide;
}

/** Side drawer built on the dialog primitive: same focus trap and Escape behaviour. Always include a `SheetTitle`. */
export function SheetContent({ side = "right", className, children, ...props }: SheetContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
      <DialogPrimitive.Content
        className={cn(
          "fixed z-50 flex flex-col border-hairline bg-surface text-fg shadow-pop outline-none",
          SIDE[side],
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          aria-label="Close"
          className="absolute top-3 right-3 flex size-8 items-center justify-center rounded-control text-muted transition-colors duration-150 ease-out focus-ring hover:bg-subtle hover:text-fg pointer-coarse:size-11"
        >
          <X aria-hidden="true" className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("flex flex-col gap-1 border-b border-hairline px-5 py-4 pr-14", className)} {...props} />
  );
}

export function SheetTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-base leading-6 font-semibold tracking-[-0.01em] text-fg", className)}
      {...props}
    />
  );
}

export function SheetDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn("text-sm leading-6 text-muted", className)} {...props} />;
}

export function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", className)} {...props} />;
}

export function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex items-center gap-2.5 border-t border-hairline px-5 py-4", className)} {...props} />;
}
