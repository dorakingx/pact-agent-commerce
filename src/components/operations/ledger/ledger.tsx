"use client";

/**
 * The Ledger tab: AG Grid Community doing the operator's work — multi-sort, per-column and quick
 * filters, an external filter for the status segments and chart cross-filters, CSV export and a
 * persisted column layout — plus two things Community does not ship, built on its public hooks:
 *
 *  - Grouping. Group headers are ordinary rows rendered full width. They always pass the
 *    filters (`alwaysPassFilter`), and `postSortRows` arranges the filtered, sorted rows as
 *    "header, members, header, …", dropping headers of empty groups and members of collapsed
 *    ones. Because collapsing happens after filtering, `forEachNodeAfterFilter` still yields
 *    every deal the filters let through.
 *  - Totals. That filtered set is lifted into React state on every model update and feeds the
 *    pinned totals row, the group summaries and the charts, so all of them describe exactly the
 *    rows the grid would show.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  AllCommunityModule,
  type CellKeyDownEvent,
  type ColDef,
  type ColumnResizedEvent,
  type ColumnState,
  type ColumnVisibleEvent,
  type FilterChangedEvent,
  type FullWidthCellKeyDownEvent,
  type GetRowIdParams,
  type GridApi,
  type GridReadyEvent,
  type IRowNode,
  type IsFullWidthRowParams,
  type ModelUpdatedEvent,
  type OverlayType,
  type PostSortRowsParams,
  type RowClassRules,
  type RowClickedEvent,
} from "ag-grid-community";
import { AgGridProvider, AgGridReact } from "ag-grid-react";
import { SearchX } from "lucide-react";
import { Button, Kbd, toast } from "@/components/ui";
import type { OpsRow, OpsSnapshot } from "@/lib/api/dto";
import {
  DEFAULT_LEDGER_FILTER,
  LEDGER_LAYOUT_STORAGE_KEY,
  arrangeGrouped,
  buildGroups,
  compareGroupKeys,
  crossFilterChips,
  dealCountLabel,
  indexChecks,
  isLedgerFilterActive,
  parseLayout,
  passesLedgerFilter,
  segmentCounts,
  serializeLayout,
  sumLedger,
  toggleCrossFilter,
  type CheckFilter,
  type CheckIndex,
  type CrossFilter,
  type LedgerFilter,
  type LedgerGroup,
  type LedgerGroupBy,
  type OpsOutcome,
  type SegmentId,
  type StoredColumn,
  type StoredLayout,
} from "@/lib/client/ops-derive";
import { LedgerCharts } from "./charts";
import { LEDGER_COLUMN_CHOICES, LEDGER_COLUMN_DEFS, LEDGER_COLUMN_IDS, ledgerCsvCell } from "./columns";
import { ledgerTheme } from "./grid-theme";
import { GroupRow, LedgerGroupContext, type LedgerGroupState } from "./group-row";
import {
  TOTAL_ROW_ID,
  buildLedgerRows,
  describeLedgerRow,
  groupKeyFromRowId,
  groupRowId,
  groupingOf,
  type LedgerRow,
} from "./ledger-rows";
import { LedgerFilterChips, LedgerToolbar } from "./toolbar";

const GRID_MODULES = [AllCommunityModule];
const EMPTY_KEYS: ReadonlySet<string> = new Set();
/** The ledger draws its own "nothing matches" state, with a way out; the grid's overlays stay off. */
const SUPPRESSED_OVERLAYS: OverlayType[] = ["noRows", "noMatchingRows"];
const LAYOUT_SAVE_DELAY_MS = 250;
/** Below this width the pinned deal column would take a third of the grid, so it scrolls with the rest. */
const NARROW_QUERY = "(max-width: 639px)";
/** Below the `md` breakpoint the chart row becomes a single column. */
const STACKED_CHARTS_QUERY = "(max-width: 767px)";

const DEFAULT_COL_DEF: ColDef<LedgerRow> = {
  sortable: true,
  resizable: true,
  floatingFilter: true,
  // The floating filter row is the filter UI; a second filter button in every header is noise.
  suppressHeaderFilterButton: true,
  suppressHeaderMenuButton: true,
  // Values come from value getters; the grid must not guess types and swap in its own cell editors or formats.
  cellDataType: false,
  minWidth: 90,
  filterParams: { debounceMs: 200, maxNumConditions: 2 },
};

