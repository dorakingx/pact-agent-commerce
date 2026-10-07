import { ArrowRight, BadgeCheck, LockKeyhole, Undo2 } from "lucide-react";
import { Money, cn } from "@/components/ui";
import type { FundsPhase, FundsView } from "@/lib/client/deal-derive";
import { formatMoney } from "@/lib/domain/money";

/*
 * The two figures that carry the product's promise: what is HELD (authorized, not captured)
 * and what has MOVED (captured). They appear twice, large in the payment section and compact
 * in the sticky bar, and both are drawn from the same FundsView so they can never disagree.
 */

const CONNECTOR_LABEL: Record<FundsPhase, string> = {
  none: "only after verification",
  pending: "only after verification",
  held: "only after verification",
  captured: "verified, then captured",
  released: "hold released",
  closed: "nothing was held",
  failed: "payment failed",
};

function heldCaption(funds: FundsView, sellerName: string): string {
  switch (funds.phase) {
    case "none":
      return "Nothing is held yet. No PayPal order exists.";
    case "pending":
      return "The order exists, but the payer has not approved the hold.";
    case "held":
      return `Reserved on the payer's PayPal account for ${sellerName}. Not captured.`;
    case "captured":
      return "The hold was settled by the capture.";
    case "released":
      return `${formatMoney(funds.releasedMinor)} was released back to the payer.`;
    case "closed":
      return "The order ended before any funds were held.";
    case "failed":
      return "The payment provider reported a failure.";
    default: {
      const exhaustive: never = funds.phase;
      return exhaustive;
    }
  }
}

function capturedCaption(funds: FundsView, sellerName: string): string {
  switch (funds.phase) {
    case "captured":
      return funds.releasedMinor > 0
        ? `Paid to ${sellerName}. The remaining ${formatMoney(funds.releasedMinor)} was released to the payer.`
        : `Paid to ${sellerName} after the delivery was verified.`;
    case "released":
    case "closed":
      return "Nothing was captured.";
    case "failed":
      return funds.capturedMinor > 0 ? `Paid to ${sellerName}.` : "Nothing was captured.";
    case "none":
    case "pending":
    case "held":
      return "Nothing has moved. Capture requires a verified delivery.";
    default: {
      const exhaustive: never = funds.phase;
      return exhaustive;
    }
  }
}

function Figure({
  testId,
  label,
  icon,
  amountMinor,
  caption,
  active,
  tone,
}: {
  testId: string;
  label: string;
  icon: React.ReactNode;
  amountMinor: number;
  caption: string;
  active: boolean;
  tone: "hold" | "success";
}) {
  const live = tone === "hold" ? "border-hold/45 bg-hold-soft" : "border-success/40 bg-success-soft";
  const liveText = tone === "hold" ? "text-hold" : "text-success";
  return (
    <div
      data-testid={testId}
      data-active={active}
      data-amount-minor={amountMinor}
      // Remounting on activation replays the pop, which is the cue that the money just changed state.
      key={active ? "active" : "idle"}
      className={cn(
        "flex min-w-0 flex-1 flex-col rounded-card border px-4 py-3.5 sm:px-5 sm:py-4",
        active ? cn(live, "animate-pop-in") : "border-hairline bg-subtle/60",
      )}
    >
      <p
        className={cn(
          "flex items-center gap-1.5 font-mono text-[11px] leading-4 font-medium tracking-[0.08em] uppercase [&_svg]:size-3.5",
          active ? liveText : "text-faint",
        )}
      >
        {icon}
        {label}
      </p>
      <p className="mt-2">
        <Money
          amountMinor={amountMinor}
          mutedCents
          className={cn(
            "font-sans text-[2rem] leading-none font-semibold tracking-[-0.03em] sm:text-[2.5rem]",
            active ? "text-fg" : "text-faint",
          )}
        />
      </p>
      <p className={cn("mt-2 text-[13px] leading-5", active ? "text-fg/80" : "text-muted")}>{caption}</p>
    </div>
  );
}

/** The large pair of figures in the payment section. */
export function FundsFigures({ funds, sellerName }: { funds: FundsView; sellerName: string }) {
  const held = funds.phase === "held";
  const captured = funds.phase === "captured" || (funds.phase === "failed" && funds.capturedMinor > 0);
  return (
    <div
      data-testid="funds-figures"
      data-phase={funds.phase}
      className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-stretch sm:gap-3"
    >
      <Figure
        testId="figure-held"
        label="Authorized (held)"
        icon={<LockKeyhole aria-hidden="true" />}
        amountMinor={funds.heldMinor}
        caption={heldCaption(funds, sellerName)}
        active={held}
        tone="hold"
      />
      <div
        aria-hidden="true"
        className="flex shrink-0 items-center justify-center gap-2 text-faint sm:w-24 sm:flex-col sm:gap-1.5"
      >
        <ArrowRight className={cn("size-4 rotate-90 sm:rotate-0", captured && "text-success")} />
        <span className="text-center font-mono text-[10px] leading-3.5 font-medium tracking-[0.06em] uppercase">
          {CONNECTOR_LABEL[funds.phase]}
        </span>
      </div>
      <Figure
        testId="figure-captured"
        label="Captured"
        icon={<BadgeCheck aria-hidden="true" />}
        amountMinor={funds.capturedMinor}
        caption={capturedCaption(funds, sellerName)}
        active={captured}
        tone="success"
      />
    </div>
  );
}

function SummaryCell({
  testId,
  label,
  icon,
  amountMinor,
  className,
}: {
  testId: string;
  label: string;
  icon: React.ReactNode;
  amountMinor: number;
  className: string;
}) {
  return (
    <p data-testid={testId} data-amount-minor={amountMinor} className="flex min-w-0 flex-col">
      <span className={cn("flex items-center gap-1 font-mono text-[10px] leading-3.5 font-medium tracking-[0.08em] uppercase [&_svg]:size-3", className)}>
        {icon}
        {label}
      </span>
      <Money amountMinor={amountMinor} className={cn("mt-0.5 text-[15px] leading-5 font-semibold", className)} />
    </p>
  );
}

/**
 * The compact pair that stays in view while the page scrolls. Amber while money is held,
 * emerald once it has moved, slate when the hold was released.
 */
export function FundsSummary({ funds, className }: { funds: FundsView; className?: string }) {
  const released = funds.phase === "released";
  const firstAmount = released ? funds.releasedMinor : funds.heldMinor;
  const firstTone = funds.phase === "held" ? "text-hold" : released ? "text-neutral" : "text-faint";
  const capturedTone = funds.capturedMinor > 0 ? "text-success" : "text-faint";
  return (
    <div
      role="group"
      data-testid="funds-summary"
      data-phase={funds.phase}
      aria-label="Funds held and captured"
      className={cn("flex shrink-0 items-center gap-3 rounded-control border px-3 py-1.5", {
        "border-hold/40 bg-hold-soft": funds.phase === "held",
        "border-success/35 bg-success-soft": funds.phase === "captured",
        "border-hairline bg-surface": funds.phase !== "held" && funds.phase !== "captured",
      }, className)}
    >
      <SummaryCell
        testId="funds-held"
        label={released ? "Released" : "Held"}
        icon={released ? <Undo2 aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}
        amountMinor={firstAmount}
        className={firstTone}
      />
      <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-faint" />
      <SummaryCell
        testId="funds-captured"
        label="Captured"
        icon={<BadgeCheck aria-hidden="true" />}
        amountMinor={funds.capturedMinor}
        className={capturedTone}
      />
    </div>
  );
}
