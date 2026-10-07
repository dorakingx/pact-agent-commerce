import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { formatPercent } from "@/components/ui/format";
import { Money } from "@/components/ui/money";
import { TONE_CLASSES } from "@/components/ui/tone";
import { spendMeter } from "@/lib/client/policy-derive";
import { formatMoney } from "@/lib/domain/money";

export interface DailySpendCardProps {
  /** Authorized by this session's agent in the current UTC day (from the server). */
  spentTodayMinor: number;
  /** The daily limit in the form, or null while that field cannot be read. */
  limitMinor: number | null;
  /** The limit shown is an edit that has not been saved yet. */
  unsaved: boolean;
  className?: string;
}

/** Today's committed spend against the daily limit. */
export function DailySpendCard({ spentTodayMinor, limitMinor, unsaved, className }: DailySpendCardProps) {
  const meter = limitMinor === null ? null : spendMeter(spentTodayMinor, limitMinor);
  const tone = TONE_CLASSES[meter?.tone ?? "neutral"];
  return (
    <Card data-testid="policy-daily-spend" className={cn("px-5 py-4", className)}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[13px] leading-5 font-medium text-muted">Committed today</h2>
        <span className="text-xs leading-5 text-faint">Resets 00:00 UTC</span>
      </div>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <Money
          amountMinor={spentTodayMinor}
          mutedCents
          data-testid="policy-daily-spent"
          className="font-sans text-[1.625rem] leading-8 font-semibold tracking-[-0.02em] text-fg"
        />
        <span className="text-sm leading-5 text-muted">
          of{" "}
          {limitMinor === null ? (
            "—"
          ) : (
            <Money amountMinor={limitMinor} data-testid="policy-daily-limit-value" className="font-sans font-medium text-fg" />
          )}{" "}
          daily limit
        </span>
        {unsaved && limitMinor !== null ? (
          <Badge tone="hold" variant="outline">
            Unsaved
          </Badge>
        ) : null}
      </p>
      <div
        role="meter"
        aria-label="Daily limit used"
        aria-valuemin={0}
        aria-valuemax={100}
        // The role requires a value; while the limit is unreadable the text says so.
        aria-valuenow={meter === null ? 0 : Math.round(meter.ratio * 100)}
        aria-valuetext={
          meter === null || limitMinor === null
            ? "Unknown until the daily limit is a valid amount"
            : `${formatMoney(spentTodayMinor)} of ${formatMoney(limitMinor)} committed`
        }
        data-tone={meter?.tone ?? "unknown"}
        className="mt-3 h-2 overflow-hidden rounded-full bg-subtle-strong"
      >
        <div
          className={cn("h-full rounded-full transition-[width] duration-300 ease-out", tone.solid)}
          // A sliver stays visible once anything is committed, so "some" never looks like "none".
          style={{ width: meter === null ? 0 : `${Math.max(meter.ratio * 100, spentTodayMinor > 0 ? 1.5 : 0)}%` }}
        />
      </div>
      <p className="mt-2 text-xs leading-5 text-muted" data-testid="policy-daily-remaining">
        {meter === null ? (
          "Enter a valid daily limit to see what is left."
        ) : meter.overMinor > 0 ? (
          <span className={cn("font-medium", tone.text)}>
            {formatMoney(meter.overMinor)} over this limit. New deals are blocked until tomorrow.
          </span>
        ) : meter.remainingMinor === 0 ? (
          <span className={cn("font-medium", tone.text)}>Nothing left today. New deals are blocked until tomorrow.</span>
        ) : (
          <>
            <span className={cn("font-medium", meter.tone === "hold" ? tone.text : "text-fg")}>{formatMoney(meter.remainingMinor)}</span> left for
            the agent today · {formatPercent(meter.ratio)} used
          </>
        )}
      </p>
    </Card>
  );
}
