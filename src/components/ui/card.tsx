import { cn } from "./cn";

export interface CardProps extends React.ComponentProps<"div"> {
  /** Adds a hover affordance. Use when the whole card is a link or button target. */
  interactive?: boolean;
}

/** Surface container: hairline border, 10px radius, no shadow. */
export function Card({ interactive = false, className, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-card border border-hairline bg-surface text-fg",
        interactive && "transition-colors duration-150 ease-out hover:border-hairline-strong",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1 px-5 pt-5 pb-4", className)} {...props} />;
}

export interface CardTitleProps extends React.ComponentProps<"h3"> {
  /** Heading level, so cards can sit correctly in any document outline. */
  as?: "h2" | "h3" | "h4";
}

export function CardTitle({ as: Tag = "h3", className, ...props }: CardTitleProps) {
  return <Tag className={cn("text-[15px] leading-6 font-semibold tracking-[-0.01em] text-fg", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-sm leading-6 text-muted", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("px-5 pb-5 first:pt-5", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("flex items-center gap-3 border-t border-hairline px-5 py-3.5", className)} {...props} />
  );
}
