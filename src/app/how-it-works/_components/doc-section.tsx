import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/marketing/section";

export interface DocSectionProps extends Omit<React.ComponentProps<"section">, "title"> {
  /** Anchor id; the heading gets `<id>-heading` so the section is a labelled landmark. */
  id: string;
  eyebrow: string;
  title: React.ReactNode;
  lead?: React.ReactNode;
  /** A surface strip with hairlines, to alternate with sections that sit on the canvas. */
  band?: boolean;
}

/**
 * A section of the explainer. Same voice as the landing page's sections, at a tighter scale:
 * this page is read inside the product, between two demo runs.
 */
export function DocSection({ id, eyebrow, title, lead, band = false, className, children, ...props }: DocSectionProps) {
  const headingId = `${id}-heading`;
  return (
    <section id={id} aria-labelledby={headingId} className={cn(band && "border-y border-hairline bg-surface", className)} {...props}>
      <div className="container-page py-12 sm:py-14 lg:py-16">
        <div className="max-w-3xl">
          <Eyebrow>{eyebrow}</Eyebrow>
          <h2 id={headingId} className="mt-2.5 text-2xl leading-[1.15] font-semibold tracking-[-0.025em] text-balance text-fg sm:text-[1.75rem]">
            {title}
          </h2>
          {lead ? <p className="mt-3 max-w-2xl text-base leading-7 text-pretty text-muted">{lead}</p> : null}
        </div>
        <div className="mt-8 lg:mt-10">{children}</div>
      </div>
    </section>
  );
}
