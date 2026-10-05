import { cn } from "@/components/ui/cn";

/** Small mono label that opens a section or sits above the hero headline. */
export function Eyebrow({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn("font-mono text-xs leading-5 font-medium tracking-[0.08em] text-accent uppercase", className)}
      {...props}
    />
  );
}

export interface SectionProps extends Omit<React.ComponentProps<"section">, "title"> {
  /** Used for the heading id, so the section is a labelled landmark. */
  id: string;
  eyebrow: string;
  title: React.ReactNode;
  lead?: React.ReactNode;
  /** `band` is a full-width surface strip with hairlines; `plain` sits on the canvas. */
  tone?: "plain" | "band";
}

/** A landing-page section: labelled landmark, consistent heading scale and vertical rhythm. */
export function Section({ id, eyebrow, title, lead, tone = "plain", className, children, ...props }: SectionProps) {
  const headingId = `${id}-heading`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn(tone === "band" && "border-y border-hairline bg-surface", className)}
      {...props}
    >
      <div className="container-page py-16 sm:py-20 lg:py-24">
        <div className="max-w-3xl">
          <Eyebrow>{eyebrow}</Eyebrow>
          <h2
            id={headingId}
            className="mt-3 text-[1.75rem] leading-[1.12] font-semibold tracking-[-0.03em] text-balance text-fg sm:text-4xl sm:leading-[1.1]"
          >
            {title}
          </h2>
          {lead ? <p className="mt-4 max-w-2xl text-[17px] leading-7 text-pretty text-muted">{lead}</p> : null}
        </div>
        <div className="mt-10 lg:mt-12">{children}</div>
      </div>
    </section>
  );
}
