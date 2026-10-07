"use client";

import Link from "next/link";
import { ArrowDown, ArrowLeft, CircleAlert, CirclePause, RotateCw, StepForward, Store, TriangleAlert } from "lucide-react";
import { Badge, Button, DealStatusPill, Label, MonoId, Spinner, Switch, cn } from "@/components/ui";
import type { DealView, HumanGate } from "@/lib/api/dto";
import { activityLine, dealOutcome, dealTitle, fundsView, openGate, type ActivityLine } from "@/lib/client/deal-derive";
import type { UseDealRunner } from "@/lib/client/use-deal-runner";
import { DEAL_STATUS_LABEL, type DealStatus } from "@/lib/domain/status";
import { FundsSummary } from "./funds";
import { DemoFaultBadge, ProviderBadge, TrustBadge } from "./parts";

function SellerChip({ deal }: { deal: DealView }) {
  const seller = deal.seller;
  if (seller === null) {
    return (
      <span data-testid="deal-seller" data-seller-id="" className="text-[13px] text-muted">
        No seller agent matched
      </span>
    );
  }
  return (
    <span data-testid="deal-seller" data-seller-id={seller.id} className="inline-flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-fg" title={seller.tagline}>
        <Store aria-hidden="true" className="size-3.5 text-muted" />
        {seller.name}
      </span>
      <TrustBadge trust={seller.trust} />
      {seller.demoFault ? <DemoFaultBadge fault={seller.demoFault} short /> : null}
    </span>
  );
}

/** Back link, code, seller and title. This part scrolls away; the bar below it does not. */
export function DealHeader({ deal }: { deal: DealView }) {
  return (
    <div className="container-page pt-6 pb-4 sm:pt-8">
      <Link
        href="/workspace"
        data-testid="back-to-workspace"
        className="inline-flex items-center gap-1.5 rounded-sm text-[13px] font-medium text-muted transition-colors duration-150 focus-ring hover:text-fg pointer-coarse:min-h-11"
      >
        <ArrowLeft aria-hidden="true" className="size-3.5" />
        Workspace
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <MonoId value={deal.code} label="deal code" full data-testid="deal-code" className="text-[13px] font-semibold text-fg" />
        <span aria-hidden="true" className="h-4 w-px bg-hairline-strong" />
        <SellerChip deal={deal} />
        <ProviderBadge simulated={deal.flags.simulatedPayment} />
        {deal.flags.aiDegraded ? (
          <Badge
            tone="hold"
            variant="outline"
            data-testid="ai-degraded"
            title="An AI call failed during this deal, so a scripted fallback or a degraded verification was used. Nothing was captured on a guess."
          >
            <TriangleAlert aria-hidden="true" />
            AI fallback used
          </Badge>
        ) : null}
      </div>
      <h1 data-testid="deal-title" className="mt-2 max-w-4xl text-2xl leading-8 font-semibold tracking-[-0.02em] text-balance text-fg">
        {dealTitle(deal)}
      </h1>
    </div>
  );
}

/** Labels without a " · " that are still too long for a phone's status row. */
const SHORT_STATUS_LABEL: Partial<Record<DealStatus, string>> = {
  awaiting_approval: "Needs approval",
  awaiting_payment: "Awaiting PayPal",
  in_review: "Review required",
};

const GATE_JUMP_LABEL: Record<HumanGate, string> = {
  approval: "Go to approval",
  payment: "Go to payment",
  review: "Go to review",
};

