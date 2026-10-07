"use client";

import Link from "next/link";
import { ArrowRight, Inbox } from "lucide-react";
import { Button, Card, DealStatusPill, EmptyState, Money, RelativeTime, Skeleton } from "@/components/ui";
import { RequestError } from "@/components/deal/parts";
import type { DealSummary } from "@/lib/api/dto";
import { useDeals } from "@/lib/client/use-deals";

function Row({ deal }: { deal: DealSummary }) {
  return (
    <li>
      <Link
        href={`/deals/${deal.id}`}
        data-testid="deal-row"
        data-deal-id={deal.id}
        data-status={deal.status}
        className="block rounded-control px-3 py-3 transition-colors duration-150 focus-ring hover:bg-subtle"
      >
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <span className="font-mono text-xs font-semibold text-fg">{deal.code}</span>
          <DealStatusPill status={deal.status} size="sm" />
          <span className="ml-auto text-xs text-muted">
            <RelativeTime value={deal.updatedAt} />
          </span>
        </span>
        <span className="mt-1.5 line-clamp-2 text-sm leading-5 font-medium text-fg">{deal.title}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] leading-5 text-muted">
          <span>{deal.sellerName ?? "No seller matched"}</span>
          {deal.priceMinor === null ? null : (
            <>
              <span aria-hidden="true">·</span>
              <Money amountMinor={deal.priceMinor} className="text-fg" />
            </>
          )}
        </span>
      </Link>
    </li>
  );
}

function LoadingRows() {
  return (
    <ul aria-hidden="true" className="flex flex-col gap-1 p-2">
      {[0, 1, 2].map((row) => (
        <li key={row} className="px-3 py-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-2.5 h-4 w-full" />
          <Skeleton className="mt-2 h-3.5 w-32" />
        </li>
      ))}
    </ul>
  );
}

/** The deals this browser session has started, newest first. */
export function DealList() {
  const { deals, error, isLoading, refresh } = useDeals();
  return (
    <Card data-testid="deal-list" aria-busy={isLoading}>
      <header className="flex items-baseline justify-between gap-3 border-b border-hairline px-5 py-3.5">
        <h2 className="text-[15px] leading-6 font-semibold tracking-[-0.01em] text-fg">Your deals</h2>
        {deals && deals.length > 0 ? <span className="font-mono text-xs text-muted tabular-nums">{deals.length}</span> : null}
      </header>
      {error ? (
        <div className="p-4">
          <RequestError
            error={error}
            title="Your deals could not be loaded"
            action={
              <Button variant="secondary" size="sm" onClick={() => void refresh()}>
                Retry
              </Button>
            }
          />
        </div>
      ) : deals === undefined ? (
        <LoadingRows />
      ) : deals.length === 0 ? (
        <EmptyState
          as="h3"
          icon={<Inbox />}
          title="No deals yet"
          description="Deals you delegate from this browser appear here with their status, seller and price, and stay reachable for 30 days."
          className="py-10"
          data-testid="deal-list-empty"
        />
      ) : (
        <ul className="flex flex-col divide-y divide-hairline p-2">
          {deals.map((deal) => (
            <Row key={deal.id} deal={deal} />
          ))}
        </ul>
      )}
      <footer className="border-t border-hairline px-5 py-3">
        <Link
          href="/operations"
          data-testid="see-operations"
          className="inline-flex items-center gap-1.5 rounded-sm text-[13px] font-medium text-fg underline-offset-4 transition-colors duration-150 focus-ring hover:underline"
        >
          See all activity in Operations
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      </footer>
    </Card>
  );
}
