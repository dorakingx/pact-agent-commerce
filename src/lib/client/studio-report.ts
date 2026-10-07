/**
 * The report a visitor first sees: "Agent Commerce Operations" as four AG Studio pages.
 *
 * This is ordinary Studio state, exactly what `api.getState()` returns after someone builds the
 * same thing by hand. Nothing here is privileged: every widget can be moved, resized,
 * reconfigured or deleted in the editor, and "Reset to PACT default" loads this object again.
 *
 * The canvas is 24 columns wide with 16px rows. Layouts are written with `at(x, y, w, h)` and a
 * unit test checks that no two widgets on a page overlap and that every field the report maps
 * exists in the data model, so a renamed field cannot silently blank a chart.
 */
import type { AgDefaultWidget, AgFiltersState, AgPanelsState, AgWidgetFieldReference, AgWidgetLayoutState } from "ag-studio";
import { WIDGET_DEFAULTS, WIDGET_TYPE, type PactCustomWidget } from "./studio-widgets";

/** Bumped whenever the default report changes shape, so a stale saved layout is not restored over it. */
export const REPORT_VERSION = 1;

export const PAGE = { overview: "overview", ledger: "ledger", verification: "verification", payments: "payments" } as const;
export type PactPageId = (typeof PAGE)[keyof typeof PAGE];

/** What each page is called in the header strip and to the agents (Studio itself labels tabs "Page n"). */
export const PAGE_TITLE: Record<PactPageId, string> = {
  overview: "Overview",
  ledger: "Ledger",
  verification: "Verification",
  payments: "Payments",
};

export type PactWidgetState = AgDefaultWidget | PactCustomWidget;

export interface PactPageState {
  id: PactPageId;
  widgets: Record<string, PactWidgetState>;
  widgetLayout: Record<string, AgWidgetLayoutState>;
  filter?: AgFiltersState;
}

export interface PactReportState {
  pages: PactPageState[];
  selectedPageId: string;
  panels: AgPanelsState;
}

export const CANVAS_COLUMNS = 24;

/**
 * The narrowest the canvas is drawn, by how much room the page has. The report is designed on a
 * 24-column grid; below the comfortable width a column is too thin for a labelled chart, so on a
 * desktop the canvas scrolls sideways (for instance while the chat panel is open) instead of
 * squeezing every widget. A tablet has no room to spare, so there the canvas may shrink to the
 * narrowest width at which every headline amount still fits.
 */
export const CANVAS_MIN_WIDTH = { comfortable: 920, compact: 720 } as const;

const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number): AgWidgetLayoutState => ({ xTrack, yTrack, xSpan, ySpan });
const field = (id: string): AgWidgetFieldReference => ({ id });
const sum = (id: string): AgWidgetFieldReference => ({ id, aggregation: "sum" });
const avg = (id: string): AgWidgetFieldReference => ({ id, aggregation: "avg" });
const min = (id: string): AgWidgetFieldReference => ({ id, aggregation: "min" });
const usdAxis = { valueAxis: { title: { enabled: true, text: "USD" } } } as const;

const titled = (text: string, subtitle?: string) => ({
  title: { enabled: true, text },
  ...(subtitle === undefined ? {} : { subtitle: { enabled: true, text: subtitle } }),
});

/** A headline number. The label sits under the figure, the way the rest of the product writes totals. */
function tile(value: AgWidgetFieldReference, label: string): PactWidgetState {
  return {
    type: "value",
    dataMapping: { value: [value] },
    // A tile is a total, not a selection: clicking a chart filters the charts, never the headline.
    format: { caption: { enabled: true, text: label, wrapping: true }, crossFilter: "filter" },
  };
}

const LEGEND_BOTTOM = { theme: { common: { legend: { enabled: true, position: "bottom" } } } } as const;
const NO_LEGEND = { theme: { common: { legend: { enabled: false } } } } as const;