function readStoredLayout(): StoredLayout | null {
  if (typeof window === "undefined") return null;
  try {
    return parseLayout(window.localStorage.getItem(LEDGER_LAYOUT_STORAGE_KEY), LEDGER_COLUMN_IDS);
  } catch {
    // Storage can be blocked (private mode, policy): the ledger then simply starts from its defaults.
    return null;
  }
}

function writeStoredLayout(layout: StoredLayout): void {
  try {
    window.localStorage.setItem(LEDGER_LAYOUT_STORAGE_KEY, serializeLayout(layout));
  } catch {
    // Not persisted; the layout still applies for this visit.
  }
}

function clearStoredLayout(): void {
  try {
    window.localStorage.removeItem(LEDGER_LAYOUT_STORAGE_KEY);
  } catch {
    // Nothing was stored, or storage is unavailable: either way there is nothing to clear.
  }
}

function toStoredColumns(state: readonly ColumnState[]): StoredColumn[] {
  return state.map((column) => ({
    colId: column.colId,
    hide: column.hide === true,
    width: typeof column.width === "number" ? column.width : null,
    sort: column.sort === "asc" || column.sort === "desc" ? column.sort : null,
    sortIndex: typeof column.sortIndex === "number" ? column.sortIndex : null,
    pinned: column.pinned === "left" || column.pinned === "right" ? column.pinned : null,
  }));
}

function toColumnState(column: StoredColumn): ColumnState {
  return {
    colId: column.colId,
    hide: column.hide,
    width: column.width ?? undefined,
    sort: column.sort,
    sortIndex: column.sortIndex,
    pinned: column.pinned,
  };
}

function visibleColumnsOf(api: GridApi<LedgerRow>): ReadonlySet<string> {
  return new Set(
    api
      .getColumnState()
      .filter((column) => column.hide !== true)
      .map((column) => column.colId),
  );
}

function initialVisibleColumns(layout: StoredLayout | null): ReadonlySet<string> {
  const hidden = new Set(layout?.columns.filter((column) => column.hide).map((column) => column.colId));
  const stored = new Set(layout?.columns.map((column) => column.colId));
  return new Set(
    LEDGER_COLUMN_CHOICES.filter((choice) => (stored.has(choice.colId) ? !hidden.has(choice.colId) : choice.defaultVisible)).map(
      (choice) => choice.colId,
    ),
  );
}

function sameRows(a: readonly OpsRow[], b: readonly OpsRow[]): boolean {
  return a.length === b.length && a.every((row, index) => row === b[index]);
}

/** "2026-10-06" in the operator's own time zone: the day they exported on, as they would name it. */
function localDayStamp(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** How long the download's object URL is kept: long enough for every browser to have started reading it. */
const DOWNLOAD_URL_TTL_MS = 10_000;

function downloadCsv(fileName: string, csv: string): void {
  // The byte-order mark makes spreadsheet apps read the file as UTF-8 (titles contain "·").
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_TTL_MS);
}

/** A deal row opens the inspector on click; the pointer says so. Group and totals rows keep the default cursor. */
const ROW_CLASS_RULES: RowClassRules<LedgerRow> = {
  "cursor-pointer": (params) => params.data?.kind === "deal",
};

const getRowId = (params: GetRowIdParams<LedgerRow>): string => params.data.id;
const isFullWidthRow = (params: IsFullWidthRowParams<LedgerRow>): boolean => params.rowNode.data?.kind === "group";
/** Group headers are not deals: no text, number or date filter may remove them. Empty ones are dropped when rows are arranged. */
const alwaysPassFilter = (node: IRowNode<LedgerRow>): boolean => node.data?.kind === "group";

export interface LedgerProps {
  snapshot: OpsSnapshot;
  onOpenDeal: (dealId: string) => void;
}

