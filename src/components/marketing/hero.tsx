import { ArrowRight, FlaskConical } from "lucide-react";
import { LinkButton } from "@/components/ui/button";
import { Eyebrow } from "./section";
import { SettlementVignette } from "./settlement-vignette";

export function Hero() {
  return (
    <section aria-labelledby="hero-heading" className="relative isolate overflow-hidden">
      {/* The one gradient on the site: a faint emerald wash behind the headline. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[34rem] bg-[radial-gradient(60%_70%_at_78%_0%,color-mix(in_srgb,var(--accent)_10%,transparent),transparent_70%)]"
      />
      <div className="container-page pt-10 pb-14 sm:pt-14 lg:pt-16 lg:pb-20">
        <div className="grid gap-8 xl:grid-cols-12 xl:items-end xl:gap-10">
          <div className="xl:col-span-8">
            <Eyebrow>Trust infrastructure for agent-to-agent commerce</Eyebrow>
            <h1
              id="hero-heading"
              className="mt-4 text-[2.125rem] leading-[1.08] font-semibold tracking-[-0.035em] text-fg sm:text-5xl sm:leading-[1.05] lg:text-[3.375rem]"
            >
              <span className="text-muted">AI agents can negotiate.</span>{" "}
              <span className="xl:block">PACT makes sure they only get paid when the deal is done.</span>
            </h1>
          </div>
          <div className="xl:col-span-4 xl:pb-1.5">
            <p className="max-w-xl text-[17px] leading-7 text-pretty text-muted">
              PACT turns an agent negotiation into a hashed contract, holds the buyer&rsquo;s funds with a PayPal
              authorization, and captures only after the delivery is verified against that contract.
            </p>
            <div className="mt-6 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
              <LinkButton href="/workspace" size="lg">
                Run the live demo
                <ArrowRight aria-hidden="true" />
              </LinkButton>
              <LinkButton href="/operations" size="lg" variant="secondary">
                Open operations
              </LinkButton>
            </div>
            <p className="mt-4 flex items-center gap-2 text-[13px] leading-5 text-muted">
              <FlaskConical aria-hidden="true" className="size-3.5 shrink-0" />
              Runs on PayPal Sandbox. No real money moves.
            </p>
          </div>
        </div>
        <SettlementVignette className="mt-10" />
      </div>
    </section>
  );
}
