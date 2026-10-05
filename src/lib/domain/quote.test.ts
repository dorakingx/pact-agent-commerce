import { describe, expect, it } from "vitest";
import { quoteFor } from "./quote";
import { QuoteSchema, type DeliverableSpec } from "./schemas";
import type { SellerProfile } from "./sellers";
import { SCENARIO_MANDATES, TEST_NOW, sellerById } from "./test-support";

const HOUR = 3_600_000;
const inHours = (hours: number): string => new Date(TEST_NOW.getTime() + hours * HOUR).toISOString();

const heroSet: DeliverableSpec = {
  kind: "illustration",
  count: 3,
  aspectRatios: ["16:9", "1:1"],
  subject: "landing-page hero illustrations",
  style: null,
};

const northwind = sellerById("northwind");
const lingua = sellerById("lingua");

function sumLines(lines: { amountMinor: number }[]): number {
  return lines.reduce((sum, line) => sum + line.amountMinor, 0);
}

describe("quoteFor — illustrations", () => {
  it("matches the sanity anchor: 3 illustrations, two ratios, 1 revision, 30h out", () => {
    const quote = quoteFor(northwind, heroSet, { count: 3, deadline: inHours(30), revisionLimit: 1 }, TEST_NOW);
    expect(quote.listMinor).toBe(5300);
    expect(quote.floorMinor).toBe(4500);
    expect(quote.minHours).toBe(2);
  });

  it("itemises every component and the lines add up to the list price", () => {
    const quote = quoteFor(northwind, heroSet, { count: 3, deadline: inHours(30), revisionLimit: 1 }, TEST_NOW);
    expect(quote.lines).toEqual([
      { label: "3 illustrations (first aspect ratio included)", amountMinor: 3900 },
      { label: "1 additional aspect ratio × 3 illustrations", amountMinor: 1050 },
      { label: "1 revision round included", amountMinor: 300 },
      { label: "Rounded up to a whole dollar", amountMinor: 50 },
    ]);
    expect(sumLines(quote.lines)).toBe(quote.listMinor);
    expect(QuoteSchema.safeParse(quote).success).toBe(true);
  });

  it("omits lines that contribute nothing", () => {
    const single: DeliverableSpec = { ...heroSet, aspectRatios: ["16:9"] };
    const quote = quoteFor(northwind, single, { count: 2, deadline: inHours(30), revisionLimit: 0 }, TEST_NOW);
    expect(quote.lines).toEqual([{ label: "2 illustrations (first aspect ratio included)", amountMinor: 2600 }]);
    expect(quote.listMinor).toBe(2600);
    expect(quote.floorMinor).toBe(2200); // 2600 × 0.84 = 2184 → up to $22
  });

  it("scales with count, ratios and revisions", () => {
    const base = quoteFor(northwind, heroSet, { count: 1, deadline: inHours(30), revisionLimit: 0 }, TEST_NOW);
    expect(base.listMinor).toBe(1700); // 1300 + 350 = 1650 → $17
    const more = quoteFor(northwind, { ...heroSet, aspectRatios: ["16:9", "1:1", "4:5"] }, { count: 2, deadline: inHours(30), revisionLimit: 3 }, TEST_NOW);
    // 2 × (1300 + 2 × 350) + 3 × 300 = 4900
    expect(more.listMinor).toBe(4900);
    expect(more.floorMinor).toBe(4200); // 4116 → $42
  });
});

