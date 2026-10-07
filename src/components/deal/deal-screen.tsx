"use client";

import { useEffect, useRef } from "react";
import { Eye, FileQuestion } from "lucide-react";
import { Button, Callout, EmptyState, LinkButton, Skeleton, toast } from "@/components/ui";
import type { DealView } from "@/lib/api/dto";
import type { ApiClientError } from "@/lib/client/api";
import { payPalReturnToast, readOnlyKind, type PayPalReturn, type ReadOnlyKind } from "@/lib/client/deal-derive";
import { useDeal, useDealDecision, type UseDeal, type UseDealDecision } from "@/lib/client/use-deal";
import { useDealRunner, type UseDealRunner } from "@/lib/client/use-deal-runner";
import { AuditTrail } from "./audit-trail";
import { ContractSection } from "./contract-section";
import { DealBar, DealHeader } from "./deal-header";
import { DeliverySection } from "./delivery-section";
import { EvidenceLinkProvider } from "./evidence-link";
import { LifecycleRail } from "./lifecycle-rail";
import { NegotiationSection } from "./negotiation-section";
import { OutcomeSection } from "./outcome-section";
import { RequestError } from "./parts";
import { PaymentSection } from "./payment-section";
import { PolicySection } from "./policy-section";
import { RequestSection } from "./request-section";
import { useFollowLive } from "./use-follow-live";
import { useMediaQuery } from "./use-media-query";
import { VerificationSection } from "./verification-section";

/** From this width the audit trail sits in a sticky rail beside the deal instead of below it. */
const RAIL_QUERY = "(min-width: 1180px)";

const READ_ONLY_COPY: Record<ReadOnlyKind, { title: string; body: string }> = {
  showcase: {
    title: "Showcase deal — read-only",
    body: "This is a reference deal anyone can open. Everything on it is real output of the engine, but it cannot be advanced or decided from here.",
  },
  other_session: {
    title: "This deal belongs to another session — read-only",
    body: "Only the browser session that started a deal can run it or decide at its gates. The buyer's private mandate is hidden.",
  },
};

/** Announces the result of the trip to the approval page once, then removes it from the address bar. */
function usePayPalReturnToast(dealId: string, result: PayPalReturn | null): void {
  useEffect(() => {
    if (result === null) return;
    const message = payPalReturnToast(result);
    // A fixed id makes the toast idempotent: a re-run of this effect updates it instead of stacking a copy.
    toast[message.kind](message.title, { id: `paypal-return-${dealId}`, description: message.description });
    window.history.replaceState(null, "", window.location.pathname);
  }, [dealId, result]);
}

function DealSkeleton() {
  return (
    <div data-testid="deal-loading" aria-busy="true" aria-label="Loading the deal">
      <div className="container-page pt-6 pb-4 sm:pt-8">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-3 h-5 w-72 max-w-full" />
        <Skeleton className="mt-3 h-8 w-[32rem] max-w-full" />
      </div>
      <div className="border-y border-hairline">
        <div className="container-page flex items-center gap-4 py-2.5">
          <Skeleton className="h-[26px] w-40 rounded-full" />
          <Skeleton className="h-4 w-56 max-sm:hidden" />
          <Skeleton className="ml-auto h-10 w-44" />
        </div>
      </div>
      <div className="container-page py-6">
        <Skeleton className="h-20 w-full rounded-card" />
        <div className="mt-6 grid gap-6 min-[1180px]:grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex flex-col gap-5">
            <Skeleton className="h-56 w-full rounded-card" />
            <Skeleton className="h-80 w-full rounded-card" />
          </div>
          <Skeleton className="h-96 w-full rounded-card max-[1179px]:hidden" />
        </div>
      </div>
    </div>
  );
}

