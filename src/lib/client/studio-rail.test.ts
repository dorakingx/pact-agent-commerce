import { describe, expect, it } from "vitest";
import { RAIL_STATIONS, buildRailModel, describeRail, formatUsd, toAmount } from "./studio-rail";

const ROWS = [
  { stage: "Negotiation", deals: 2, held: 0, captured: 0, released: 0 },
  { stage: "Fulfillment", deals: 3, held: 323.5, captured: 0, released: 0 },
  { stage: "Verification", deals: 1, held: 47, captured: 0, released: 0 },
  { stage: "Settled", deals: 12, held: 0, captured: 1088.5, released: 12 },
  { stage: "Closed", deals: 6, held: 0, captured: 0, released: 305.5 },
];

describe("buildRailModel", () => {
  it("always draws the five stations in lifecycle order, empty ones included", () => {
    const model = buildRailModel(ROWS);
    expect(model.stations.map((station) => station.key)).toEqual([...RAIL_STATIONS]);
    expect(model.stations.map((station) => station.deals)).toEqual([2, 0, 0, 3, 1]);
    expect(model.stations.map((station) => station.heldUsd)).toEqual([0, 0, 0, 323.5, 47]);
    expect(model.stations.every((station) => station.label.length > 0 && station.caption.length > 0)).toBe(true);
  });

  it("puts captures on one exit and released money on the other", () => {
    const model = buildRailModel(ROWS);
    expect(model.settled).toMatchObject({ key: "settled", label: "Captured", deals: 12, amountUsd: 1088.5 });
    expect(model.closed).toMatchObject({ key: "closed", label: "No capture", deals: 6, amountUsd: 305.5 });
  });

  it("totals deals and held money, and shares in-flight deals between the stations", () => {
    const model = buildRailModel(ROWS);
    expect(model.inFlightDeals).toBe(6);
    expect(model.totalDeals).toBe(24);
    expect(model.totalHeldUsd).toBe(370.5);
    expect(model.stations.map((station) => station.share)).toEqual([2 / 6, 0, 0, 3 / 6, 1 / 6]);
  });

  it("accepts raw stage keys as well as labels, and adds up a stage split over several rows", () => {
    const model = buildRailModel([
      { stage: "fulfillment", deals: 1, held: 10 },
      { stage: "FULFILLMENT", deals: 2, held: 20.5 },
      { stage: "settled", deals: 1, captured: 47 },
    ]);
    expect(model.stations[3]).toMatchObject({ deals: 3, heldUsd: 30.5 });
    expect(model.settled.amountUsd).toBe(47);
  });

  it("counts rows it cannot place instead of dropping them silently", () => {
    const model = buildRailModel([
      { stage: "Northwind Studio", deals: 4 },
      { stage: null, deals: 1 },
      { stage: "Contract", deals: 2 },
    ]);
    expect(model.unrecognised).toBe(5);
    expect(model.totalDeals).toBe(2);
  });

  it("reads blank aggregates as zero and survives an empty result", () => {
    expect(toAmount(null)).toBe(0);
    expect(toAmount(undefined)).toBe(0);
    expect(toAmount(Number.NaN)).toBe(0);
    expect(toAmount("12")).toBe(0);
    const empty = buildRailModel([]);
    expect(empty.totalDeals).toBe(0);
    expect(empty.stations.every((station) => station.deals === 0 && station.share === 0)).toBe(true);
    expect(buildRailModel([{ stage: "Contract", deals: null, held: null }]).stations[1]).toMatchObject({ deals: 0, heldUsd: 0 });
  });
});

describe("formatUsd", () => {
  it("formats display dollars with separators and two decimals", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(47)).toBe("$47.00");
    expect(formatUsd(1088.5)).toBe("$1,088.50");
    expect(formatUsd(1234567.891)).toBe("$1,234,567.89");
    expect(formatUsd(0.1 + 0.2)).toBe("$0.30");
    expect(formatUsd(-5)).toBe("−$5.00");
  });
});

describe("describeRail", () => {
  it("says in words what the picture shows", () => {
    expect(describeRail(buildRailModel(ROWS))).toBe(
      "24 deals: 2 in negotiation; 3 in fulfillment holding $323.50; 1 in verification holding $47.00; 12 captured for $1,088.50; 6 closed without capture, $305.50 released.",
    );
  });

  it("has a sentence for an empty rail", () => {
    expect(describeRail(buildRailModel([]))).toBe("No deals match the current filters.");
  });
});
