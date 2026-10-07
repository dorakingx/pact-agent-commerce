"use client";

/**
 * Cell renderers of the ledger grid. Each one renders a deal row and returns nothing (or the
 * sum) for the pinned totals row. Links and buttons inside cells are taken out of the tab order
 * (`tabIndex={-1}`): the grid owns keyboard focus, and Enter on a row opens the inspector,
 * which offers the same actions to keyboard users.
 */
import Link from "next/link";
import type { CustomCellRendererProps, CustomTooltipProps } from "ag-grid-react";
import { CircleCheck, Clock } from "lucide-react";
import {
  Badge,
  ConfidenceBar,
  DealStatusPill,
  Money,
  PaymentStatusPill,
  POLICY_OUTCOME_LABEL,
  POLICY_OUTCOME_TONE,
  RelativeTime,
  StatusPill,
  TONE_CLASSES,
  VERIFICATION_DECISION_LABEL,
  VERIFICATION_DECISION_TONE,
  cn,
  toast,
  truncateMiddle,
  type StatusTone,
} from "@/components/ui";
import {
  DEMO_FAULT_DETAIL,
  OUTCOME_LABEL,
  RISK_LABEL,
  approvalModeLabel,
  dealCountLabel,
  deadlineState,
  demoFaultOf,
  policyFlagLabel,
  providerLabel,
} from "@/lib/client/ops-derive";
import { DEADLINE_TONE, OUTCOME_TONE, RISK_TONE } from "../tones";
import type { LedgerRow } from "./ledger-rows";

type CellProps<TValue = unknown> = CustomCellRendererProps<LedgerRow, TValue>;

/** Every renderer fills the cell's height and centres its content, whatever the row height is. */
const CELL = "flex h-full min-w-0 items-center gap-1.5";

function Dash() {
  return (
    <span className="text-faint" aria-label="None">
      —
    </span>
  );
}

const LOCAL_DATE_TIME = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** "Oct 7, 18:00" in the viewer's own time zone. The grid only ever renders in the browser. */
export function formatLocalDateTime(value: Date): string {
  return Number.isNaN(value.getTime()) ? "Unknown time" : LOCAL_DATE_TIME.format(value);
}

export function DealCodeCell({ data }: CellProps<string>) {
  if (data?.kind === "total") return <span className={cn(CELL, "font-semibold text-fg")}>Total</span>;
  if (data?.kind !== "deal") return null;
  return (
    <span className={CELL}>
      <Link
        href={`/deals/${data.deal.id}`}
        tabIndex={-1}
        data-testid="ledger-deal-link"
        title="Open the deal"
        className="rounded-sm font-mono text-[13px] font-medium text-fg underline decoration-hairline-strong underline-offset-4 transition-colors duration-150 hover:text-accent hover:decoration-accent"
      >
        {data.deal.code}
      </Link>
    </span>
  );
}

export function TitleCell({ data }: CellProps<string>) {
  if (data?.kind === "total") {
    return <span className={cn(CELL, "text-muted")}>{dealCountLabel(data.totals.count)} shown</span>;
  }
  if (data?.kind !== "deal") return null;
  return (
    <span className={CELL}>
      <span className="truncate">{data.deal.title}</span>
    </span>
  );
}

export function StatusCell({ data }: CellProps<string>) {
  if (data?.kind !== "deal") return null;
  return (
    <span className={CELL}>
      <DealStatusPill status={data.deal.status} size="sm" />
    </span>
  );
}

export function OutcomeCell({ data }: CellProps<string>) {
  if (data?.kind !== "deal") return null;
  const { outcome } = data.deal;
  return (
    <span className={CELL}>
      <StatusPill tone={OUTCOME_TONE[outcome]} size="sm">
        {OUTCOME_LABEL[outcome]}
      </StatusPill>
    </span>
  );
}

export function SellerCell({ data }: CellProps<string>) {
  if (data?.kind !== "deal") return null;
  const { seller, sellerId, sellerTrust } = data.deal;
  const fault = demoFaultOf(sellerId);
  return (
    <span className={CELL}>
      <span className="truncate">{seller}</span>
      {sellerTrust === "new" ? (
        <Badge tone="review" title="New seller: no settled history with this buyer">
          New
        </Badge>
      ) : null}
      {fault ? (
        <Badge tone="danger" variant="outline" title={DEMO_FAULT_DETAIL[fault]}>
          Demo fault
        </Badge>
      ) : null}
    </span>
  );
}

