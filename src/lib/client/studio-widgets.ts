/**
 * Shapes of PACT's three custom AG Studio widgets: their type ids, their data mappings and the
 * options their configuration forms edit. Kept apart from the React components so the default
 * report (studio-report.ts) and the unit tests can describe a widget without loading Studio.
 */
import type { AgWidgetData, AgWidgetDataFormat, AgWidgetFieldReference } from "ag-studio";

export const WIDGET_TYPE = {
  rail: "pact-settlement-rail",
  queue: "pact-review-queue",
  verdict: "pact-verdict-card",
} as const;
export type PactWidgetType = (typeof WIDGET_TYPE)[keyof typeof WIDGET_TYPE];

/* ---------------------------------- Settlement rail --------------------------------- */

export interface SettlementRailStyle {
  /** Print the dollars held at each stage under the deal count. */
  showAmounts?: boolean;
  /** Show the captured / released exits at the end of the rail. */
  showExits?: boolean;
}

export interface SettlementRailDataMapping {
  /** The stage each deal is in: positions deals along the rail. */
  stage: AgWidgetFieldReference[];
  /** How many deals are at the stage. */
  deals: AgWidgetFieldReference[];
  /** Dollars authorized and still held at the stage. */
  held?: AgWidgetFieldReference[];
  /** Dollars captured (the "settled" exit). */
  captured?: AgWidgetFieldReference[];
  /** Dollars released without capture (the "closed" exit). */
  released?: AgWidgetFieldReference[];
}

export interface SettlementRailWidget extends AgWidgetData<SettlementRailDataMapping, AgWidgetDataFormat<SettlementRailStyle>> {
  type: typeof WIDGET_TYPE.rail;
}

/* ---------------------------------- Human review queue ------------------------------ */

export interface ReviewQueueStyle {
  /** Cards shown before the rest is summarised as "+N more". */
  maxItems?: number;
  /** Show the sentence explaining why each deal stopped. */
  showReason?: boolean;
}

export interface ReviewQueueDataMapping {
  /** Deal code: one card per value. */
  deal: AgWidgetFieldReference[];
  /** Lifecycle status: decides which deals are waiting for a person. */
  status: AgWidgetFieldReference[];
  seller?: AgWidgetFieldReference[];
  amount?: AgWidgetFieldReference[];
  reason?: AgWidgetFieldReference[];
  /** When the deal last moved: the card's age. */
  since?: AgWidgetFieldReference[];
}

export interface ReviewQueueWidget extends AgWidgetData<ReviewQueueDataMapping, AgWidgetDataFormat<ReviewQueueStyle>> {
  type: typeof WIDGET_TYPE.queue;
}

/* ---------------------------------- Verdict card ------------------------------------ */

export interface VerdictCardStyle {
  /** Pin the card to one deal code. Empty: the most recently verified deal under the current filters. */
  dealCode?: string;
  /** Confidence (0–100) at which a capture needs no human, drawn as the marker on each bar. */
  thresholdPercent?: number;
  /** Fetch and show what the verifier observed for each condition. */
  showEvidence?: boolean;
}

export interface VerdictCardDataMapping {
  deal: AgWidgetFieldReference[];
  condition: AgWidgetFieldReference[];
  result: AgWidgetFieldReference[];
  round?: AgWidgetFieldReference[];
  rule?: AgWidgetFieldReference[];
  evaluator?: AgWidgetFieldReference[];
  confidence?: AgWidgetFieldReference[];
  at?: AgWidgetFieldReference[];
}

export interface VerdictCardWidget extends AgWidgetData<VerdictCardDataMapping, AgWidgetDataFormat<VerdictCardStyle>> {
  type: typeof WIDGET_TYPE.verdict;
}

export type PactCustomWidget = SettlementRailWidget | ReviewQueueWidget | VerdictCardWidget;

/** Defaults shared by the forms, the format shapes and the components, so the three never disagree. */
export const WIDGET_DEFAULTS = {
  rail: { showAmounts: true, showExits: true },
  queue: { maxItems: 6, showReason: true },
  verdict: { dealCode: "", thresholdPercent: 85, showEvidence: true },
} as const satisfies {
  rail: Required<SettlementRailStyle>;
  queue: Required<ReviewQueueStyle>;
  verdict: Required<VerdictCardStyle>;
};
