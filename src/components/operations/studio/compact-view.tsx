"use client";

import { ArrowUpRight, CircleCheck, MonitorSmartphone } from "lucide-react";
import { Callout } from "@/components/ui/callout";
import { Money } from "@/components/ui/money";
import { RelativeTime } from "@/components/ui/relative-time";
import { StatusPill } from "@/components/ui/status-pill";
import type { OpsSnapshot } from "@/lib/api/dto";
import { formatPercent } from "@/components/ui/format";
import { isAwaitingHuman, stopReasonOf } from "@/lib/client/studio-data";

export interface CompactViewProps {
  snapshot: OpsSnapshot;
  onOpenDeal: (dealId: string) => void;
}

/**
 * What a phone gets instead of the editor. AG Studio's drag-and-drop canvas needs room for its
 * panels and at least a 720px page, so below tablet width the dashboard says so and shows the
 * two things worth having in a pocket: the headline numbers and the deals waiting for a person.
 * Read-only, from the same snapshot.
 */
export function CompactView({ snapshot, onOpenDeal }: CompactViewProps) {
  const { totals } = snapshot;
  const waiting = snapshot.deals.filter((deal) => isAwaitingHuman(deal.status)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const tiles: { label: string; value: React.ReactNode }[] = [
    { label: "Authorized now held", value: <Money amountMinor={totals.heldMinor} /> },
    { label: "Captured", value: <Money amountMinor={totals.capturedMinor} /> },
    { label: "Released back", value: <Money amountMinor={totals.releasedMinor} /> },
    { label: "Deals awaiting a human", value: <span className="font-mono tabular-nums">{totals.pendingHumanReview}</span> },
    { label: "First-pass verification rate", value: <span className="font-mono tabular-nums">{formatPercent(totals.firstPassRate)}</span> },
  ];
  return (
    <div data-testid="studio-compact" className="flex flex-col gap-4">
      <Callout tone="info" icon={<MonitorSmartphone />} title="The dashboard editor needs a wider screen">
        The drag-and-drop AG Studio report and its agents open at tablet width and above. Here is the read-only summary.
      </Callout>

      <dl className="grid grid-cols-2 gap-2">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-card border border-hairline bg-surface px-3 py-2.5 last:col-span-2">
            <dd className="text-xl leading-7 font-semibold text-fg">{tile.value}</dd>
            <dt className="text-xs leading-[18px] text-muted">{tile.label}</dt>
          </div>
        ))}
      </dl>

      <section aria-labelledby="compact-queue-title" className="rounded-card border border-hairline bg-surface">
        <h3 id="compact-queue-title" className="border-b border-hairline px-3 py-2.5 text-sm font-semibold text-fg">
          Human review queue
        </h3>
        {waiting.length === 0 ? (
          <p className="flex items-center gap-2 px-3 py-4 text-sm text-muted">
            <CircleCheck aria-hidden="true" className="size-4 text-success" />
            Nobody is waiting on you.
          </p>
        ) : (
          <ul className="divide-y divide-hairline">
            {waiting.map((deal) => (
              <li key={deal.id}>
                <button
                  type="button"
                  data-testid="compact-queue-open"
                  onClick={() => onOpenDeal(deal.id)}
                  className="flex min-h-11 w-full flex-col gap-1 px-3 py-2.5 text-left focus-ring"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[13px] font-semibold text-fg">{deal.code}</span>
                    <StatusPill tone="review" size="sm">
                      {deal.status === "awaiting_approval" ? "Approve or decline" : "Review delivery"}
                    </StatusPill>
                    <Money amountMinor={deal.priceMinor} className="ml-auto text-sm font-semibold text-fg" />
                  </span>
                  <span className="text-xs leading-[18px] text-muted">
                    {deal.seller} · waiting since <RelativeTime value={deal.updatedAt} />
                  </span>
                  <span className="text-xs leading-[18px] text-muted">{stopReasonOf(deal)}</span>
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-accent">
                    Open deal to decide <ArrowUpRight aria-hidden="true" className="size-3.5" />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
