"use client";

/**
 * Controls above the ledger grid: status segments, search, "Only mine", grouping, the column
 * chooser, and the export / reset actions. Purely presentational: the ledger owns the state
 * and talks to the grid.
 */
import { useId } from "react";
import { ChartNoAxesColumn, Columns3, Download, RotateCcw, Search, X } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  cn,
} from "@/components/ui";
import {
  GROUP_BYS,
  GROUP_BY_LABEL,
  SEGMENTS,
  SEGMENT_LABEL,
  isGroupBy,
  type CrossFilter,
  type CrossFilterChip,
  type LedgerGroupBy,
  type SegmentId,
} from "@/lib/client/ops-derive";

export interface ColumnChoice {
  colId: string;
  label: string;
  /** Always shown (the deal code): listed, but not switchable. */
  locked: boolean;
}

export interface LedgerToolbarProps {
  segment: SegmentId;
  segmentCounts: Record<SegmentId, number>;
  onSegmentChange: (segment: SegmentId) => void;
  search: string;
  onSearchChange: (value: string) => void;
  onlyMine: boolean;
  onOnlyMineChange: (value: boolean) => void;
  groupBy: LedgerGroupBy;
  onGroupByChange: (groupBy: LedgerGroupBy) => void;
  columns: readonly ColumnChoice[];
  visibleColumns: ReadonlySet<string>;
  onColumnToggle: (colId: string, visible: boolean) => void;
  onShowDefaultColumns: () => void;
  chartsOpen: boolean;
  onChartsToggle: () => void;
  onExport: () => void;
  onReset: () => void;
  /** Deals the filters let through, and deals in the ledger. */
  shown: number;
  total: number;
  /** Any filter at all is narrowing the ledger. */
  filtered: boolean;
}

export function LedgerToolbar({
  segment,
  segmentCounts,
  onSegmentChange,
  search,
  onSearchChange,
  onlyMine,
  onOnlyMineChange,
  groupBy,
  onGroupByChange,
  columns,
  visibleColumns,
  onColumnToggle,
  onShowDefaultColumns,
  chartsOpen,
  onChartsToggle,
  onExport,
  onReset,
  shown,
  total,
  filtered,
}: LedgerToolbarProps) {
  const mineId = useId();
  const shownColumns = columns.filter((column) => visibleColumns.has(column.colId)).length;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="group" aria-label="Filter deals by state" className="flex flex-wrap gap-1.5">
          {SEGMENTS.map((id) => {
            const active = id === segment;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={active}
                data-testid={`ledger-segment-${id}`}
                onClick={() => onSegmentChange(id)}
                className={cn(
                  "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] font-medium whitespace-nowrap transition-colors duration-150 ease-out focus-ring pointer-coarse:min-h-11",
                  active
                    ? "border-accent/40 bg-accent-soft text-accent"
                    : "border-hairline bg-surface text-muted hover:border-hairline-strong hover:text-fg",
                )}
              >
                {SEGMENT_LABEL[id]}
                <span className={cn("font-mono text-xs tabular-nums", active ? "text-accent" : "text-faint")}>{segmentCounts[id]}</span>
              </button>
            );
          })}
        </div>
        <p aria-live="polite" data-testid="ledger-count" className="ml-auto text-xs text-muted tabular-nums">
          {filtered ? `Showing ${shown} of ${total} deals` : `${total} ${total === 1 ? "deal" : "deals"}`}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" />
          <Input
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search deals, sellers, PayPal ids…"
            aria-label="Search the ledger"
            data-testid="ledger-search"
            autoComplete="off"
            spellCheck={false}
            className="h-8 pr-8 pl-8 text-[13px] [&::-webkit-search-cancel-button]:appearance-none"
          />
          {search.length > 0 ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => onSearchChange("")}
              className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-faint transition-colors duration-150 focus-ring hover:bg-subtle hover:text-fg"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          ) : null}
        </div>

        <div className="flex h-8 items-center gap-2 pr-1 pl-0.5">
          <Switch id={mineId} checked={onlyMine} onCheckedChange={onOnlyMineChange} data-testid="ledger-only-mine" />
          <Label htmlFor={mineId} className="text-[13px] font-medium whitespace-nowrap text-fg">
            Only mine
          </Label>
        </div>

        <Select value={groupBy} onValueChange={(value) => (isGroupBy(value) ? onGroupByChange(value) : undefined)}>
          <SelectTrigger size="sm" aria-label="Group rows by" data-testid="ledger-group-by" className="w-auto min-w-40 gap-1.5">
            <span className="flex items-center gap-1.5">
              <span className="text-muted">Group</span>
              <SelectValue />
            </span>
          </SelectTrigger>
          <SelectContent>
            {GROUP_BYS.map((id) => (
              <SelectItem key={id} value={id} data-testid={`ledger-group-by-${id}`}>
                {GROUP_BY_LABEL[id]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm" data-testid="ledger-columns">
              <Columns3 aria-hidden="true" />
              Columns
              <span className="font-mono text-xs text-muted tabular-nums">
                {shownColumns}/{columns.length}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="bottom"
            className="flex max-h-[min(26rem,var(--radix-dropdown-menu-content-available-height))] w-60 flex-col p-0"
          >
            <DropdownMenuLabel className="px-3 pt-2.5 pb-1.5">Columns in the ledger</DropdownMenuLabel>
            <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
              {columns.map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.colId}
                  checked={visibleColumns.has(column.colId)}
                  disabled={column.locked}
                  data-testid={`ledger-column-${column.colId}`}
                  // Keep the menu open: choosing columns is rarely a single click.
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(checked) => onColumnToggle(column.colId, checked === true)}
                >
                  {column.label}
                </DropdownMenuCheckboxItem>
              ))}
            </div>
            <DropdownMenuSeparator className="mx-0 my-0" />
            <div className="p-1">
              <DropdownMenuItem onSelect={onShowDefaultColumns} data-testid="ledger-columns-default">
                <RotateCcw aria-hidden="true" />
                Show the default columns
              </DropdownMenuItem>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="secondary"
          size="sm"
          aria-pressed={chartsOpen}
          onClick={onChartsToggle}
          data-testid="ledger-charts-toggle"
          className={cn(chartsOpen && "border-accent/40 bg-accent-soft text-accent hover:bg-accent-soft")}
        >
          <ChartNoAxesColumn aria-hidden="true" />
          Charts
        </Button>

        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="secondary" size="sm" onClick={onExport} data-testid="ledger-export">
            <Download aria-hidden="true" />
            Export CSV
          </Button>
          <Button variant="ghost" size="sm" onClick={onReset} data-testid="ledger-reset">
            <RotateCcw aria-hidden="true" />
            Reset view
          </Button>
        </div>
      </div>
    </div>
  );
}

