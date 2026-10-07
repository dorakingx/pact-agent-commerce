import { BadgeCheck, CircleSlash, OctagonAlert } from "lucide-react";
import { LinkButton, Money, MonoId, cn } from "@/components/ui";
import type { DealView } from "@/lib/api/dto";
import { dealElapsedMs, dealOutcome, formatElapsed, fundsView, type DealOutcome } from "@/lib/client/deal-derive";
import { plural } from "@/lib/domain/format";
import { Eyebrow } from "./parts";

const LOOK: Record<DealOutcome["tone"], { box: string; icon: React.ReactNode; iconClass: string }> = {
  success: { box: "border-success/40 bg-success-soft", icon: <BadgeCheck />, iconClass: "bg-success text-on-accent" },
  neutral: { box: "border-hairline-strong bg-surface", icon: <CircleSlash />, iconClass: "bg-neutral-soft text-neutral" },
  danger: { box: "border-danger/30 bg-danger-soft", icon: <OctagonAlert />, iconClass: "bg-danger-solid text-on-danger" },
};

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt>
        <Eyebrow>{label}</Eyebrow>
      </dt>
      <dd className="mt-0.5 text-sm font-semibold text-fg">{children}</dd>
    </div>
  );
}

/** 08 — how the deal ended, in one sentence about the money. */
export function OutcomeSection({ deal }: { deal: DealView }) {
  const outcome = dealOutcome(deal);
  if (outcome === null) return null;
  const look = LOOK[outcome.tone];
  const funds = fundsView(deal);
  const list = deal.negotiation.listPriceMinor;
  const agreed = deal.negotiation.agreedTerms?.priceMinor ?? null;

  return (
    <section
      id="section-outcome"
      data-testid="section-outcome"
      data-live-anchor=""
      data-status={deal.status}
      aria-labelledby="section-outcome-title"
      className={cn("animate-rise-in scroll-mt-44 scroll-mb-10 rounded-card border p-4 sm:p-6", look.box)}
    >
      <div className="flex items-start gap-3.5">
        <span aria-hidden="true" className={cn("flex size-10 shrink-0 items-center justify-center rounded-full [&_svg]:size-5", look.iconClass)}>
          {look.icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] leading-4 font-medium tracking-[0.08em] text-muted uppercase">08 · Outcome</p>
          <h2 id="section-outcome-title" data-testid="outcome-title" className="mt-1 text-xl leading-7 font-semibold tracking-[-0.02em] text-balance text-fg sm:text-2xl sm:leading-8">
            {outcome.title}
          </h2>
          <p data-testid="outcome-detail" className="mt-1 max-w-2xl text-sm leading-6 break-words text-fg/85">
            {outcome.detail}
          </p>
          {outcome.captureId ? (
            <p className="mt-2 flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
              PayPal capture
              <MonoId value={outcome.captureId} label="PayPal capture id" head={10} tail={4} data-testid="outcome-capture-id" className="text-fg" />
            </p>
          ) : null}
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-fg/10 pt-4 sm:grid-cols-4">
        <Stat label="Captured">
          <Money amountMinor={funds.capturedMinor} />
        </Stat>
        <Stat label="Released to payer">
          <Money amountMinor={funds.releasedMinor} />
        </Stat>
        <Stat label="Negotiated">
          {agreed === null ? (
            "No agreement"
          ) : list !== null && list !== agreed ? (
            <span>
              <Money amountMinor={list} className="font-normal text-muted line-through" /> <Money amountMinor={agreed} />
            </span>
          ) : (
            <Money amountMinor={agreed} />
          )}
        </Stat>
        <Stat label="Took">
          {formatElapsed(dealElapsedMs(deal))}
          <span className="font-normal text-muted"> · {plural(deal.audit.length, "audit event")}</span>
        </Stat>
      </dl>

      <div className="mt-5 flex flex-col gap-2.5 sm:flex-row">
        <LinkButton href="/workspace" data-testid="start-another">
          Start another
        </LinkButton>
        <LinkButton href="/operations" variant="secondary" data-testid="open-operations">
          Open in Operations
        </LinkButton>
      </div>
    </section>
  );
}
