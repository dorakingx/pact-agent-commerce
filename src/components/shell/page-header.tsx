import { cn } from "@/components/ui/cn";

export interface PageHeaderProps extends Omit<React.ComponentProps<"div">, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Buttons or controls aligned to the right (below the title on small screens). */
  actions?: React.ReactNode;
  /** Small line above the title: a breadcrumb, a deal code, a status pill. */
  eyebrow?: React.ReactNode;
}

/** Title block for an application page. Renders the page's single <h1>. */
export function PageHeader({ title, description, actions, eyebrow, className, ...props }: PageHeaderProps) {
  return (
    <div className={cn("flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between", className)} {...props}>
      <div className="min-w-0">
        {eyebrow ? <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-muted">{eyebrow}</div> : null}
        <h1 className="text-2xl leading-8 font-semibold tracking-[-0.02em] text-balance text-fg">{title}</h1>
        {description ? <p className="mt-1.5 max-w-2xl text-[15px] leading-6 text-pretty text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2.5">{actions}</div> : null}
    </div>
  );
}
