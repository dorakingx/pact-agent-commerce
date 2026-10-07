import type { Metadata } from "next";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { Eyebrow } from "@/components/marketing/section";
import { SettlementVignette } from "@/components/marketing/settlement-vignette";
import { AppShell } from "@/components/shell";
import { LinkButton } from "@/components/ui/button";
import { DecisionTables } from "./_components/decision-tables";
import { DocSection } from "./_components/doc-section";
import { PayPalCalls } from "./_components/paypal-calls";
import { Resources } from "./_components/resources";
import { Roles } from "./_components/roles";
import { DOCS_BASE_URL } from "./content";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "The PACT architecture in two minutes: language models propose, deterministic code decides, PayPal moves the money. The lifecycle of a deal, the PayPal calls, and the decisions that gate a capture.",
};

/** In-page contents. The anchors are the section ids below. */
const CONTENTS = [
  { href: "#lifecycle", label: "Lifecycle" },
  { href: "#roles", label: "Who does what" },
  { href: "#paypal", label: "PayPal calls" },
  { href: "#decisions", label: "Decisions" },
  { href: "#docs", label: "Docs" },
] as const;

/**
 * /how-it-works — the architecture for someone who wants it in two minutes without leaving the
 * product. Fully static: every figure on it is either fixed text or derived from the domain code
 * at build time (see ./content.ts and its test).
 */
export default function HowItWorksPage() {
  return (
    <AppShell width="full">
      <section aria-labelledby="how-heading" className="relative isolate overflow-hidden">
        {/* Same faint emerald wash as the landing hero, so the two public pages read as one. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[26rem] bg-[radial-gradient(60%_70%_at_78%_0%,color-mix(in_srgb,var(--accent)_9%,transparent),transparent_70%)]"
        />
        <div className="container-page pt-10 pb-10 sm:pt-14 sm:pb-12">
          <Eyebrow>How it works</Eyebrow>
          <h1
            id="how-heading"
            className="mt-4 max-w-4xl text-[2rem] leading-[1.1] font-semibold tracking-[-0.035em] text-balance text-fg sm:text-[2.75rem] sm:leading-[1.06]"
          >
            <span className="text-muted">Language models propose.</span> Deterministic code decides.{" "}
            <span className="sm:whitespace-nowrap">PayPal moves the money.</span>
          </h1>
          <p className="mt-5 max-w-2xl text-[17px] leading-7 text-pretty text-muted">
            PACT sits between two negotiating agents and the payment. This is the two-minute version of the
            architecture: what happens in a deal, who is allowed to do what, and which PayPal calls carry it.
          </p>
          <div className="mt-7 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
            <LinkButton href="/workspace" size="lg" data-testid="how-cta-demo">
              Run the live demo
              <ArrowRight aria-hidden="true" />
            </LinkButton>
            <LinkButton href={`${DOCS_BASE_URL}/architecture.md`} external size="lg" variant="secondary">
              Read the full architecture
              <ArrowUpRight aria-hidden="true" />
            </LinkButton>
          </div>
          <nav aria-label="On this page" className="mt-9 flex flex-wrap items-center gap-x-1 gap-y-1 border-t border-hairline pt-4">
            <span className="mr-2 font-mono text-[11px] leading-5 font-medium tracking-[0.08em] text-faint uppercase">On this page</span>
            {CONTENTS.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="inline-flex h-8 items-center rounded-control px-2.5 text-[13px] font-medium text-muted transition-colors duration-150 ease-out focus-ring hover:bg-subtle-strong/60 hover:text-fg pointer-coarse:min-h-11"
              >
                {item.label}
              </a>
            ))}
          </nav>
        </div>
      </section>

      <DocSection
        id="lifecycle"
        eyebrow="The lifecycle"
        title="One deal, from a sentence to a settled payment."
        lead="The funds are held before any work starts and move only after the delivery is checked against the contract. If the check fails, nothing is captured."
        className="[&>div]:pt-2 sm:[&>div]:pt-4 lg:[&>div]:pt-4"
      >
        <SettlementVignette />
      </DocSection>

      <DocSection
        id="roles"
        band
        eyebrow="Who does what"
        title="Three kinds of actor, and a hard line between them."
        lead="A model can be persuaded, and a seller’s delivery is untrusted input. So nothing a model says changes a deal’s status, a limit or a payment until an engine has checked it."
      >
        <Roles />
      </DocSection>

      <DocSection
        id="paypal"
        eyebrow="The payment rail"
        title="The PayPal calls PACT makes."
        lead="Orders v2 with intent AUTHORIZE, Payments v2 to capture or void, Vault v3 for the delegated wallet, and signed webhooks. The contract hash travels with the money as the order’s custom_id."
      >
        <PayPalCalls />
      </DocSection>

      <DocSection
        id="decisions"
        band
        eyebrow="The two gates"
        title="A deal passes two decisions. Both are computed."
        lead="One before funds are held, one before they are captured. Each is a pure function with unit tests, and each result is written to the audit trail."
      >
        <DecisionTables />
      </DocSection>

      <DocSection id="docs" eyebrow="Go deeper" title="The long form, and the API." lead="Everything on this page is in the repository, with the reasoning behind it.">
        <Resources />
        <div className="mt-10 flex flex-col gap-5 rounded-card border border-hairline bg-surface p-6 sm:flex-row sm:items-center sm:justify-between sm:p-7">
          <div>
            <p className="text-lg leading-7 font-semibold tracking-[-0.015em] text-fg">See it run.</p>
            <p className="mt-1 max-w-xl text-sm leading-6 text-pretty text-muted">
              Start a deal and watch each step above happen: negotiation, contract, authorization hold, delivery,
              verification, and a capture that waits for proof.
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-2.5 sm:flex-row">
            <LinkButton href="/workspace">
              Run the live demo
              <ArrowRight aria-hidden="true" />
            </LinkButton>
            <LinkButton href="/policies" variant="secondary">
              Set spending controls
            </LinkButton>
          </div>
        </div>
      </DocSection>
    </AppShell>
  );
}