describe("quoteFor — rush tiers", () => {
  const terms = (hours: number) => ({ count: 3, deadline: inHours(hours), revisionLimit: 1 });

  it("applies the first tier whose threshold exceeds the lead time", () => {
    // northwind: under 4h ×1.5, under 12h ×1.2
    expect(quoteFor(northwind, heroSet, terms(3), TEST_NOW).listMinor).toBe(7900); // 5250 × 1.5 = 7875
    expect(quoteFor(northwind, heroSet, terms(8), TEST_NOW).listMinor).toBe(6300); // 5250 × 1.2 = 6300
    expect(quoteFor(northwind, heroSet, terms(30), TEST_NOW).listMinor).toBe(5300);
  });

  it("treats a lead time exactly on a threshold as outside that tier", () => {
    expect(quoteFor(northwind, heroSet, terms(4), TEST_NOW).listMinor).toBe(6300); // not under 4h → 12h tier
    expect(quoteFor(northwind, heroSet, terms(12), TEST_NOW).listMinor).toBe(5300); // not under 12h → no rush
    expect(quoteFor(northwind, heroSet, terms(11.999), TEST_NOW).listMinor).toBe(6300);
    expect(quoteFor(northwind, heroSet, terms(3.999), TEST_NOW).listMinor).toBe(7900);
  });

  it("shows the rush surcharge as its own line", () => {
    const quote = quoteFor(northwind, heroSet, terms(8), TEST_NOW);
    expect(quote.lines).toContainEqual({ label: "Rush delivery (under 12h): +20%", amountMinor: 1050 });
    expect(sumLines(quote.lines)).toBe(6300);
    expect(quote.floorMinor).toBe(5300); // 6300 × 0.84 = 5292 → $53
  });

  it("prices a deadline that has already passed at the steepest tier", () => {
    expect(quoteFor(northwind, heroSet, terms(-5), TEST_NOW).listMinor).toBe(7900);
  });

  it("never applies a surcharge for a seller without rush tiers", () => {
    const pixelharbor = sellerById("pixelharbor");
    const spec = SCENARIO_MANDATES.injection.mandate.deliverable;
    const quote = quoteFor(pixelharbor, spec, { count: 2, deadline: inHours(0.5), revisionLimit: 1 }, TEST_NOW);
    expect(quote.listMinor).toBe(2000);
    expect(quote.floorMinor).toBe(1600);
  });
});

describe("quoteFor — copy", () => {
  const copy = SCENARIO_MANDATES.approval.mandate.deliverable;

  it("prices per word of the maximum length, with a factor per extra language", () => {
    const quote = quoteFor(lingua, copy, { count: 6, deadline: inHours(72), revisionLimit: 2 }, TEST_NOW);
    // 6 × 120 × 14 = 10080; × 1.8 = 18144; + 2 × 900 = 19944 → $200; floor 20000 × 0.86 = 17200
    expect(quote.listMinor).toBe(20000);
    expect(quote.floorMinor).toBe(17200);
    expect(quote.lines).toEqual([
      { label: "6 copy pieces × up to 120 words (first language)", amountMinor: 10080 },
      { label: "1 additional language", amountMinor: 8064 },
      { label: "2 revision rounds included", amountMinor: 1800 },
      { label: "Rounded up to a whole dollar", amountMinor: 56 },
    ]);
  });

  it("lands exactly on the dollar when the arithmetic is exact", () => {
    const quote = quoteFor(lingua, copy, { count: 6, deadline: inHours(72), revisionLimit: 2 }, TEST_NOW);
    expect(quote.floorMinor).toBe(17200); // 20000 × 0.86, not rounded up to $173
  });

  it("applies lingua's rush tiers", () => {
    const at = (hours: number) => quoteFor(lingua, copy, { count: 6, deadline: inHours(hours), revisionLimit: 2 }, TEST_NOW);
    expect(at(24).listMinor).toBe(20000);
    expect(at(23).listMinor).toBe(23000); // 19944 × 1.15 = 22935.6
    expect(at(5).listMinor).toBe(28000); // 19944 × 1.4 = 27921.6
    expect(sumLines(at(23).lines)).toBe(23000);
    expect(sumLines(at(5).lines)).toBe(28000);
  });
});

