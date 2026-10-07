"use client";

import type { AgWidgetParams } from "ag-studio";
import { ArrowUpRight, CircleCheck, Crosshair, ScanSearch, ShieldAlert } from "lucide-react";
import { useMemo } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import { Money } from "@/components/ui/money";
import { RelativeTime } from "@/components/ui/relative-time";
import { StatusPill } from "@/components/ui/status-pill";
import type { DealResponse } from "@/lib/api/dto";
import { fetcher } from "@/lib/client/api";
import { sellerNoteOf } from "@/lib/client/studio-data";
import { buildReviewQueue, reviewReasonFromDeal, type ReviewQueueItem } from "@/lib/client/studio-review";
import { WIDGET_DEFAULTS, type ReviewQueueWidget } from "@/lib/client/studio-widgets";
import type { PactStudioContext } from "../context";
import { mapped, planQuery, useWidgetRows, valueOf, type WidgetQueryPlan } from "./use-widget-rows";
import { WidgetMessage } from "./widget-message";

type Params = AgWidgetParams<ReviewQueueWidget, unknown, PactStudioContext>;

function queuePlan(params: Params): WidgetQueryPlan {
  const { deal, status, seller, amount, reason, since } = params.dataMapping;
  return planQuery([mapped(deal), mapped(status)], [mapped(seller), mapped(amount), mapped(reason), mapped(since)]);
}

/**
 * The deals that are waiting for a person, longest-waiting first. Each card says what is being
 * asked, how much is at stake and why the engine stopped. Opening a card goes to the deal, where
 * the decision is made; the queue itself decides nothing.
 */
export function ReviewQueue(params: Params) {
  const { rows, error } = useWidgetRows(params, queuePlan);
  const { widgetApi, dataMapping, format, context } = params;
  const maxItems = format?.style?.maxItems ?? WIDGET_DEFAULTS.queue.maxItems;
  const showReason = format?.style?.showReason ?? WIDGET_DEFAULTS.queue.showReason;
  const dealField = mapped(dataMapping.deal);

  const model = useMemo(
    () =>
      buildReviewQueue(
        (rows ?? []).map((row) => ({
          deal: valueOf(row, mapped(dataMapping.deal)),
          status: valueOf(row, mapped(dataMapping.status)),
          seller: valueOf(row, mapped(dataMapping.seller)),
          amount: valueOf(row, mapped(dataMapping.amount)),
          reason: valueOf(row, mapped(dataMapping.reason)),
          since: valueOf(row, mapped(dataMapping.since)),
        })),
        maxItems,
      ),
    [rows, dataMapping, maxItems],
  );

  const focused = new Set(
    (widgetApi.getCrossFilterSelections() ?? []).flatMap((selection) => (selection.type === "value" ? selection.values.map(String) : [])),
  );

  if (error !== null) return <WidgetMessage tone="danger" title="The queue could not load" detail={error} />;
  if (rows === null) return null;
  if (model.total === 0) {
    return (
      <WidgetMessage
        icon={<CircleCheck />}
        title="Nobody is waiting on you"
        detail="No deal needs an approval or a review under the current filters. Deals appear here the moment the policy or the verifier stops for a human."
      />
    );
  }

  return (
    <div data-testid="review-queue" className="flex h-full min-h-0 flex-col font-sans text-fg">
      <p className="px-3 pb-2 text-xs leading-[18px] text-muted" aria-live="polite">
        <span className="font-semibold text-fg">{model.total}</span> waiting
        {model.approvals > 0 ? ` · ${model.approvals} to approve` : ""}
        {model.reviews > 0 ? ` · ${model.reviews} to review` : ""}
      </p>
      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-3 pb-3">
        {model.items.map((item) => (
          <QueueCard
            key={item.code}
            item={item}
            showReason={showReason}
            context={context}
            focused={focused.has(item.code)}
            onFocusToggle={
              dealField === undefined
                ? undefined
                : () => widgetApi.toggleCrossFilter({ type: "value", field: dealField, value: item.code, group: 0 })
            }
          />
        ))}
        {model.hidden > 0 ? (
          <li className="px-1 pt-0.5 text-xs text-muted">
            +{model.hidden} more waiting. Raise “Cards shown” in the widget settings or filter the page.
          </li>
        ) : null}
      </ul>
    </div>
  );
}