/* -------------------------------------------------------------------------- */
/*  Overview                                                                   */
/* -------------------------------------------------------------------------- */

function overviewPage(): PactPageState {
  return {
    id: PAGE.overview,
    widgets: {
      "tile-held": tile(sum("deals.heldUsd"), "Authorized now held"),
      "tile-captured": tile(sum("deals.capturedUsd"), "Captured"),
      "tile-released": tile(sum("deals.releasedUsd"), "Released back"),
      "tile-awaiting": tile(sum("deals.awaitingHuman"), "Deals awaiting a human"),
      "tile-first-pass": tile(avg("deals.firstPass"), "First-pass verification rate"),
      rail: {
        type: WIDGET_TYPE.rail,
        dataMapping: {
          stage: [field("deals.stage")],
          deals: [sum("deals.deals")],
          held: [sum("deals.heldUsd")],
          captured: [sum("deals.capturedUsd")],
          released: [sum("deals.releasedUsd")],
        },
        format: {
          ...titled("Settlement rail", "Where every deal is now, and the money held at each stage. Click a stage to filter the page."),
          style: { ...WIDGET_DEFAULTS.rail },
        },
      },
      funnel: {
        type: "funnel-chart",
        dataMapping: { categoryKey: [field("stages.stage")], valueKey: [sum("stages.deals")] },
        // A deal can only reach a stage by passing the ones before it, so "most deals first" is
        // lifecycle order. Ties keep the order the rows arrive in, which is lifecycle order too.
        sort: [{ field: sum("stages.deals"), direction: "desc" }],
        format: {
          ...titled("Settlement funnel", "Deals that reached each stage"),
          style: { theme: { funnel: { series: { label: { enabled: true } } }, common: { legend: { enabled: false } } } },
        },
      },
      outcome: {
        type: "donut-chart",
        dataMapping: { categoryKey: [field("deals.outcome")], valueKey: [sum("deals.deals")] },
        sort: [{ field: sum("deals.deals"), direction: "desc" }],
        format: {
          ...titled("Outcome mix", "How deals ended, or that they are still in progress"),
          // Labelled slices instead of a legend: with six short categories the names fit beside the
          // ring, and nobody has to match a colour to a key.
          style: {
            ...NO_LEGEND,
            custom: {
              totalLabel: { enabled: true },
              pieDataLabel: { enabled: true, position: "outside", category: true, format: "value", fontSize: 11 },
            },
          },
        },
      },
      "by-seller": {
        type: "bar-chart-grouped",
        dataMapping: {
          categoryKey: [field("deals.seller")],
          // Captured first: it takes the emerald series colour, the hold takes amber.
          valueKey: [sum("deals.capturedUsd"), sum("deals.authorizedUsd")],
        },
        sort: [{ field: sum("deals.authorizedUsd"), direction: "desc" }],
        format: {
          ...titled("Authorized vs captured by seller", "What PayPal held for each seller against what was actually paid"),
          style: { ...LEGEND_BOTTOM, custom: usdAxis },
        },
      },
      queue: {
        type: WIDGET_TYPE.queue,
        dataMapping: {
          deal: [field("deals.code")],
          status: [field("deals.status")],
          seller: [field("deals.seller")],
          amount: [sum("deals.priceUsd")],
          reason: [field("deals.stopReason")],
          since: [field("deals.updatedAt")],
        },
        format: {
          ...titled("Human review queue", "Deals waiting for a person. Nothing is captured until someone decides."),
          style: { ...WIDGET_DEFAULTS.queue },
        },
      },
      verdict: {
        type: WIDGET_TYPE.verdict,
        dataMapping: {
          deal: [field("checks.deal")],
          condition: [field("checks.condition")],
          result: [field("checks.result")],
          round: [field("checks.round")],
          rule: [field("checks.rule")],
          evaluator: [field("checks.evaluator")],
          confidence: [min("checks.confidence")],
          at: [field("checks.at")],
        },
        format: {
          ...titled("Verdict card", "Every contract condition of the latest verified delivery, with evidence"),
          style: { ...WIDGET_DEFAULTS.verdict },
        },
      },
    },
    widgetLayout: {
      // Five across. The count is the one tile that never needs room for a dollar amount.
      "tile-held": at(0, 0, 5, 6),
      "tile-captured": at(5, 0, 5, 6),
      "tile-released": at(10, 0, 5, 6),
      "tile-awaiting": at(15, 0, 4, 6),
      "tile-first-pass": at(19, 0, 5, 6),
      rail: at(0, 6, 24, 13),
      funnel: at(0, 19, 7, 19),
      outcome: at(7, 19, 8, 19),
      "by-seller": at(15, 19, 9, 19),
      queue: at(0, 38, 11, 24),
      verdict: at(11, 38, 13, 24),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Ledger                                                                     */
/* -------------------------------------------------------------------------- */

function ledgerPage(): PactPageState {
  return {
    id: PAGE.ledger,
    widgets: {
      // Studio labels a filter widget with its field ("Filter by: Status"), so these carry no title of their own.
      "filter-status": {
        type: "list-filter",
        dataMapping: { value: [field("deals.status")] },
        format: { style: { selection: { type: "multiple" } } },
      },
      "filter-seller": {
        type: "button-filter",
        dataMapping: { value: [field("deals.seller")] },
        format: { style: { selection: { type: "multiple" }, dimensions: { minWidth: 168, height: 34 } } },
      },
      "filter-risk": {
        type: "button-filter",
        dataMapping: { value: [field("deals.risk")] },
        format: { style: { selection: { type: "multiple" }, dimensions: { minWidth: 84, height: 34 } } },
      },
      "filter-date": {
        type: "date-filter",
        dataMapping: { value: [field("deals.day")] },
        format: { style: { filterType: "between" } },
      },
      "by-status": {
        type: "grid",
        dataMapping: {
          cols: [
            field("deals.status"),
            field("deals.seller"),
            sum("deals.deals"),
            sum("deals.priceUsd"),
            sum("deals.authorizedUsd"),
            sum("deals.heldUsd"),
            sum("deals.capturedUsd"),
            sum("deals.releasedUsd"),
          ],
        },
        // Where money is held first: those are the rows someone may have to act on.
        sort: [{ field: sum("deals.heldUsd"), direction: "desc" }],
        format: {
          ...titled("Ledger by status and seller", "Grouped and totalled. Authorized = held + captured + released."),
          style: { grandTotalRow: { enabled: true }, columnAutoSize: true },
        },
      },
      deals: {
        type: "grid",
        dataMapping: {
          cols: [
            field("deals.code"),
            field("deals.title"),
            field("deals.status"),
            field("deals.seller"),
            field("deals.risk"),
            field("deals.priceUsd"),
            field("deals.heldUsd"),
            field("deals.capturedUsd"),
            field("deals.paymentRail"),
            field("deals.verification"),
            field("deals.confidence"),
            field("deals.updatedAt"),
          ],
        },
        sort: [{ field: field("deals.updatedAt"), direction: "desc" }],
        format: { ...titled("All deals", "One row per deal, newest activity first. A deal code opens the deal."), style: { columnAutoSize: true } },
      },
    },
    widgetLayout: {
      "filter-status": at(0, 0, 6, 9),
      "filter-seller": at(6, 0, 8, 9),
      "filter-risk": at(14, 0, 4, 9),
      "filter-date": at(18, 0, 6, 9),
      "by-status": at(0, 9, 24, 18),
      deals: at(0, 27, 24, 26),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Verification                                                               */
/* -------------------------------------------------------------------------- */

function verificationPage(): PactPageState {
  return {
    id: PAGE.verification,
    widgets: {
      "tile-checks": tile(sum("checks.checks"), "Conditions checked"),
      "tile-failed": tile(sum("checks.failed"), "Failed"),
      "tile-uncertain": tile(sum("checks.uncertain"), "Uncertain · sent to a human"),
      "tile-first-pass": tile(avg("deals.firstPass"), "First-pass verification rate"),
      "by-kind": {
        type: "bar-chart-stacked",
        dataMapping: {
          categoryKey: [field("checks.kind")],
          // Pass / uncertain / fail land on emerald / amber / red in the theme's series order.
          valueKey: [sum("checks.passed"), sum("checks.uncertain"), sum("checks.failed")],
        },
        sort: [{ field: sum("checks.failed"), direction: "desc" }],
        format: { ...titled("Results by rule kind", "Which contract conditions fail, and how often"), style: LEGEND_BOTTOM },
      },
      "failure-by-seller": {
        type: "bar-chart-grouped",
        dataMapping: { categoryKey: [field("checks.seller")], valueKey: [avg("checks.failPercent")] },
        sort: [{ field: avg("checks.failPercent"), direction: "desc" }],
        format: {
          ...titled("Failure share by seller", "Failed conditions as a share of all conditions checked"),
          style: { ...NO_LEGEND, custom: { valueAxis: { title: { enabled: true, text: "% of conditions failed" } } } },
        },
      },
      evaluators: {
        type: "column-chart-stacked-100",
        dataMapping: {
          categoryKey: [field("checks.evaluator")],
          valueKey: [sum("checks.passed"), sum("checks.uncertain"), sum("checks.failed")],
        },
        format: { ...titled("AI vs deterministic evaluators", "Plain code decides what it can; the model judges the rest"), style: LEGEND_BOTTOM },
      },
      confidence: {
        type: "column-chart-grouped",
        dataMapping: { categoryKey: [field("checks.confidenceBand")], valueKey: [sum("checks.checks")] },
        sort: [{ field: field("checks.confidenceBand"), direction: "asc" }],
        format: { ...titled("Confidence distribution", "AI-evaluated conditions. Below 85% a human decides."), style: NO_LEGEND },
      },
      pivot: {
        type: "pivot-grid",
        dataMapping: {
          rows: [field("checks.seller"), field("checks.kind")],
          columns: [field("checks.result")],
          values: [sum("checks.checks")],
        },
        format: {
          ...titled("Conditions by seller, rule and result"),
          style: { totalColumns: true, grandTotalRow: { enabled: true } },
        },
      },
    },
    widgetLayout: {
      "tile-checks": at(0, 0, 6, 6),
      "tile-failed": at(6, 0, 6, 6),
      "tile-uncertain": at(12, 0, 6, 6),
      "tile-first-pass": at(18, 0, 6, 6),
      "by-kind": at(0, 6, 13, 20),
      "failure-by-seller": at(13, 6, 11, 20),
      evaluators: at(0, 26, 7, 20),
      confidence: at(7, 26, 7, 20),
      pivot: at(14, 26, 10, 20),
    },
    filter: {
      // Deterministic checks are always 100% confident and would bury the model's distribution.
      widget: {
        confidence: [{ field: field("checks.evaluator"), view: { viewTypeId: "selection" }, model: { operator: "isIn", value: ["AI"] } }],
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Payments                                                                   */
/* -------------------------------------------------------------------------- */

function paymentsPage(): PactPageState {
  return {
    id: PAGE.payments,
    widgets: {
      "tile-events": tile(sum("paymentEvents.events"), "Payment events"),
      "tile-authorized": tile(sum("deals.authorizedUsd"), "Authorized in total"),
      "tile-captured": tile(sum("deals.capturedUsd"), "Captured"),
      "tile-held": tile(sum("deals.heldUsd"), "Authorized now held"),
      "over-time": {
        type: "column-chart-stacked",
        dataMapping: {
          categoryKey: [field("paymentEvents.day")],
          // One series per kind of event, in the theme's colour order: captured, held, blocked, then the rest.
          valueKey: [
            sum("paymentEvents.captures"),
            sum("paymentEvents.authorizations"),
            sum("paymentEvents.problems"),
            sum("paymentEvents.orders"),
            sum("paymentEvents.releases"),
            sum("paymentEvents.confirmations"),
          ],
        },
        sort: [{ field: field("paymentEvents.day"), direction: "asc" }],
        format: { ...titled("Payment events over time", "Every PayPal-facing event, by day and by what it did"), style: LEGEND_BOTTOM },
      },
      "by-type": {
        type: "bar-chart-grouped",
        dataMapping: { categoryKey: [field("paymentEvents.type")], valueKey: [sum("paymentEvents.events")] },
        sort: [{ field: sum("paymentEvents.events"), direction: "desc" }],
        format: { ...titled("Events by type", "How often each event was recorded"), style: NO_LEGEND },
      },
      events: {
        type: "grid",
        dataMapping: {
          cols: [
            field("paymentEvents.at"),
            field("paymentEvents.deal"),
            field("paymentEvents.type"),
            field("paymentEvents.amountUsd"),
            field("paymentEvents.seller"),
            field("paymentEvents.paymentRail"),
            field("paymentEvents.reference"),
          ],
        },
        sort: [{ field: field("paymentEvents.at"), direction: "desc" }],
        format: { ...titled("Payment event log", "Newest first. The reference is the PayPal id the event is about."), style: { columnAutoSize: true } },
      },
    },
    widgetLayout: {
      "tile-events": at(0, 0, 6, 6),
      "tile-authorized": at(6, 0, 6, 6),
      "tile-captured": at(12, 0, 6, 6),
      "tile-held": at(18, 0, 6, 6),
      "over-time": at(0, 6, 14, 19),
      "by-type": at(14, 6, 10, 19),
      events: at(0, 25, 24, 22),
    },
  };
}

/** The default report. A fresh object every call: Studio owns and mutates-by-replacement what it is given. */
export function buildDefaultReport(): PactReportState {
  return {
    pages: [overviewPage(), ledgerPage(), verificationPage(), paymentsPage()],
    selectedPageId: PAGE.overview,
    panels: {
      ai: { collapsed: true },
      filters: { collapsed: true },
      edit: { collapsed: true },
      data: { collapsed: true },
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Introspection (used by the tests and by the agent's instructions)          */
/* -------------------------------------------------------------------------- */

function isFieldReference(value: unknown): value is AgWidgetFieldReference {
  return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string";
}

/** Every "table.field" id a report maps, sorts or filters by. */
export function reportFieldRefs(report: PactReportState): string[] {
  const refs = new Set<string>();
  for (const page of report.pages) {
    for (const widget of Object.values(page.widgets)) {
      for (const slot of Object.values(widget.dataMapping as Record<string, unknown>)) {
        if (Array.isArray(slot)) slot.filter(isFieldReference).forEach((ref) => refs.add(ref.id));
      }
      for (const sort of widget.sort ?? []) refs.add(sort.field.id);
    }
    for (const filter of page.filter?.page ?? []) refs.add(filter.field.id);
    for (const filters of Object.values(page.filter?.widget ?? {})) filters.forEach((filter) => refs.add(filter.field.id));
  }
  return [...refs].sort();
}

/** Pairs of widget ids whose rectangles intersect on a page. Empty for a well-formed layout. */
export function overlappingWidgets(page: PactPageState): [string, string][] {
  const entries = Object.entries(page.widgetLayout);
  const clashes: [string, string][] = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [idA, a] = entries[i]!;
      const [idB, b] = entries[j]!;
      const apart =
        a.xTrack + a.xSpan <= b.xTrack || b.xTrack + b.xSpan <= a.xTrack || a.yTrack + a.ySpan <= b.yTrack || b.yTrack + b.ySpan <= a.yTrack;
      if (!apart) clashes.push([idA, idB]);
    }
  }
  return clashes;
}