export interface MoneyCellParams {
  /** Colours a non-zero amount: amber for money on hold, emerald for money captured or saved. */
  tone?: StatusTone;
}

export function MoneyCell({ data, value, tone }: CellProps<number | null> & MoneyCellParams) {
  if (data === undefined || data.kind === "group" || typeof value !== "number") return null;
  if (data.kind === "total") {
    return (
      <span className={cn(CELL, "justify-end")}>
        <Money amountMinor={value} className={cn("font-semibold", tone && value > 0 ? TONE_CLASSES[tone].text : "text-fg")} />
      </span>
    );
  }
  return (
    <span className={cn(CELL, "justify-end")}>
      {/* A zero is "nothing happened here", not an amount: the dash keeps the money columns scannable. */}
      {value === 0 ? <Dash /> : <Money amountMinor={value} className={tone ? TONE_CLASSES[tone].text : undefined} />}
    </span>
  );
}

export function PaymentCell({ data }: CellProps<string>) {
  if (data?.kind !== "deal") return null;
  return (
    <span className={CELL}>
      {data.deal.paymentStatus === "none" ? <Dash /> : <PaymentStatusPill status={data.deal.paymentStatus} size="sm" />}
    </span>
  );
}

export function RailCell({ data }: CellProps<string | null>) {
  if (data?.kind !== "deal") return null;
  const provider = providerLabel(data.deal.paymentProvider);
  const mode = approvalModeLabel(data.deal.paymentMode);
  if (provider === null) {
    return (
      <span className={CELL}>
        <Dash />
      </span>
    );
  }
  return (
    <span className={CELL}>
      <Badge tone={data.deal.paymentProvider === "simulated" ? "neutral" : "info"} variant="outline">
        {provider}
      </Badge>
      {mode ? <span className="truncate text-muted">{mode}</span> : null}
    </span>
  );
}

export function VerificationCell({ data }: CellProps<string | null>) {
  if (data?.kind !== "deal") return null;
  const decision = data.deal.verificationDecision;
  return (
    <span className={CELL}>
      {decision === null ? (
        <Dash />
      ) : (
        <StatusPill tone={VERIFICATION_DECISION_TONE[decision]} size="sm">
          {VERIFICATION_DECISION_LABEL[decision]}
        </StatusPill>
      )}
    </span>
  );
}

export function ConfidenceCell({ data }: CellProps<number | null>) {
  if (data?.kind !== "deal") return null;
  const { confidence, verificationDecision } = data.deal;
  if (confidence === null) {
    return (
      <span className={CELL}>
        <Dash />
      </span>
    );
  }
  // The bar takes the colour of the decision the score led to, so the two columns never disagree.
  const tone = verificationDecision === null ? "neutral" : VERIFICATION_DECISION_TONE[verificationDecision];
  return (
    <span className={CELL}>
      <ConfidenceBar value={confidence} tone={tone} label="Verifier confidence" className="w-full" />
    </span>
  );
}

export interface CountCellParams {
  /** Tone of a non-zero count (e.g. failed rules in red). */
  tone?: StatusTone;
}

export function CountCell({ data, value, tone }: CellProps<number | null> & CountCellParams) {
  if (data?.kind !== "deal" || typeof value !== "number") return null;
  return (
    <span className={cn(CELL, "justify-end font-mono tabular-nums", value === 0 ? "text-faint" : tone ? TONE_CLASSES[tone].text : "text-fg")}>
      {value}
    </span>
  );
}

export function PolicyCell({ data }: CellProps<string | null>) {
  if (data?.kind !== "deal") return null;
  const { policyOutcome, policyFlags } = data.deal;
  if (policyOutcome === null) {
    return (
      <span className={CELL}>
        <Dash />
      </span>
    );
  }
  return (
    <span className={CELL}>
      <StatusPill tone={POLICY_OUTCOME_TONE[policyOutcome]} size="sm">
        {POLICY_OUTCOME_LABEL[policyOutcome]}
      </StatusPill>
      {policyFlags.map((flag) => (
        <Badge key={flag} variant="outline">
          {policyFlagLabel(flag)}
        </Badge>
      ))}
    </span>
  );
}

