import { cn } from "./cn";

export interface EmptyStateProps extends Omit<React.ComponentProps<"div">, "title"> {
  /** Icon element, e.g. `<Inbox />`. */
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Primary / secondary actions, usually one or two buttons. */
  action?: React.ReactNode;
  /** Heading level of the title. */
  as?: "h1" | "h2" | "h3";
}

/** Centered placeholder for an empty list, a missing resource or a first-run screen. */
export function EmptyState({ icon, title, description, action, as: Heading = "h2", className, ...props }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)} {...props}>
      {icon ? (
        <div
          aria-hidden="true"
          className="mb-4 flex size-11 items-center justify-center rounded-card border border-hairline bg-surface text-muted [&_svg]:size-5"
        >
          {icon}
        </div>
      ) : null}
      <Heading className="text-base font-semibold tracking-[-0.01em] text-fg">{title}</Heading>
      {description ? <p className="mt-1.5 max-w-md text-sm leading-6 text-muted">{description}</p> : null}
      {action ? <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">{action}</div> : null}
    </div>
  );
}
