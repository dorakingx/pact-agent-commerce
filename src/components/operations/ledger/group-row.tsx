"use client";

/**
 * Full-width group header row. Grouping in the ledger is built on AG Grid Community (rows are
 * arranged after the grid's own filter and sort), so the header's figures are computed by PACT
 * from the same filtered rows the grid shows and reach this renderer through React context.
 */
import { createContext, useContext } from "react";
import type { CustomCellRendererProps } from "ag-grid-react";
import { ChevronRight, FlaskConical } from "lucide-react";
import { Badge, DealStatusPill, Money, StatusPill, cn } from "@/components/ui";
import type { RiskLevel } from "@/lib/api/dto";
import {
  DEMO_FAULT_BY_SELLER,
  dealCountLabel,
  groupLabel,
  type LedgerGroup,
  type OpsOutcome,
} from "@/lib/client/ops-derive";
import { DEAL_STATUSES, type DealStatus } from "@/lib/domain/status";
import { OUTCOME_TONE, RISK_TONE } from "../tones";
import type { GroupLedgerRow, LedgerRow } from "./ledger-rows";

export interface LedgerGroupState {
  /** Summary per group header row id, over the rows the filters let through. */
  groups: ReadonlyMap<string, LedgerGroup>;
  /** Row ids of the collapsed groups. */
  collapsed: ReadonlySet<string>;
  toggle: (rowId: string) => void;
  /** Seller name → seller id, to label demo-fault sellers when grouping by seller. */
  sellerIds: ReadonlyMap<string, string>;
}

export const LedgerGroupContext = createContext<LedgerGroupState>({
  groups: new Map(),
  collapsed: new Set(),
  toggle: () => undefined,
  sellerIds: new Map(),
});

function isDealStatus(key: string): key is DealStatus {
  return (DEAL_STATUSES as readonly string[]).includes(key);
}

function GroupLabel({ row, sellerIds }: { row: GroupLedgerRow; sellerIds: ReadonlyMap<string, string> }) {
  const label = groupLabel(row.by, row.groupKey);
  if (row.by === "status" && isDealStatus(row.groupKey)) return <DealStatusPill status={row.groupKey} size="sm" />;
  if (row.by === "outcome" && Object.hasOwn(OUTCOME_TONE, row.groupKey)) {
    return (
      <StatusPill tone={OUTCOME_TONE[row.groupKey as OpsOutcome]} size="sm">
        {label}
      </StatusPill>
    );
  }
  if (row.by === "risk" && Object.hasOwn(RISK_TONE, row.groupKey)) {
    return (
      <StatusPill tone={RISK_TONE[row.groupKey as RiskLevel]} size="sm">
        {label}
      </StatusPill>
    );
  }
  const sellerId = sellerIds.get(row.groupKey);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate font-semibold text-fg">{label}</span>
      {row.by === "seller" && sellerId !== undefined && Object.hasOwn(DEMO_FAULT_BY_SELLER, sellerId) ? (
        <Badge tone="danger" variant="outline">
          <FlaskConical aria-hidden="true" />
          Demo fault
        </Badge>
      ) : null}
    </span>
  );
}

function Sum({ label, amountMinor, className }: { label: string; amountMinor: number; className?: string }) {
  return (
    <span className={cn("flex items-baseline gap-1.5 whitespace-nowrap", className)}>
      <span className="text-xs text-muted">{label}</span>
      <Money amountMinor={amountMinor} className={cn("text-[13px] font-medium", amountMinor === 0 ? "text-faint" : "text-fg")} />
    </span>
  );
}

export function GroupRow({ data }: CustomCellRendererProps<LedgerRow>) {
  const { groups, collapsed, toggle, sellerIds } = useContext(LedgerGroupContext);
  if (data?.kind !== "group") return null;
  const group = groups.get(data.id);
  const open = !collapsed.has(data.id);
  const label = groupLabel(data.by, data.groupKey);
  return (
    // The whole row toggles on click; the button carries the accessible name and state.
    <div
      data-testid="ledger-group-row"
      data-group={data.groupKey}
      data-state={open ? "open" : "collapsed"}
      onClick={() => toggle(data.id)}
      className="flex h-full cursor-pointer items-center gap-3 bg-subtle/70 pr-4 pl-2 select-none"
    >
      <button
        type="button"
        tabIndex={-1}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} group ${label}`}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-subtle-strong hover:text-fg"
      >
        <ChevronRight aria-hidden="true" className={cn("size-4 transition-transform duration-150", open && "rotate-90")} />
      </button>
      <GroupLabel row={data} sellerIds={sellerIds} />
      <span className="text-[13px] whitespace-nowrap text-muted tabular-nums">{dealCountLabel(group?.count ?? 0)}</span>
      {group ? (
        <span className="ml-auto flex items-center gap-5">
          <Sum label="Price" amountMinor={group.priceMinor} className="max-md:hidden" />
          <Sum label="Authorized" amountMinor={group.authorizedMinor} className="max-sm:hidden" />
          <Sum label="Captured" amountMinor={group.capturedMinor} />
        </span>
      ) : null}
    </div>
  );
}