export default function Ledger({ snapshot, onOpenDeal }: LedgerProps) {
  const [storedLayout] = useState(readStoredLayout);
  const [filter, setFilter] = useState<LedgerFilter>(DEFAULT_LEDGER_FILTER);
  const [search, setSearch] = useState("");
  const quickFilter = useDeferredValue(search.trim());
  const [groupBy, setGroupBy] = useState<LedgerGroupBy>(storedLayout?.groupBy ?? "none");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(EMPTY_KEYS);
  const [filteredRows, setFilteredRows] = useState<readonly OpsRow[]>(snapshot.deals);
  const [visibleColumns, setVisibleColumns] = useState<ReadonlySet<string>>(() => initialVisibleColumns(storedLayout));
  const [columnFilterCount, setColumnFilterCount] = useState(0);
  // Four stacked charts would push the grid several screens down on a phone; there they start folded away.
  const [chartsOpen, setChartsOpen] = useState(() => typeof window === "undefined" || !window.matchMedia(STACKED_CHARTS_QUERY).matches);
  const [popupParent] = useState<HTMLElement | null>(() => (typeof document === "undefined" ? null : document.body));

  const checks = useMemo(() => indexChecks(snapshot.checks), [snapshot.checks]);
  const rowData = useMemo(() => buildLedgerRows(snapshot.deals, groupBy), [snapshot.deals, groupBy]);

  // The grid calls its filter and sort hooks outside React's render cycle; refs give those
  // stable callbacks the current values without re-creating (and re-running) them.
  const apiRef = useRef<GridApi<LedgerRow> | null>(null);
  const filterRef = useRef<LedgerFilter>(filter);
  const checksRef = useRef<CheckIndex>(checks);
  const collapsedRef = useRef<ReadonlySet<string>>(collapsed);
  const groupByRef = useRef<LedgerGroupBy>(groupBy);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    filterRef.current = filter;
    checksRef.current = checks;
    apiRef.current?.onFilterChanged();
  }, [filter, checks]);

  useEffect(
    () => () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    },
    [],
  );

  /* ----------------------------- grid callbacks ----------------------------- */

  const isExternalFilterPresent = useCallback(() => isLedgerFilterActive(filterRef.current), []);
  const doesExternalFilterPass = useCallback(
    (node: IRowNode<LedgerRow>) => node.data?.kind !== "deal" || passesLedgerFilter(node.data.deal, filterRef.current, checksRef.current),
    [],
  );

  const postSortRows = useCallback((params: PostSortRowsParams<LedgerRow>) => {
    // The grouping is read from the rows themselves, so it can never disagree with the row data the grid holds.
    const by = groupingOf(params.nodes.map((node) => node.data));
    if (by === null) return;
    const arranged = arrangeGrouped(
      params.nodes,
      (node) => describeLedgerRow(node.data, by),
      (a, b) => compareGroupKeys(by, groupKeyFromRowId(by, a), groupKeyFromRowId(by, b)),
      collapsedRef.current,
    );
    // `postSortRows` works by mutating `nodes` in place. Reordering is its documented use; leaving rows
    // out works because the grid displays exactly this array (its own copy of the filtered rows, in
    // ag-grid-community 36.2). Rows left out are still part of the filtered set, which is what the
    // totals and charts read.
    params.nodes.length = 0;
    params.nodes.push(...arranged);
  }, []);

  const syncFilteredRows = useCallback((api: GridApi<LedgerRow>) => {
    const next: OpsRow[] = [];
    api.forEachNodeAfterFilter((node) => {
      if (node.data?.kind === "deal") next.push(node.data.deal);
    });
    setFilteredRows((previous) => (sameRows(previous, next) ? previous : next));
  }, []);

  const scheduleLayoutSave = useCallback(() => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const api = apiRef.current;
      if (api === null || api.isDestroyed()) return;
      writeStoredLayout({ columns: toStoredColumns(api.getColumnState()), groupBy: groupByRef.current });
    }, LAYOUT_SAVE_DELAY_MS);
  }, []);

  const handleGridReady = useCallback(
    (event: GridReadyEvent<LedgerRow>) => {
      apiRef.current = event.api;
      if (storedLayout !== null) {
        event.api.applyColumnState({ state: storedLayout.columns.map(toColumnState), applyOrder: true });
      } else if (window.matchMedia(NARROW_QUERY).matches) {
        event.api.applyColumnState({ state: [{ colId: "code", pinned: null }] });
      }
      setVisibleColumns(visibleColumnsOf(event.api));
    },
    [storedLayout],
  );

  const handleGridPreDestroyed = useCallback(() => {
    apiRef.current = null;
  }, []);

  const handleModelUpdated = useCallback((event: ModelUpdatedEvent<LedgerRow>) => syncFilteredRows(event.api), [syncFilteredRows]);

  const handleFilterChanged = useCallback((event: FilterChangedEvent<LedgerRow>) => {
    setColumnFilterCount(Object.keys(event.api.getFilterModel()).length);
  }, []);

  /**
   * Persist what the operator did by hand. Changes made through the API (restoring a stored
   * layout, unpinning for a narrow screen, a reset) are not the operator's choice and are not
   * written back; the handlers that call the API on the operator's behalf save explicitly.
   */
  const handleColumnLayoutEvent = useCallback(
    (event: { source: string }) => {
      if (event.source !== "api" && event.source !== "gridOptionsChanged") scheduleLayoutSave();
    },
    [scheduleLayoutSave],
  );

  const handleColumnResized = useCallback(
    (event: ColumnResizedEvent<LedgerRow>) => {
      if (event.finished) handleColumnLayoutEvent(event);
    },
    [handleColumnLayoutEvent],
  );

  const handleColumnVisible = useCallback(
    (event: ColumnVisibleEvent<LedgerRow>) => {
      setVisibleColumns(visibleColumnsOf(event.api));
      handleColumnLayoutEvent(event);
    },
    [handleColumnLayoutEvent],
  );

  const toggleGroup = useCallback((rowId: string) => {
    const next = new Set(collapsedRef.current);
    if (!next.delete(rowId)) next.add(rowId);
    collapsedRef.current = next;
    setCollapsed(next);
    apiRef.current?.refreshClientSideRowModel("sort");
  }, []);

  const handleRowClicked = useCallback(
    (event: RowClickedEvent<LedgerRow>) => {
      if (event.data?.kind !== "deal") return;
      const target = event.event?.target;
      // A click on the deal link or on a copyable id belongs to that control, not to the row.
      if (target instanceof Element && target.closest("a, button") !== null) return;
      onOpenDeal(event.data.deal.id);
    },
    [onOpenDeal],
  );

  const handleCellKeyDown = useCallback(
    (event: CellKeyDownEvent<LedgerRow> | FullWidthCellKeyDownEvent<LedgerRow>) => {
      const keyboard = event.event;
      if (!(keyboard instanceof KeyboardEvent) || keyboard.altKey || keyboard.ctrlKey || keyboard.metaKey) return;
      if (event.data?.kind === "deal" && keyboard.key === "Enter") {
        keyboard.preventDefault();
        onOpenDeal(event.data.deal.id);
      } else if (event.data?.kind === "group" && (keyboard.key === "Enter" || keyboard.key === " ")) {
        keyboard.preventDefault();
        toggleGroup(event.data.id);
      }
    },
    [onOpenDeal, toggleGroup],
  );

  /* ------------------------------ toolbar actions --------------------------- */

  const changeSegment = useCallback((segment: SegmentId) => setFilter((current) => ({ ...current, segment })), []);
  const changeOnlyMine = useCallback((onlyMine: boolean) => setFilter((current) => ({ ...current, onlyMine })), []);

  const changeGroupBy = useCallback(
    (next: LedgerGroupBy) => {
      groupByRef.current = next;
      setGroupBy(next);
      scheduleLayoutSave();
    },
    [scheduleLayoutSave],
  );

  const toggleColumn = useCallback(
    (colId: string, visible: boolean) => {
      apiRef.current?.setColumnsVisible([colId], visible);
      scheduleLayoutSave();
    },
    [scheduleLayoutSave],
  );

  const showDefaultColumns = useCallback(() => {
    const api = apiRef.current;
    if (api === null) return;
    api.applyColumnState({ state: LEDGER_COLUMN_CHOICES.map((choice) => ({ colId: choice.colId, hide: !choice.defaultVisible })) });
    scheduleLayoutSave();
  }, [scheduleLayoutSave]);

  const setCross = useCallback(<K extends keyof CrossFilter>(key: K, value: CrossFilter[K]) => {
    setFilter((current) => ({ ...current, cross: toggleCrossFilter(current.cross, key, value) }));
  }, []);
  const filterBySeller = useCallback((seller: string) => setCross("seller", seller), [setCross]);
  const filterByOutcome = useCallback((outcome: OpsOutcome) => setCross("outcome", outcome), [setCross]);
  const filterByCheck = useCallback((check: CheckFilter) => setCross("check", check), [setCross]);
  const filterByDay = useCallback((day: string) => setCross("day", day), [setCross]);
  const removeChip = useCallback((key: keyof CrossFilter) => {
    setFilter((current) => ({ ...current, cross: { ...current.cross, [key]: null } }));
  }, []);

  const clearColumnFilters = useCallback(() => apiRef.current?.setFilterModel(null), []);

  const clearAllFilters = useCallback(() => {
    setFilter(DEFAULT_LEDGER_FILTER);
    setSearch("");
    apiRef.current?.setFilterModel(null);
  }, []);

  const resetView = useCallback(() => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    clearStoredLayout();
    groupByRef.current = "none";
    collapsedRef.current = EMPTY_KEYS;
    setGroupBy("none");
    setCollapsed(EMPTY_KEYS);
    setFilter(DEFAULT_LEDGER_FILTER);
    setSearch("");
    const api = apiRef.current;
    if (api !== null) {
      api.resetColumnState();
      api.setFilterModel(null);
      if (window.matchMedia(NARROW_QUERY).matches) api.applyColumnState({ state: [{ colId: "code", pinned: null }] });
      setVisibleColumns(visibleColumnsOf(api));
    }
    toast.success("Ledger view reset", { description: "Columns, sorting, grouping and filters are back to their defaults." });
  }, []);

  const exportCsv = useCallback(() => {
    const api = apiRef.current;
    if (api === null) return;
    // Collapsing a group is a way of reading the ledger, not a filter: the file holds every deal
    // the filters let through, so groups are expanded for the duration of the export.
    const collapsedNow = collapsedRef.current;
    if (collapsedNow.size > 0) {
      collapsedRef.current = EMPTY_KEYS;
      api.refreshClientSideRowModel("sort");
    }
    let exported = 0;
    // The synchronous variant: the grid's own download is deferred, and by then the groups would be collapsed again.
    const csv = api.getDataAsCsv({
      skipPinnedBottom: true,
      shouldRowBeSkipped: (params) => params.node.data?.kind !== "deal",
      processCellCallback: (params) => {
        const row: LedgerRow | undefined = params.node?.data;
        if (row?.kind !== "deal") return "";
        // The callback runs once per cell; the pinned first column counts the rows.
        if (params.column.getColId() === "code") exported += 1;
        return ledgerCsvCell(params.column.getColId(), row.deal);
      },
    });
    if (collapsedNow.size > 0) {
      collapsedRef.current = collapsedNow;
      api.refreshClientSideRowModel("sort");
    }
    if (csv === undefined) {
      toast.error("The CSV could not be created");
      return;
    }
    downloadCsv(`pact-ledger-${localDayStamp(new Date())}.csv`, csv);
    toast.success(`Exported ${dealCountLabel(exported)} to CSV`, { description: "The file has the columns, filters and sort order of the current view." });
  }, []);

  /* --------------------------------- derived -------------------------------- */

  const counts = useMemo(
    () => segmentCounts(filter.onlyMine ? snapshot.deals.filter((deal) => deal.origin === "mine") : snapshot.deals),
    [snapshot.deals, filter.onlyMine],
  );
  const pinnedBottomRowData = useMemo<LedgerRow[]>(
    () => [{ kind: "total", id: TOTAL_ROW_ID, totals: sumLedger(filteredRows) }],
    [filteredRows],
  );
  const groupState = useMemo<LedgerGroupState>(() => {
    const groups = new Map<string, LedgerGroup>();
    if (groupBy !== "none") {
      for (const group of buildGroups(filteredRows, groupBy)) groups.set(groupRowId(groupBy, group.key), group);
    }
    return {
      groups,
      collapsed,
      toggle: toggleGroup,
      sellerIds: new Map(snapshot.deals.map((deal) => [deal.seller, deal.sellerId])),
    };
  }, [filteredRows, groupBy, collapsed, toggleGroup, snapshot.deals]);
  const chips = useMemo(() => crossFilterChips(filter.cross), [filter.cross]);
  const narrowed = isLedgerFilterActive(filter) || quickFilter.length > 0 || columnFilterCount > 0;

  return (
    <div data-testid="ledger" className="flex flex-col gap-4">
      <h2 className="sr-only">Ledger</h2>
      <LedgerToolbar
        segment={filter.segment}
        segmentCounts={counts}
        onSegmentChange={changeSegment}
        search={search}
        onSearchChange={setSearch}
        onlyMine={filter.onlyMine}
        onOnlyMineChange={changeOnlyMine}
        groupBy={groupBy}
        onGroupByChange={changeGroupBy}
        columns={LEDGER_COLUMN_CHOICES}
        visibleColumns={visibleColumns}
        onColumnToggle={toggleColumn}
        onShowDefaultColumns={showDefaultColumns}
        chartsOpen={chartsOpen}
        onChartsToggle={() => setChartsOpen((open) => !open)}
        onExport={exportCsv}
        onReset={resetView}
        shown={filteredRows.length}
        total={snapshot.deals.length}
        filtered={narrowed}
      />

      {chartsOpen ? (
        <LedgerCharts
          rows={filteredRows}
          checks={snapshot.checks}
          cross={filter.cross}
          onSeller={filterBySeller}
          onOutcome={filterByOutcome}
          onCheck={filterByCheck}
          onDay={filterByDay}
        />
      ) : null}

      <LedgerFilterChips
        chips={chips}
        onRemoveChip={removeChip}
        columnFilterCount={columnFilterCount}
        onClearColumnFilters={clearColumnFilters}
        onClearAll={clearAllFilters}
      />

      <section aria-label="Deal ledger" className="overflow-hidden rounded-card border border-hairline bg-surface">
        <div data-testid="ledger-grid" className="relative h-[clamp(26rem,calc(100dvh-14rem),40rem)]">
          <LedgerGroupContext.Provider value={groupState}>
            <AgGridProvider modules={GRID_MODULES}>
              <AgGridReact<LedgerRow>
                theme={ledgerTheme}
                rowData={rowData}
                columnDefs={LEDGER_COLUMN_DEFS}
                defaultColDef={DEFAULT_COL_DEF}
                getRowId={getRowId}
                quickFilterText={quickFilter}
                cacheQuickFilter
                includeHiddenColumnsInQuickFilter
                isExternalFilterPresent={isExternalFilterPresent}
                doesExternalFilterPass={doesExternalFilterPass}
                alwaysPassFilter={alwaysPassFilter}
                postSortRows={postSortRows}
                isFullWidthRow={isFullWidthRow}
                fullWidthCellRenderer={GroupRow}
                pinnedBottomRowData={pinnedBottomRowData}
                rowClassRules={ROW_CLASS_RULES}
                suppressOverlays={SUPPRESSED_OVERLAYS}
                popupParent={popupParent}
                tooltipShowDelay={350}
                // Rows in the DOM in the order they are shown, so a screen reader reads the ledger top to bottom.
                ensureDomOrder
                suppressDragLeaveHidesColumns
                onGridReady={handleGridReady}
                onGridPreDestroyed={handleGridPreDestroyed}
                onModelUpdated={handleModelUpdated}
                onFilterChanged={handleFilterChanged}
                onRowClicked={handleRowClicked}
                onCellKeyDown={handleCellKeyDown}
                onSortChanged={handleColumnLayoutEvent}
                onColumnMoved={handleColumnLayoutEvent}
                onColumnPinned={handleColumnLayoutEvent}
                onColumnResized={handleColumnResized}
                onColumnVisible={handleColumnVisible}
              />
            </AgGridProvider>
          </LedgerGroupContext.Provider>
          {filteredRows.length === 0 ? (
            <div className="pointer-events-none absolute inset-x-0 top-24 bottom-12 flex items-center justify-center px-6">
              <div data-testid="ledger-no-match" className="pointer-events-auto flex max-w-sm flex-col items-center text-center">
                <SearchX aria-hidden="true" className="mb-3 size-6 text-faint" />
                <p className="text-sm font-semibold text-fg">No deals match these filters</p>
                <p className="mt-1 text-[13px] leading-5 text-muted">
                  The segment, search, chart filters and column filters apply together. Clear them to see the whole ledger again.
                </p>
                <Button variant="secondary" size="sm" className="mt-4" onClick={clearAllFilters}>
                  Clear all filters
                </Button>
              </div>
            </div>
          ) : null}
        </div>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-hairline px-4 py-2.5 text-xs text-muted">
          <span className="max-sm:hidden">
            <Kbd>Shift</Kbd> + click a header to sort by several columns
          </span>
          <span className="max-sm:hidden">
            <Kbd>Enter</Kbd> or a click on a row opens the deal inspector
          </span>
          <span className="sm:ml-auto">Totals follow the filters. Amounts in USD.</span>
        </p>
      </section>
    </div>
  );
}