function ActivityIcon({ kind }: { kind: ActivityLine["kind"] }) {
  switch (kind) {
    case "working":
      return <Spinner label={null} className="size-3.5 text-info" />;
    case "waiting":
      return <span aria-hidden="true" className="size-2 shrink-0 animate-pulse-dot rounded-full bg-review text-review" />;
    case "paused":
      return <CirclePause aria-hidden="true" className="size-3.5 shrink-0 text-muted" />;
    case "problem":
      return <CircleAlert aria-hidden="true" className="size-3.5 shrink-0 text-danger" />;
    case "done":
      return null;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export interface DealBarProps {
  deal: DealView;
  runner: UseDealRunner;
}

/**
 * The strip that stays in view: status, what is happening right now, where the money is, and
 * the presenter's controls. Everything a silent viewer needs to follow the deal is here.
 */
export function DealBar({ deal, runner }: DealBarProps) {
  const activity = activityLine(deal, runner);
  // Once the deal has ended the pill already says so; the line beside it says what happened to the money.
  const activityText = activity.kind === "done" ? (dealOutcome(deal)?.title ?? activity.text) : activity.text;
  const funds = fundsView(deal);
  const gate = openGate(deal);
  const canDrive = deal.isOwner && deal.next.kind !== "done";
  const autoStep = deal.next.kind === "auto";
  const problem = deal.isOwner && autoStep ? runner.problem : null;
  // On a phone the pill shares its row with the money, so it carries only the first half of its label.
  const statusHead = DEAL_STATUS_LABEL[deal.status].split(" · ")[0];
  const moneyVisible = funds.phase === "held" || funds.phase === "captured" || funds.phase === "released";

  function jumpToGate(): void {
    if (gate === null) return;
    document.getElementById(`gate-${gate}`)?.scrollIntoView({ block: "center" });
  }

  return (
    <div data-testid="deal-bar" className="sticky top-15 z-30 border-b border-hairline bg-canvas/95 backdrop-blur-sm">
      {/*
       * Two rows on a phone (status and money, then activity and controls), one row from `sm` up:
       * there the two wrappers dissolve (`sm:contents`) and `order` puts the money after the activity.
       */}
      <div className="container-page flex flex-col gap-2 py-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
        <div className="flex items-center justify-between gap-3 sm:contents">
          <DealStatusPill
            status={deal.status}
            data-testid="deal-status"
            className="sm:order-1"
            label={
              <>
                <span className="sm:hidden">{SHORT_STATUS_LABEL[deal.status] ?? statusHead}</span>
                <span className="max-sm:hidden">{DEAL_STATUS_LABEL[deal.status]}</span>
              </>
            }
          />
          <FundsSummary funds={funds} className={cn("sm:order-4", !moneyVisible && "max-xl:hidden")} />
        </div>
        <div className="flex min-w-0 items-center gap-3 sm:contents">
          <p
            role="status"
            aria-live="polite"
            data-testid="deal-activity"
            data-kind={activity.kind}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 text-[13px] leading-5 sm:order-2 sm:basis-64",
              activity.kind === "waiting" ? "font-medium text-review" : activity.kind === "problem" ? "font-medium text-danger" : "text-muted",
            )}
          >
            <ActivityIcon kind={activity.kind} />
            <span className="truncate">{activityText}</span>
          </p>
          {gate ? (
            <Button variant="secondary" size="sm" onClick={jumpToGate} data-testid="jump-to-gate" className="sm:order-3">
              {GATE_JUMP_LABEL[gate]}
              <ArrowDown aria-hidden="true" />
            </Button>
          ) : null}
          {canDrive ? (
            // While a gate is open there is nothing to run, so a phone gives the room to the gate button.
            <div className={cn("flex shrink-0 items-center gap-2.5 sm:order-5 sm:gap-3", gate && "max-sm:hidden")}>
              <span className="flex items-center gap-2">
                <Switch
                  id="auto-run"
                  checked={runner.autoRun}
                  onCheckedChange={runner.setAutoRun}
                  data-testid="auto-run"
                  aria-describedby="auto-run-hint"
                />
                <Label htmlFor="auto-run" className="text-[13px]">
                  Auto<span className="max-sm:sr-only">-run</span>
                </Label>
                <span id="auto-run-hint" className="sr-only">
                  When on, PACT runs each automatic step by itself. Switch it off to advance one step at a time.
                </span>
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={runner.autoRun || !autoStep || runner.phase !== "idle"}
                onClick={runner.runNext}
                data-testid="run-next-step"
                aria-label="Run next step"
                className="max-sm:w-8 max-sm:px-0 pointer-coarse:max-sm:w-11"
              >
                <StepForward aria-hidden="true" />
                <span className="max-sm:hidden">Run next step</span>
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      {problem ? (
        <div className="container-page pb-2.5">
          <div
            role="alert"
            data-testid="runner-problem"
            data-kind={problem.kind}
            className="flex flex-col gap-2.5 rounded-card border border-danger/25 bg-danger-soft px-4 py-3 sm:flex-row sm:items-center"
          >
            <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-danger max-sm:hidden" />
            <div className="min-w-0 flex-1 text-sm leading-6">
              <p className="font-semibold text-fg">
                {problem.kind === "stalled" ? "The step did not complete" : "The step could not be sent"}
              </p>
              <p className="break-words text-fg/85">{problem.message}</p>
              {problem.requestId ? <p className="font-mono text-xs text-muted">Request {problem.requestId}</p> : null}
            </div>
            <Button size="sm" onClick={runner.retry} data-testid="runner-retry" className="shrink-0">
              <RotateCw aria-hidden="true" />
              {problem.kind === "stalled" ? "Retry step" : "Retry"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
