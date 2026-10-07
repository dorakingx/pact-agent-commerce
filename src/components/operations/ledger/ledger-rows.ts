/**
 * The row model the ledger grid works on. AG Grid Community has no row grouping, so a group
 * header is simply one more row in the data (rendered full width), and the totals line is a
 * pinned row. Every callback the grid is given tells the three kinds apart by `kind`.
 */
import type { OpsRow } from "@/lib/api/dto";
import {
  groupKeyOf,
  type ActiveGroupBy,
  type GroupedItem,
  type LedgerGroupBy,
  type LedgerTotals,
} from "@/lib/client/ops-derive";

export interface DealLedgerRow {
  kind: "deal";
  id: string;
  deal: OpsRow;
}

export interface GroupLedgerRow {
  kind: "group";
  /** Also the key collapse state is stored under, so it survives a regrouping and a refresh. */
  id: string;
  by: ActiveGroupBy;
  groupKey: string;
}

export interface TotalLedgerRow {
  kind: "total";
  id: string;
  totals: LedgerTotals;
}

export type LedgerRow = DealLedgerRow | GroupLedgerRow | TotalLedgerRow;

export const TOTAL_ROW_ID = "ledger-total";

export function groupRowId(by: ActiveGroupBy, groupKey: string): string {
  return `group:${by}:${groupKey}`;
}

/** Inverse of `groupRowId` for ids of the given grouping. */
export function groupKeyFromRowId(by: ActiveGroupBy, rowId: string): string {
  return rowId.slice(groupRowId(by, "").length);
}

/**
 * Row data for the grid: every deal, plus one header row per group when grouping is on.
 * Headers are created for all groups in the snapshot; the ones the filters leave empty are
 * taken out again when the rows are arranged.
 */
export function buildLedgerRows(deals: readonly OpsRow[], groupBy: LedgerGroupBy): LedgerRow[] {
  const rows: LedgerRow[] = deals.map((deal) => ({ kind: "deal", id: deal.id, deal }));
  if (groupBy === "none") return rows;
  const keys = new Set(deals.map((deal) => groupKeyOf(deal, groupBy)));
  for (const groupKey of keys) rows.push({ kind: "group", id: groupRowId(groupBy, groupKey), by: groupBy, groupKey });
  return rows;
}

/** The grouping in force for a list of rows: the one its header rows were built for. */
export function groupingOf(rows: readonly (LedgerRow | undefined)[]): ActiveGroupBy | null {
  for (const row of rows) {
    if (row?.kind === "group") return row.by;
  }
  return null;
}

/** How `arrangeGrouped` should treat a row. Keyed by row id, so collapse state can be looked up directly. */
export function describeLedgerRow(row: LedgerRow | undefined, by: ActiveGroupBy): GroupedItem {
  if (row?.kind === "group") return { header: true, group: row.id };
  if (row?.kind === "deal") return { header: false, group: groupRowId(by, groupKeyOf(row.deal, by)) };
  // A row without data cannot be placed in a group; an id no header has keeps it visible.
  return { header: false, group: "" };
}
