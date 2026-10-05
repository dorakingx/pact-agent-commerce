import { ArrowRight } from "lucide-react";
import { LinkButton } from "@/components/ui/button";

/**
 * Closing band. `data-theme="dark"` scopes the dark token set to this subtree, so the band is
 * dark in both themes and every primitive inside it keeps correct contrast without overrides.
 */
export function FinalCta() {
  return (
    <section aria-labelledby="final-cta-heading" data-theme="dark" className="border-t border-hairline bg-surface text-fg">
      <div className="container-page flex flex-col gap-8 py-16 sm:py-20 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-2xl">
          <h2
            id="final-cta-heading"
            className="text-[1.75rem] leading-[1.12] font-semibold tracking-[-0.03em] text-balance sm:text-4xl sm:leading-[1.1]"
          >
            Watch a payment wait for proof.
          </h2>
          <p className="mt-4 text-[17px] leading-7 text-pretty text-muted">
            Run a deal end to end on PayPal Sandbox: negotiate, authorize, deliver and verify. Then see what happens
            when the delivery falls short.
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2.5 sm:flex-row sm:items-center">
          <LinkButton href="/workspace" size="lg">
            Run the live demo
            <ArrowRight aria-hidden="true" />
          </LinkButton>
          <LinkButton href="/operations" size="lg" variant="secondary">
            Open operations
          </LinkButton>
        </div>
      </div>
    </section>
  );
}