export interface LedgerFilterChipsProps {
  chips: readonly CrossFilterChip[];
  onRemoveChip: (key: keyof CrossFilter) => void;
  /** Number of columns with a column filter set in the grid. */
  columnFilterCount: number;
  onClearColumnFilters: () => void;
  onClearAll: () => void;
}

function Chip({ label, removeLabel, onRemove, testId }: { label: string; removeLabel: string; onRemove: () => void; testId: string }) {
  return (
    <span
      data-testid={testId}
      className="inline-flex h-7 items-center gap-1 rounded-full border border-accent/30 bg-accent-soft pr-1 pl-2.5 text-xs font-medium text-accent"
    >
      {label}
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        className="relative flex size-5 items-center justify-center rounded-full transition-colors duration-150 focus-ring hover:bg-accent/15 pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-['']"
      >
        <X aria-hidden="true" className="size-3" />
      </button>
    </span>
  );
}

/** The line above the grid that names the chart and column filters in force. Renders nothing while there are none. */
export function LedgerFilterChips({
  chips,
  onRemoveChip,
  columnFilterCount,
  onClearColumnFilters,
  onClearAll,
}: LedgerFilterChipsProps) {
  // The segment, the search box and "Only mine" show their own state; this line is for the filters that would otherwise be easy to miss.
  if (chips.length === 0 && columnFilterCount === 0) return null;
  return (
    <div data-testid="ledger-chips" className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="text-xs font-medium text-muted">Filtered by</span>
      {chips.map((chip) => (
        <Chip
          key={chip.key}
          testId={`ledger-chip-${chip.key}`}
          label={chip.label}
          removeLabel={`Remove filter ${chip.label}`}
          onRemove={() => onRemoveChip(chip.key)}
        />
      ))}
      {columnFilterCount > 0 ? (
        <Chip
          testId="ledger-chip-columns"
          label={`${columnFilterCount} column ${columnFilterCount === 1 ? "filter" : "filters"}`}
          removeLabel="Clear the column filters"
          onRemove={onClearColumnFilters}
        />
      ) : null}
      <button
        type="button"
        onClick={onClearAll}
        data-testid="ledger-clear-filters"
        className="h-7 rounded-md px-1.5 text-xs font-medium text-muted underline decoration-hairline-strong underline-offset-4 transition-colors duration-150 focus-ring hover:text-fg"
      >
        Clear all filters
      </button>
    </div>
  );
}