describe("quoteFor — binary float noise", () => {
  const single: DeliverableSpec = { ...heroSet, aspectRatios: ["16:9"] };
  const withCard = (rateCard: Partial<SellerProfile["rateCard"]>): SellerProfile => ({
    ...northwind,
    rateCard: { ...northwind.rateCard, rushTiers: [], ...rateCard },
  });

  it("does not let noise in the floor factor push the floor up a dollar", () => {
    // 10000 × 0.81 evaluates to 8100.000000000001; a naive ceil would make the floor $82.
    expect(10000 * 0.81).toBeGreaterThan(8100);
    const seller = withCard({ illustrationBaseMinor: 5000, floorFactor: 0.81 });
    const quote = quoteFor(seller, single, { count: 2, deadline: inHours(30), revisionLimit: 0 }, TEST_NOW);
    expect(quote.listMinor).toBe(10000);
    expect(quote.floorMinor).toBe(8100);
  });

  it("does not let noise in the rush factor push the list price up a dollar", () => {
    // 3000 × 1.1 evaluates to 3300.0000000000005.
    expect(3000 * 1.1).toBeGreaterThan(3300);
    const seller = withCard({ illustrationBaseMinor: 1500, rushTiers: [{ underHours: 12, factor: 1.1 }] });
    const quote = quoteFor(seller, single, { count: 2, deadline: inHours(6), revisionLimit: 0 }, TEST_NOW);
    expect(quote.listMinor).toBe(3300);
    expect(quote.lines).toEqual([
      { label: "2 illustrations (first aspect ratio included)", amountMinor: 3000 },
      { label: "Rush delivery (under 12h): +10%", amountMinor: 300 },
    ]);
  });

  it("still rounds a genuine fraction of a cent up to the next dollar", () => {
    // 1 × 1301 × 1.5 = 1951.5 → $20
    const seller = withCard({ illustrationBaseMinor: 1301, rushTiers: [{ underHours: 12, factor: 1.5 }] });
    const quote = quoteFor(seller, single, { count: 1, deadline: inHours(6), revisionLimit: 0 }, TEST_NOW);
    expect(quote.listMinor).toBe(2000);
    expect(sumLines(quote.lines)).toBe(2000);
  });
});

describe("quoteFor — invariants", () => {
  it("always quotes whole dollars with floor <= list, for every seller and scope", () => {
    const sellers: SellerProfile[] = ["northwind", "quickdraw", "lingua", "pixelharbor"].map(sellerById);
    const specs = Object.values(SCENARIO_MANDATES).map((s) => s.mandate.deliverable);
    for (const seller of sellers) {
      for (const spec of specs) {
        for (const count of [1, 2, 5]) {
          for (const revisionLimit of [0, 1, 3]) {
            for (const hours of [0.5, 3, 5, 10, 23, 48]) {
              const quote = quoteFor(seller, spec, { count, deadline: inHours(hours), revisionLimit }, TEST_NOW);
              expect(quote.listMinor % 100).toBe(0);
              expect(quote.floorMinor % 100).toBe(0);
              expect(quote.floorMinor).toBeLessThanOrEqual(quote.listMinor);
              expect(sumLines(quote.lines)).toBe(quote.listMinor);
              expect(quote.lines.every((line) => Number.isInteger(line.amountMinor) && line.amountMinor > 0)).toBe(true);
            }
          }
        }
      }
    }
  });

  it("is deterministic", () => {
    const terms = { count: 3, deadline: inHours(30), revisionLimit: 1 };
    expect(quoteFor(northwind, heroSet, terms, TEST_NOW)).toEqual(quoteFor(northwind, heroSet, terms, TEST_NOW));
  });

  it("rejects terms it cannot price", () => {
    expect(() => quoteFor(northwind, heroSet, { count: 3, deadline: "soon", revisionLimit: 1 }, TEST_NOW)).toThrow(RangeError);
    expect(() => quoteFor(northwind, heroSet, { count: 0, deadline: inHours(30), revisionLimit: 1 }, TEST_NOW)).toThrow(RangeError);
    expect(() => quoteFor(northwind, heroSet, { count: 1.5, deadline: inHours(30), revisionLimit: 1 }, TEST_NOW)).toThrow(RangeError);
    expect(() => quoteFor(northwind, heroSet, { count: 3, deadline: inHours(30), revisionLimit: -1 }, TEST_NOW)).toThrow(RangeError);
  });
});
