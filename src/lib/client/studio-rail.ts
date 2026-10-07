/**
 * View model of the "Settlement rail" widget: PACT's state machine as a row of stations.
 *
 * The widget asks Studio for one row per stage (deal count plus the money measures the author
 * mapped), already narrowed by whatever filters are active. This module turns those rows into
 * the fixed shape the component draws: five in-flight stations in lifecycle order, then the two
 * exits. Stations with no deals are still present — an empty station is information.
 */
import { STAGE_KEYS, STAGE_LABEL, stageKeyOf, type StageKey } from "./studio-data";

export interface RailInputRow {
  stage: unknown;
  deals: unknown;
  held?: unknown;
  captured?: unknown;
  released?: unknown;
}

/** Stations a deal can be standing at. The two remaining stage keys are exits, not stations. */
export const RAIL_STATIONS = ["negotiation", "contract", "payment", "fulfillment", "verification"] as const satisfies readonly StageKey[];
export type RailStationKey = (typeof RAIL_STATIONS)[number];

/** What each station is doing with the money, in the words of the product. */
const STATION_CAPTION: Record<RailStationKey, string> = {
  negotiation: "Agents agree terms",
  contract: "Hashed, policy checked",
  payment: "PayPal order pending",
  fulfillment: "Funds held, seller working",
  verification: "Checked against contract",
};

export interface RailStation {
  key: RailStationKey;
  label: string;
  caption: string;
  deals: number;
  heldUsd: number;
  /** Share of all in-flight deals standing here, 0–1: drives the weight of the station's bar. */
  share: number;
}

export interface RailExit {
  key: "settled" | "closed";
  label: string;
  caption: string;
  deals: number;
  amountUsd: number;
}

export interface RailModel {
  stations: RailStation[];
  settled: RailExit;
  closed: RailExit;
  inFlightDeals: number;
  totalDeals: number;
  totalHeldUsd: number;
  /** Rows whose stage is not one of PACT's (the author mapped another field): shown as a note, never dropped silently. */
  unrecognised: number;
}

/** Studio hands numbers back as numbers, but a blank aggregate is null: read defensively. */
export function toAmount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function buildRailModel(rows: readonly RailInputRow[]): RailModel {
  const byStage = new Map<StageKey, { deals: number; held: number; captured: number; released: number }>(
    STAGE_KEYS.map((key) => [key, { deals: 0, held: 0, captured: 0, released: 0 }]),
  );
  let unrecognised = 0;
  for (const row of rows) {
    const key = stageKeyOf(row.stage);
    if (key === null) {
      unrecognised += toAmount(row.deals);
      continue;
    }
    // A stage can arrive split over several rows when the author adds a second grouping field.
    const bucket = byStage.get(key)!;
    bucket.deals += toAmount(row.deals);
    bucket.held += toAmount(row.held);
    bucket.captured += toAmount(row.captured);
    bucket.released += toAmount(row.released);
  }

  const inFlightDeals = RAIL_STATIONS.reduce((total, key) => total + byStage.get(key)!.deals, 0);
  const stations = RAIL_STATIONS.map((key) => {
    const bucket = byStage.get(key)!;
    return {
      key,
      label: STAGE_LABEL[key],
      caption: STATION_CAPTION[key],
      deals: bucket.deals,
      heldUsd: bucket.held,
      share: inFlightDeals === 0 ? 0 : bucket.deals / inFlightDeals,
    };
  });
  const settled = byStage.get("settled")!;
  const closed = byStage.get("closed")!;
  return {
    stations,
    settled: { key: "settled", label: "Captured", caption: "Verified, then paid", deals: settled.deals, amountUsd: settled.captured },
    closed: { key: "closed", label: "No capture", caption: "Voided, declined or blocked", deals: closed.deals, amountUsd: closed.released },
    inFlightDeals,
    totalDeals: inFlightDeals + settled.deals + closed.deals,
    totalHeldUsd: [...byStage.values()].reduce((total, bucket) => total + bucket.held, 0),
    unrecognised,
  };
}

/** "$1,234.50" for a display-dollar amount. Whole cents only: the input is already rounded. */
export function formatUsd(amount: number): string {
  const cents = Math.round(Math.abs(amount) * 100);
  const whole = Math.floor(cents / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${amount < 0 ? "−" : ""}$${whole}.${(cents % 100).toString().padStart(2, "0")}`;
}

/** A sentence for screen readers: the rail is a picture, and this is what it says. */
export function describeRail(model: RailModel): string {
  if (model.totalDeals === 0) return "No deals match the current filters.";
  const stations = model.stations
    .filter((station) => station.deals > 0)
    .map((station) => `${station.deals} in ${station.label.toLowerCase()}${station.heldUsd > 0 ? ` holding ${formatUsd(station.heldUsd)}` : ""}`);
  const parts = [
    ...stations,
    `${model.settled.deals} captured for ${formatUsd(model.settled.amountUsd)}`,
    `${model.closed.deals} closed without capture, ${formatUsd(model.closed.amountUsd)} released`,
  ];
  return `${model.totalDeals} ${model.totalDeals === 1 ? "deal" : "deals"}: ${parts.join("; ")}.`;
}