export function RiskCell({ data }: CellProps<string>) {
  if (data?.kind !== "deal") return null;
  const { risk } = data.deal;
  return (
    <span className={CELL}>
      <StatusPill tone={RISK_TONE[risk]} size="sm">
        {RISK_LABEL[risk]}
      </StatusPill>
    </span>
  );
}

/** Grid tooltip for the risk column: one reason per line. The value is the reasons joined by line breaks. */
export function ReasonsTooltip({ value }: CustomTooltipProps<LedgerRow, string | null>) {
  const reasons = typeof value === "string" ? value.split("\n").filter((reason) => reason.length > 0) : [];
  if (reasons.length === 0) return null;
  return (
    <div className="max-w-xs rounded-md border border-white/10 bg-inverse px-3 py-2 text-xs leading-5 text-on-inverse shadow-pop">
      <p className="font-semibold">Why this deal is flagged</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-on-inverse-muted">
        {reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </div>
  );
}

export function DeadlineCell({ data, value }: CellProps<Date | null>) {
  if (data?.kind !== "deal") return null;
  if (!(value instanceof Date)) {
    return (
      <span className={CELL}>
        <Dash />
      </span>
    );
  }
  const { relative, urgency } = deadlineState(data.deal);
  return (
    <span className={CELL}>
      <span className="whitespace-nowrap tabular-nums">{formatLocalDateTime(value)}</span>
      {relative === null ? null : urgency === "none" ? (
        <span className="whitespace-nowrap text-muted">{relative}</span>
      ) : (
        <Badge tone={DEADLINE_TONE[urgency]} data-urgency={urgency}>
          <Clock aria-hidden="true" />
          {relative}
        </Badge>
      )}
    </span>
  );
}

export interface IdCellParams {
  /** What the id is, for the copy confirmation: "PayPal order id". */
  idLabel: string;
}

export function IdCell({ data, value, idLabel }: CellProps<string | null> & IdCellParams) {
  if (data?.kind !== "deal") return null;
  if (typeof value !== "string" || value.length === 0) {
    return (
      <span className={CELL}>
        <Dash />
      </span>
    );
  }
  async function copy(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      toast.success(`Copied ${idLabel}`, { description: id });
    } catch {
      // Clipboard access can be refused (permissions, insecure context); the inspector shows the full id.
      toast.error(`Could not copy the ${idLabel}`, { description: "Open the deal inspector to select it by hand." });
    }
  }
  return (
    <span className={CELL}>
      <button
        type="button"
        tabIndex={-1}
        title={`${value} — click to copy`}
        aria-label={`Copy ${idLabel} ${value}`}
        onClick={() => void copy(value)}
        className="cursor-copy truncate rounded-sm font-mono text-[12.5px] text-fg tabular-nums decoration-dotted underline-offset-4 hover:underline"
      >
        {truncateMiddle(value, 8, 6)}
      </button>
    </span>
  );
}

export function WebhookCell({ data }: CellProps<string>) {
  if (data?.kind !== "deal") return null;
  return (
    <span className={CELL}>
      {data.deal.webhookConfirmed ? (
        <span className="inline-flex items-center gap-1.5 text-success">
          <CircleCheck aria-hidden="true" className="size-3.5" />
          Confirmed
        </span>
      ) : (
        <Dash />
      )}
    </span>
  );
}

export function OriginCell({ data }: CellProps<string>) {
  if (data?.kind !== "deal") return null;
  const mine = data.deal.origin === "mine";
  return (
    <span className={CELL}>
      <Badge tone={mine ? "info" : "neutral"} variant={mine ? "soft" : "outline"}>
        {mine ? "Mine" : "Showcase"}
      </Badge>
    </span>
  );
}

export function DateTimeCell({ data, value }: CellProps<Date | null>) {
  if (data?.kind !== "deal") return null;
  return (
    <span className={cn(CELL, "whitespace-nowrap tabular-nums")}>{value instanceof Date ? formatLocalDateTime(value) : <Dash />}</span>
  );
}

export function UpdatedCell({ data, value }: CellProps<Date | null>) {
  if (data?.kind !== "deal") return null;
  return (
    <span className={cn(CELL, "whitespace-nowrap text-muted")}>
      {value instanceof Date ? <RelativeTime value={value} title={formatLocalDateTime(value)} /> : <Dash />}
    </span>
  );
}
