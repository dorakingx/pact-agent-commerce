"use client";

/**
 * Column definitions of the ledger. One declarative spec per column produces everything the
 * grid needs from it: the sortable value, the filter (text, number in dollars, or date), the
 * quick-filter text, the totals-row value and the CSV cell — so a column can never sort by one
 * thing, search by another and export a third.
 */
import type { ColDef, IDateFilterParams, IRowNode } from "ag-grid-community";
import { POLICY_OUTCOME_LABEL, VERIFICATION_DECISION_LABEL } from "@/components/ui";
import type { OpsRow } from "@/lib/api/dto";
import {
  CATEGORY_LABEL,
  OUTCOME_LABEL,
  OUTCOME_ORDER,
  RISK_LABEL,
  RISK_ORDER,
  STAGE_LABEL,
  STAGE_ORDER,
  csvText,
  deadlineState,
  minorToDecimal,
  policyFlagLabel,
  railLabel,
  revisionsLabel,
  type LedgerTotals,
} from "@/lib/client/ops-derive";
import { formatMoney } from "@/lib/domain/money";
import { DEAL_STATUSES, PAYMENT_STATUSES, PAYMENT_STATUS_LABEL } from "@/lib/domain/status";
import {
  ConfidenceCell,
  CountCell,
  DateTimeCell,
  DeadlineCell,
  DealCodeCell,
  IdCell,
  MoneyCell,
  OriginCell,
  OutcomeCell,
  PaymentCell,
  PolicyCell,
  RailCell,
  ReasonsTooltip,
  RiskCell,
  SellerCell,
  StatusCell,
  TitleCell,
  UpdatedCell,
  VerificationCell,
  WebhookCell,
  formatLocalDateTime,
  type CountCellParams,
  type IdCellParams,
  type MoneyCellParams,
} from "./cells";
import type { LedgerRow } from "./ledger-rows";

type LedgerColDef = ColDef<LedgerRow>;
type CellValue = string | number | Date | null;

interface ColumnSpec {
  colId: string;
  headerName: string;
  kind: "text" | "money" | "number" | "date";
  /** The value the column sorts and filters by. */
  value: (deal: OpsRow) => CellValue;
  /** Value shown in the pinned totals row; omitted for columns that have no meaningful sum. */
  total?: (totals: LedgerTotals) => CellValue;
  /** Overrides the default CSV cell (the value as text). */
  csv?: (deal: OpsRow) => string;
  width: number;
  /** Hidden until the operator turns it on in the column chooser. */
  hidden?: boolean;
  def?: LedgerColDef;
}

function dealOf(node: IRowNode<LedgerRow>): OpsRow | null {
  return node.data?.kind === "deal" ? node.data.deal : null;
}

/** Sort by a rank derived from the deal instead of by the label the cell shows (lifecycle order, urgency…). */
function compareByRank(rank: (deal: OpsRow) => number): LedgerColDef["comparator"] {
  return (_a, _b, nodeA, nodeB) => {
    const a = dealOf(nodeA);
    const b = dealOf(nodeB);
    return (a === null ? -1 : rank(a)) - (b === null ? -1 : rank(b));
  };
}

