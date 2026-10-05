/**
 * Seller pricing. A quote is a pure function of the seller's private rate card, the scope and
 * the terms on the table, so the negotiation rules engine can recompute the seller's floor for
 * ANY terms an agent proposes instead of trusting a number the agent carries around.
 */
import { HOUR_MS, assertNever, parseTimestamp, plural } from "./format";
import type { DeliverableSpec, Quote, Terms } from "./schemas";
import type { RateCard, SellerProfile } from "./sellers";

interface Component {
  label: string;
  /** Exact amount in minor units. May be fractional until the list price is rounded. */
  amount: number;
}

/**
 * Rate cards use decimal factors (0.84, 1.15), so products pick up binary float noise such as
 * 17200.000000000004. Snapping to a millionth of a cent removes the noise without moving any
 * real amount, which keeps "round UP to a whole dollar" from jumping a dollar by accident.
 */
function denoise(amount: number): number {
  return Math.round(amount * 1e6) / 1e6;
}

function ceilToWholeDollar(amount: number): number {
  return Math.ceil(denoise(amount) / 100) * 100;
}

function scopeComponents(card: RateCard, deliverable: DeliverableSpec, count: number): Component[] {
  switch (deliverable.kind) {
    case "illustration": {
      const extraRatios = Math.max(0, deliverable.aspectRatios.length - 1);
      return [
        {
          label: `${plural(count, "illustration")} (first aspect ratio included)`,
          amount: count * card.illustrationBaseMinor,
        },
        {
          label: `${plural(extraRatios, "additional aspect ratio")} × ${plural(count, "illustration")}`,
          amount: count * extraRatios * card.extraRatioMinor,
        },
      ];
    }
    case "copy": {
      const extraLanguages = Math.max(0, deliverable.languages.length - 1);
      const firstLanguage = count * deliverable.maxWords * card.perWordMinor;
      return [
        {
          label: `${plural(count, "copy piece")} × up to ${deliverable.maxWords} words (first language)`,
          amount: firstLanguage,
        },
        {
          label: `${plural(extraLanguages, "additional language")}`,
          amount: firstLanguage * card.extraLanguageFactor * extraLanguages,
        },
      ];
    }
    default:
      return assertNever(deliverable);
  }
}

/**
 * Turn exact (possibly fractional) components into integer lines that sum to `listMinor`.
 * Rounding the RUNNING total, rather than each component, means the cents can never drift
 * past the list price; whatever is left is shown as an explicit rounding line.
 */
function itemise(components: readonly Component[], listMinor: number): Quote["lines"] {
  const lines: Quote["lines"] = [];
  let running = 0;
  let emitted = 0;
  for (const component of components) {
    running += component.amount;
    const upTo = Math.round(denoise(running));
    if (upTo !== emitted) lines.push({ label: component.label, amountMinor: upTo - emitted });
    emitted = upTo;
  }
  if (listMinor !== emitted) {
    lines.push({ label: "Rounded up to a whole dollar", amountMinor: listMinor - emitted });
  }
  return lines;
}

/**
 * Price the given scope and terms for a seller.
 *
 * list  = (scope + revisions) × rush factor, rounded UP to a whole dollar
 * floor = list × floorFactor, rounded UP to a whole dollar (the seller's private walk-away price)
 *
 * The rush factor is the FIRST tier whose `underHours` exceeds the lead time (deadline − now).
 */
export function quoteFor(
  seller: SellerProfile,
  deliverable: DeliverableSpec,
  terms: Pick<Terms, "count" | "deadline" | "revisionLimit">,
  now: Date,
): Quote {
  const card = seller.rateCard;
  const deadlineMs = parseTimestamp(terms.deadline);
  if (deadlineMs === null) {
    throw new RangeError(`quoteFor: deadline is not a valid timestamp: ${JSON.stringify(terms.deadline)}`);
  }
  if (!Number.isInteger(terms.count) || terms.count < 1) {
    throw new RangeError("quoteFor: count must be a positive integer");
  }
  if (!Number.isInteger(terms.revisionLimit) || terms.revisionLimit < 0) {
    throw new RangeError("quoteFor: revisionLimit must be a non-negative integer");
  }

  const components: Component[] = [
    ...scopeComponents(card, deliverable, terms.count),
    {
      label: `${plural(terms.revisionLimit, "revision round")} included`,
      amount: terms.revisionLimit * card.revisionMinor,
    },
  ];
  const subtotal = components.reduce((sum, c) => sum + c.amount, 0);

  const leadHours = (deadlineMs - now.getTime()) / HOUR_MS;
  const rush = card.rushTiers.find((tier) => tier.underHours > leadHours);
  if (rush) {
    const surchargePercent = denoise((rush.factor - 1) * 100);
    components.push({
      label: `Rush delivery (under ${rush.underHours}h): +${surchargePercent}%`,
      amount: subtotal * (rush.factor - 1),
    });
  }

  const total = rush ? subtotal * rush.factor : subtotal;
  const listMinor = ceilToWholeDollar(total);
  const floorMinor = ceilToWholeDollar(listMinor * card.floorFactor);

  return {
    listMinor,
    floorMinor,
    lines: itemise(components, listMinor),
    minHours: card.minHours,
  };
}