interface QueueCardProps {
  item: ReviewQueueItem;
  showReason: boolean;
  context: PactStudioContext;
  focused: boolean;
  onFocusToggle: (() => void) | undefined;
}

function QueueCard({ item, showReason, context, focused, onFocusToggle }: QueueCardProps) {
  const row = context.dealByCode(item.code);
  // The ledger row carries a derived reason; the deal itself has the engine's own sentence.
  const { data } = useSWR<DealResponse>(showReason && row !== null ? `/api/deals/${row.id}` : null, fetcher, {
    revalidateOnFocus: false,
    // The card is complete without this: one attempt, no retry storm if the deal cannot be read.
    shouldRetryOnError: false,
    dedupingInterval: 30_000,
  });
  const reason = (data ? reviewReasonFromDeal(data.deal) : null) ?? item.reason;
  const note = row === null ? null : sellerNoteOf(row.sellerId);
  const simulated = row?.paymentProvider === "simulated";

  return (
    <li
      data-testid="review-queue-item"
      data-deal-code={item.code}
      className={cn("relative rounded-control border bg-surface transition-colors", focused ? "border-accent" : "border-hairline hover:border-hairline-strong")}
    >
      <button
        type="button"
        data-testid="review-queue-open"
        disabled={row === null}
        onClick={row === null ? undefined : () => context.openDeal(row.id)}
        aria-label={`Open deal ${item.code}: ${item.ask.toLowerCase()}`}
        className="flex w-full flex-col gap-1.5 rounded-control px-3 py-2.5 pr-11 text-left focus-ring disabled:cursor-default"
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-[13px] leading-5 font-semibold tracking-tight text-fg">{item.code}</span>
          <StatusPill tone="review" size="sm" icon={item.gate === "approval" ? <ShieldAlert aria-hidden="true" /> : <ScanSearch aria-hidden="true" />}>
            {item.ask}
          </StatusPill>
          {item.amountUsd === null ? null : (
            <span className="ml-auto flex items-center gap-1.5">
              {simulated ? (
                <Badge tone="neutral" variant="outline">
                  Simulated
                </Badge>
              ) : null}
              <Money amountMinor={Math.round(item.amountUsd * 100)} className="text-sm font-semibold text-fg" />
            </span>
          )}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-[18px] text-muted">
          {item.seller === null ? null : <span className="text-fg">{item.seller}</span>}
          {note === null ? null : (
            <Badge tone="hold" variant="outline" title={note} className="max-w-full">
              <span className="truncate">{note}</span>
            </Badge>
          )}
          {item.sinceMs === null ? null : (
            <span>
              waiting since <RelativeTime value={item.sinceMs} />
            </span>
          )}
        </span>
        {showReason && reason !== null ? <span className="text-xs leading-[18px] text-muted">{reason}</span> : null}
        <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-accent">
          Open deal to decide
          <ArrowUpRight aria-hidden="true" className="size-3.5" />
        </span>
      </button>
      {onFocusToggle === undefined ? null : (
        <button
          type="button"
          data-testid="review-queue-focus"
          aria-pressed={focused}
          aria-label={focused ? `Stop focusing the page on ${item.code}` : `Focus the page on ${item.code}`}
          title={focused ? "Clear the focus" : "Focus the page on this deal"}
          onClick={onFocusToggle}
          className={cn(
            "absolute top-2 right-2 flex size-7 items-center justify-center rounded-control border focus-ring [&_svg]:size-3.5",
            focused ? "border-accent bg-accent-soft text-accent" : "border-hairline bg-surface text-muted hover:bg-subtle hover:text-fg",
          )}
        >
          <Crosshair aria-hidden="true" />
        </button>
      )}
    </li>
  );
}
