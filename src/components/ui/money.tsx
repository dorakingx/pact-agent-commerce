import { CURRENCY, type Currency } from "@/lib/domain/money";
import { cn } from "./cn";
import { splitMoney } from "./format";

export interface MoneyProps extends Omit<React.ComponentProps<"span">, "children"> {
  /** Integer minor units (cents). Never a float. */
  amountMinor: number;
  currency?: Currency;
  /** De-emphasise the cents, for large headline amounts. */
  mutedCents?: boolean;
  /** Prefix positive amounts with "+", for deltas. */
  showPlus?: boolean;
}

/** A monetary amount in tabular monospace figures, so columns of amounts align. */
export function Money({
  amountMinor,
  currency = CURRENCY,
  mutedCents = false,
  showPlus = false,
  className,
  ...props
}: MoneyProps) {
  const { negative, whole, cents } = splitMoney(amountMinor, currency);
  // U+2212 is the true minus sign: same width as "+" in tabular figures.
  const sign = negative ? "−" : showPlus && amountMinor > 0 ? "+" : "";
  return (
    <span className={cn("font-mono whitespace-nowrap tabular-nums", className)} {...props}>
      {sign}
      {whole}
      <span className={mutedCents ? "opacity-55" : undefined}>{cents}</span>
    </span>
  );
}