function DealLoadError({ error, onRetry }: { error: ApiClientError; onRetry(): void }) {
  if (error.status === 404) {
    return (
      <div className="container-page py-16" data-testid="deal-not-found">
        <EmptyState
          as="h1"
          icon={<FileQuestion />}
          title="Deal not found"
          description="There is no deal with this id. It may belong to a database that has since been reset."
          action={<LinkButton href="/workspace">Back to the workspace</LinkButton>}
        />
      </div>
    );
  }
  return (
    <div className="container-page py-10" data-testid="deal-load-error">
      <h1 className="text-2xl leading-8 font-semibold tracking-[-0.02em] text-fg">The deal could not be loaded</h1>
      <RequestError
        error={error}
        className="mt-4 max-w-2xl"
        action={
          <Button variant="secondary" size="sm" onClick={onRetry} data-testid="deal-load-retry">
            Retry
          </Button>
        }
      />
      <LinkButton href="/workspace" variant="ghost" size="sm" className="mt-3 -ml-3">
        Back to the workspace
      </LinkButton>
    </div>
  );
}

function LoadedDeal({
  deal,
  runner,
  decision,
  refresh,
}: {
  deal: DealView;
  runner: UseDealRunner;
  decision: UseDealDecision;
  refresh: UseDeal["refresh"];
}) {
  const main = useRef<HTMLDivElement | null>(null);
  const wide = useMediaQuery(RAIL_QUERY);
  const readOnly = readOnlyKind(deal);

  // The next move is being written: by this page's runner, or in the owner's session for a visitor.
  const thinking =
    deal.status === "negotiating" && (deal.isOwner ? runner.problem === null && (runner.autoRun || runner.phase !== "idle") : true);

  const showNegotiation = deal.negotiation.moves.length > 0 || deal.status === "negotiating" || deal.negotiation.status === "failed";
  const showPayment = deal.payment !== null || deal.status === "payment_pending";
  const showDelivery = deal.submissions.length > 0 || deal.status === "authorized";
  const showVerification = deal.reports.length > 0 || deal.status === "submitted";

  useFollowLive(main, `${deal.audit.length}:${deal.status}:${thinking}`, deal.isOwner && deal.next.kind !== "done");

  return (
    <div data-testid="deal-screen" data-deal-id={deal.id} data-status={deal.status} data-next={deal.next.kind} data-owner={deal.isOwner}>
      <DealHeader deal={deal} />
      <DealBar deal={deal} runner={runner} />

      <div className="container-page pt-5 pb-16">
        <LifecycleRail deal={deal} />

        <div className="mt-5 grid items-start gap-6 min-[1180px]:grid-cols-[minmax(0,1fr)_360px]">
          <div ref={main} className="flex min-w-0 flex-col gap-5">
            {readOnly ? (
              <Callout tone="info" icon={<Eye />} title={READ_ONLY_COPY[readOnly].title} data-testid="read-only-banner" data-kind={readOnly}>
                {READ_ONLY_COPY[readOnly].body}
              </Callout>
            ) : null}
            <RequestSection deal={deal} />
            {showNegotiation ? <NegotiationSection deal={deal} thinking={thinking} /> : null}
            <ContractSection deal={deal} />
            <PolicySection deal={deal} decision={decision} />
            {showPayment ? <PaymentSection deal={deal} decision={decision} refresh={refresh} /> : null}
            {showDelivery ? <DeliverySection deal={deal} /> : null}
            {showVerification ? <VerificationSection deal={deal} decision={decision} /> : null}
            <OutcomeSection deal={deal} />
            {wide ? null : <AuditTrail deal={deal} variant="section" />}
          </div>
          {wide ? (
            <aside aria-label="Audit trail" className="sticky top-[8.75rem]">
              <AuditTrail deal={deal} variant="rail" />
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export interface DealScreenProps {
  dealId: string;
  /** `?paypal=` from the approval page's redirect, already validated. */
  paypalReturn: PayPalReturn | null;
}

/**
 * The live deal. Mount it with `key={dealId}`: the runner and every piece of view state belong
 * to one deal.
 */
export function DealScreen({ dealId, paypalReturn }: DealScreenProps) {
  const state = useDeal(dealId);
  const runner = useDealRunner(dealId, state.deal, state.publish);
  const decision = useDealDecision(dealId, state);
  usePayPalReturnToast(dealId, paypalReturn);

  if (state.deal === undefined) {
    if (state.error) return <DealLoadError error={state.error} onRetry={() => void state.refresh()} />;
    return <DealSkeleton />;
  }
  return (
    <EvidenceLinkProvider>
      <LoadedDeal deal={state.deal} runner={runner} decision={decision} refresh={state.refresh} />
    </EvidenceLinkProvider>
  );
}