function toDate(iso: string | null): Date | null {
  if (iso === null) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The date filter picks a calendar day; a cell matches when its timestamp falls on that day, local time. */
const DATE_FILTER_PARAMS: IDateFilterParams = {
  comparator: (filterLocalDateAtMidnight: Date, cellValue: unknown) => {
    if (!(cellValue instanceof Date)) return -1;
    const cellDay = new Date(cellValue.getFullYear(), cellValue.getMonth(), cellValue.getDate()).getTime();
    const filterDay = filterLocalDateAtMidnight.getTime();
    return cellDay === filterDay ? 0 : cellDay < filterDay ? -1 : 1;
  },
  maxNumConditions: 1,
};

const moneyParams = (params: MoneyCellParams): MoneyCellParams => params;
const countParams = (params: CountCellParams): CountCellParams => params;
const idParams = (params: IdCellParams): IdCellParams => params;

const SPECS: readonly ColumnSpec[] = [
  {
    colId: "code",
    headerName: "Deal",
    kind: "text",
    value: (deal) => deal.code,
    total: () => "Total",
    width: 110,
    def: { cellRenderer: DealCodeCell, initialPinned: "left", lockVisible: true, suppressMovable: true },
  },
  {
    colId: "title",
    headerName: "Title",
    kind: "text",
    value: (deal) => deal.title,
    total: (totals) => `${totals.count}`,
    width: 196,
    def: { cellRenderer: TitleCell, tooltipValueGetter: (params) => (params.data?.kind === "deal" ? params.data.deal.title : null) },
  },
  {
    colId: "status",
    headerName: "Status",
    kind: "text",
    value: (deal) => deal.statusLabel,
    width: 222,
    def: { cellRenderer: StatusCell, comparator: compareByRank((deal) => DEAL_STATUSES.indexOf(deal.status)) },
  },
  {
    colId: "stage",
    headerName: "Stage",
    kind: "text",
    value: (deal) => STAGE_LABEL[deal.stage],
    width: 130,
    hidden: true,
    def: { comparator: compareByRank((deal) => STAGE_ORDER.indexOf(deal.stage)) },
  },
  {
    colId: "outcome",
    headerName: "Outcome",
    kind: "text",
    value: (deal) => OUTCOME_LABEL[deal.outcome],
    width: 140,
    hidden: true,
    def: { cellRenderer: OutcomeCell, comparator: compareByRank((deal) => OUTCOME_ORDER.indexOf(deal.outcome)) },
  },
  { colId: "buyer", headerName: "Buyer", kind: "text", value: (deal) => deal.buyer, width: 210, hidden: true },
  {
    colId: "seller",
    headerName: "Seller",
    kind: "text",
    value: (deal) => deal.seller,
    width: 240,
    def: { cellRenderer: SellerCell },
  },
  {
    colId: "category",
    headerName: "Category",
    kind: "text",
    value: (deal) => (deal.category === null ? null : CATEGORY_LABEL[deal.category]),
    width: 130,
    hidden: true,
  },
  {
    colId: "price",
    headerName: "Price",
    kind: "money",
    value: (deal) => deal.priceMinor,
    total: (totals) => totals.priceMinor,
    width: 98,
    def: { headerTooltip: "Contract price. Empty until a contract exists." },
  },
  {
    colId: "listPrice",
    headerName: "Opening quote",
    kind: "money",
    value: (deal) => deal.listPriceMinor,
    total: (totals) => totals.listPriceMinor,
    width: 138,
    hidden: true,
    def: { headerTooltip: "The seller agent's first offer" },
  },
  {
    colId: "saved",
    headerName: "Saved",
    kind: "money",
    value: (deal) => deal.savedMinor,
    total: (totals) => totals.savedMinor,
    width: 108,
    hidden: true,
    def: { headerTooltip: "Opening quote minus the agreed price", cellRendererParams: moneyParams({ tone: "success" }) },
  },
  {
    colId: "authorized",
    headerName: "Authorized",
    kind: "money",
    value: (deal) => deal.authorizedMinor,
    total: (totals) => totals.authorizedMinor,
    width: 110,
    def: { headerTooltip: "Amount PayPal authorized for this deal" },
  },
  {
    colId: "held",
    headerName: "Held",
    kind: "money",
    value: (deal) => deal.heldMinor,
    total: (totals) => totals.heldMinor,
    width: 96,
    def: {
      headerTooltip: "Authorized and still on hold: not captured, not released",
      cellRendererParams: moneyParams({ tone: "hold" }),
    },
  },
  {
    colId: "captured",
    headerName: "Captured",
    kind: "money",
    value: (deal) => deal.capturedMinor,
    total: (totals) => totals.capturedMinor,
    width: 104,
    def: {
      headerTooltip: "Captured after the delivery was verified",
      cellRendererParams: moneyParams({ tone: "success" }),
    },
  },
  {
    colId: "payment",
    headerName: "Payment",
    kind: "text",
    value: (deal) => PAYMENT_STATUS_LABEL[deal.paymentStatus],
    width: 146,
    def: { cellRenderer: PaymentCell, comparator: compareByRank((deal) => PAYMENT_STATUSES.indexOf(deal.paymentStatus)) },
  },
  {
    colId: "rail",
    headerName: "Rail",
    kind: "text",
    value: (deal) => railLabel(deal),
    width: 260,
    hidden: true,
    def: { cellRenderer: RailCell, headerTooltip: "Payment provider and how the payer approved" },
  },
  {
    colId: "verification",
    headerName: "Verification",
    kind: "text",
    value: (deal) => (deal.verificationDecision === null ? null : VERIFICATION_DECISION_LABEL[deal.verificationDecision]),
    width: 160,
    def: { cellRenderer: VerificationCell, headerTooltip: "Decision of the latest verification report" },
  },
  {
    colId: "confidence",
    headerName: "Confidence",
    kind: "number",
    // Whole percent, so the number filter reads the way the cell does ("greater than 85").
    value: (deal) => (deal.confidence === null ? null : Math.round(deal.confidence * 100)),
    csv: (deal) => (deal.confidence === null ? "" : deal.confidence.toFixed(2)),
    width: 146,
    // A bar reads left to right, so this numeric column keeps the default (left) alignment.
    def: { type: [], cellRenderer: ConfidenceCell, headerTooltip: "Weakest required check of the latest report, in percent" },
  },
  {
    colId: "failedRules",
    headerName: "Failed rules",
    kind: "number",
    value: (deal) => deal.failedRules,
    width: 124,
    hidden: true,
    def: { cellRenderer: CountCell, cellRendererParams: countParams({ tone: "danger" }) },
  },
  {
    colId: "revisions",
    headerName: "Revisions",
    kind: "number",
    value: (deal) => deal.revisionsUsed,
    csv: (deal) => revisionsLabel(deal),
    width: 116,
    hidden: true,
    def: {
      headerTooltip: "Revision rounds used / allowed by the contract",
      valueFormatter: (params) => (params.data?.kind === "deal" ? revisionsLabel(params.data.deal) : ""),
      cellClass: "font-mono tabular-nums",
    },
  },
  {
    colId: "moves",
    headerName: "Negotiation moves",
    kind: "number",
    value: (deal) => deal.negotiationMoves,
    width: 164,
    hidden: true,
    def: { cellRenderer: CountCell },
  },
  {
    colId: "guardrails",
    headerName: "Guardrails",
    kind: "number",
    value: (deal) => deal.guardrailInterventions,
    width: 118,
    hidden: true,
    def: {
      cellRenderer: CountCell,
      cellRendererParams: countParams({ tone: "review" }),
      headerTooltip: "Negotiation moves the rules engine had to correct",
    },
  },
  {
    colId: "policy",
    headerName: "Policy",
    kind: "text",
    value: (deal) =>
      deal.policyOutcome === null
        ? null
        : [POLICY_OUTCOME_LABEL[deal.policyOutcome], ...deal.policyFlags.map(policyFlagLabel)].join(" · "),
    width: 270,
    hidden: true,
    def: { cellRenderer: PolicyCell, headerTooltip: "Spending-policy result and the checks that did not pass" },
  },
  {
    colId: "humanDecisions",
    headerName: "Human decisions",
    kind: "number",
    value: (deal) => deal.humanDecisions,
    width: 152,
    hidden: true,
    def: { cellRenderer: CountCell },
  },
  {
    colId: "risk",
    headerName: "Risk",
    kind: "text",
    value: (deal) => RISK_LABEL[deal.risk],
    csv: (deal) => [RISK_LABEL[deal.risk], ...deal.riskReasons].join("; "),
    width: 104,
    def: {
      cellRenderer: RiskCell,
      comparator: compareByRank((deal) => RISK_ORDER.length - RISK_ORDER.indexOf(deal.risk)),
      tooltipValueGetter: (params) =>
        params.data?.kind === "deal" && params.data.deal.riskReasons.length > 0 ? params.data.deal.riskReasons.join("\n") : null,
      tooltipComponent: ReasonsTooltip,
    },
  },
  {
    colId: "deadline",
    headerName: "Deadline",
    kind: "date",
    value: (deal) => toDate(deal.deadline),
    width: 214,
    def: {
      cellRenderer: DeadlineCell,
      // The countdown is searchable too: typing "overdue" finds the late deals.
      getQuickFilterText: (params) => {
        if (params.data?.kind !== "deal") return "";
        const date = toDate(params.data.deal.deadline);
        return date === null ? "" : `${formatLocalDateTime(date)} ${deadlineState(params.data.deal).relative ?? ""}`;
      },
    },
  },
  {
    colId: "orderId",
    headerName: "PayPal order id",
    kind: "text",
    value: (deal) => deal.paypalOrderId,
    width: 176,
    hidden: true,
    def: { cellRenderer: IdCell, cellRendererParams: idParams({ idLabel: "PayPal order id" }) },
  },
  {
    colId: "authorizationId",
    headerName: "Authorization id",
    kind: "text",
    value: (deal) => deal.paypalAuthorizationId,
    width: 176,
    hidden: true,
    def: { cellRenderer: IdCell, cellRendererParams: idParams({ idLabel: "authorization id" }) },
  },
  {
    colId: "captureId",
    headerName: "Capture id",
    kind: "text",
    value: (deal) => deal.paypalCaptureId,
    width: 176,
    hidden: true,
    def: { cellRenderer: IdCell, cellRendererParams: idParams({ idLabel: "capture id" }) },
  },
  {
    colId: "webhook",
    headerName: "Webhook confirmed",
    kind: "text",
    value: (deal) => (deal.webhookConfirmed ? "Confirmed" : "Not confirmed"),
    width: 170,
    hidden: true,
    def: { cellRenderer: WebhookCell, headerTooltip: "PayPal confirmed a payment event through a verified webhook" },
  },
  {
    colId: "origin",
    headerName: "Origin",
    kind: "text",
    value: (deal) => (deal.origin === "mine" ? "Mine" : "Showcase"),
    width: 118,
    hidden: true,
    def: { cellRenderer: OriginCell },
  },
  {
    colId: "created",
    headerName: "Created",
    kind: "date",
    value: (deal) => toDate(deal.createdAt),
    width: 168,
    hidden: true,
    def: { cellRenderer: DateTimeCell },
  },
  {
    colId: "updated",
    headerName: "Updated",
    kind: "date",
    value: (deal) => toDate(deal.updatedAt),
    width: 140,
    def: { cellRenderer: UpdatedCell, initialSort: "desc" },
  },
];

function csvOf(spec: ColumnSpec, deal: OpsRow): string {
  if (spec.csv) return csvText(spec.csv(deal));
  const value = spec.value(deal);
  if (value === null) return "";
  if (value instanceof Date) return value.toISOString();
  if (spec.kind === "money" && typeof value === "number") return minorToDecimal(value);
  return typeof value === "number" ? String(value) : csvText(value);
}

function searchTextOf(spec: ColumnSpec, deal: OpsRow): string {
  const value = spec.value(deal);
  if (value === null) return "";
  if (value instanceof Date) return formatLocalDateTime(value);
  // "$47.00" and "47.00" both find a 4700-cent amount.
  if (spec.kind === "money" && typeof value === "number") return `${formatMoney(value)} ${minorToDecimal(value)}`;
  return String(value);
}

function toColDef(spec: ColumnSpec): LedgerColDef {
  const base: LedgerColDef = {
    colId: spec.colId,
    headerName: spec.headerName,
    initialWidth: spec.width,
    initialHide: spec.hidden === true,
    valueGetter: (params) => {
      if (params.data?.kind === "deal") return spec.value(params.data.deal);
      if (params.data?.kind === "total") return spec.total?.(params.data.totals) ?? null;
      return null;
    },
    getQuickFilterText: (params) => (params.data?.kind === "deal" ? searchTextOf(spec, params.data.deal) : ""),
  };
  switch (spec.kind) {
    case "text":
      return { ...base, filter: "agTextColumnFilter", ...spec.def };
    case "money":
      return {
        ...base,
        type: "rightAligned",
        filter: "agNumberColumnFilter",
        // Filters are typed in dollars ("greater than 40"), not in cents.
        filterValueGetter: (params) => (params.data?.kind === "deal" ? Number(minorToDecimal(Number(spec.value(params.data.deal)))) : null),
        cellRenderer: MoneyCell,
        ...spec.def,
      };
    case "number":
      return { ...base, type: "rightAligned", filter: "agNumberColumnFilter", ...spec.def };
    case "date":
      return { ...base, filter: "agDateColumnFilter", filterParams: DATE_FILTER_PARAMS, ...spec.def };
    default:
      return base;
  }
}

/** Columns in their default order. */
export const LEDGER_COLUMN_DEFS: LedgerColDef[] = SPECS.map(toColDef);

export const LEDGER_COLUMN_IDS: readonly string[] = SPECS.map((spec) => spec.colId);

/** For the column chooser: every column the operator may show or hide, with its default. */
export const LEDGER_COLUMN_CHOICES: readonly { colId: string; label: string; locked: boolean; defaultVisible: boolean }[] = SPECS.map(
  (spec) => ({
    colId: spec.colId,
    label: spec.headerName,
    locked: spec.def?.lockVisible === true,
    defaultVisible: spec.hidden !== true,
  }),
);

const SPEC_BY_ID: ReadonlyMap<string, ColumnSpec> = new Map(SPECS.map((spec) => [spec.colId, spec]));

/** The CSV cell of one column for one deal; empty for a column the ledger does not know. */
export function ledgerCsvCell(colId: string, deal: OpsRow): string {
  const spec = SPEC_BY_ID.get(colId);
  return spec ? csvOf(spec, deal) : "";
}
