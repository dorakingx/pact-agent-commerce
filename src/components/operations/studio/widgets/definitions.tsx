/**
 * PACT's widgets, registered with AG Studio.
 *
 * Each of the three custom widgets is a full Studio citizen: a data mapping (so its fields are
 * chosen in the Compose panel like any chart's), a configuration form, a format shape (so saved
 * state is validated and Studio's agents can configure it) and AI metadata (so the agents know
 * when to place it). They are built from React and SVG only — no AG Grid or AG Charts inside —
 * which keeps them within what a Studio licence covers.
 *
 * The built-in table widgets are also taught PACT's vocabulary through cell renderers: a status
 * is a pill, a deal code opens the deal.
 */
import type {
  AgCreateWidgetsParams,
  AgDefaultRegistry,
  AgDefaultWidgetDefinition,
  AgExternalShape,
  AgShapeBuilder,
  AgStudioApi,
  AgWidgetField,
  AgWidgetFormParams,
  AgWidgetsConfig,
} from "ag-studio";
import { createWidgets, type AgRegistry, type AgWidgetDefinition } from "ag-studio-react";
import {
  WIDGET_DEFAULTS,
  WIDGET_TYPE,
  type ReviewQueueWidget,
  type SettlementRailWidget,
  type VerdictCardWidget,
} from "@/lib/client/studio-widgets";
import type { PactStudioContext } from "../context";
import { cellRendererFor } from "./cell-renderers";
import { QUEUE_ICON, RAIL_ICON, VERDICT_ICON } from "./icons";
import { ReviewQueue } from "./review-queue";
import { SettlementRail } from "./settlement-rail";
import { VerdictCard } from "./verdict-card";

type RailDefinition = AgWidgetDefinition<typeof WIDGET_TYPE.rail, SettlementRailWidget>;
type QueueDefinition = AgWidgetDefinition<typeof WIDGET_TYPE.queue, ReviewQueueWidget>;
type VerdictDefinition = AgWidgetDefinition<typeof WIDGET_TYPE.verdict, VerdictCardWidget>;

/** Studio's React registry extended with PACT's widgets. */
export interface PactRegistry extends AgRegistry {
  widgets: readonly (AgDefaultWidgetDefinition | RailDefinition | QueueDefinition | VerdictDefinition)[];
}

/* -------------------------------------------------------------------------- */
/*  Format shapes                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build a format shape with Studio's shape builder.
 *
 * A widget's `formatShape` callback is handed the Studio API but no builder, and the builder is
 * not exported. The API does hand one to a command definition, and a command exposes the shape
 * it was defined with — so the shape is declared as the input of a command that is never run.
 */
function shapeOf<T>(api: AgStudioApi, build: (s: AgShapeBuilder) => unknown): AgExternalShape<T> {
  const command = api.defineAiCommand((s) => ({
    input: build(s) as AgExternalShape<T>,
    execute: () => ({ success: true as const, value: undefined }),
  }));
  return command.shape as AgExternalShape<T>;
}

/** The parts of `format` every Studio widget shares. Undeclared keys are dropped on load, so all of them are listed. */
function commonFormat(s: AgShapeBuilder) {
  const typography = s
    .object({
      fontFamily: s.string().optional(),
      fontSize: s.number().optional(),
      fontWeight: s.enum(["normal", "bold"]).optional(),
      fontStyle: s.enum(["normal", "italic"]).optional(),
    })
    .optional();
  const title = (description: string) =>
    s
      .object(
        {
          enabled: s.boolean().optional(),
          text: s.string({ description: "The text to show." }).optional(),
          typography,
          color: s.string({ description: "CSS colour of the text." }).optional(),
          textAlign: s.enum(["left", "center", "right"]).optional(),
          wrapping: s.boolean().optional(),
        },
        { description },
      )
      .optional();
  return {
    title: title("Widget title, shown above the content."),
    subtitle: title("One supporting line under the title."),
    caption: title("Small print under the content."),
    widget: s
      .object(
        {
          backgroundColor: s.string().optional(),
          borderRadius: s.number().optional(),
          borderEnabled: s.boolean().optional(),
          borderWidth: s.number().optional(),
          borderColor: s.string().optional(),
        },
        { description: "Appearance of the widget container." },
      )
      .optional(),
    crossFilter: s
      .enum(["highlight", "filter", "none"], { description: "How the widget reacts to selections made in other widgets." })
      .optional(),
  };
}

/* -------------------------------------------------------------------------- */
/*  Definitions                                                                */
/* -------------------------------------------------------------------------- */

const railDefinition: RailDefinition = {
  id: WIDGET_TYPE.rail,
  label: "Settlement rail",
  icon: RAIL_ICON,
  comp: SettlementRail,
  defaultSize: { width: 960, height: 208 },
  minSize: { width: 320, height: 160 },
  dataMapping: {
    stage: {
      type: "field",
      supportedRoles: ["category"],
      requires: { cardinality: "many" },
      required: true,
      intent: "category",
      aiDescription: "The lifecycle stage of each deal. Use the deals table's Stage field (deals.stage).",
    },
    deals: {
      type: "field",
      supportedRoles: ["numeric"],
      requires: { per: "dataMapping.stage", cardinality: "one" },
      required: true,
      intent: "value",
      aiDescription: "Number of deals at each stage. Use sum of deals.deals.",
    },
    held: {
      type: "field",
      supportedRoles: ["numeric"],
      requires: { per: "dataMapping.stage", cardinality: "one" },
      intent: "value",
      aiDescription: "Dollars authorized and still held at each stage. Use sum of deals.heldUsd.",
    },
    captured: {
      type: "field",
      supportedRoles: ["numeric"],
      requires: { per: "dataMapping.stage", cardinality: "one" },
      intent: "value",
      aiDescription: "Dollars captured, shown on the 'Captured' exit. Use sum of deals.capturedUsd.",
    },
    released: {
      type: "field",
      supportedRoles: ["numeric"],
      requires: { per: "dataMapping.stage", cardinality: "one" },
      intent: "value",
      aiDescription: "Dollars released without capture, shown on the 'No capture' exit. Use sum of deals.releasedUsd.",
    },
  },
  formatShape: ({ api }) =>
    shapeOf<SettlementRailWidget["format"]>(api, (s) =>
      s.object({
        ...commonFormat(s),
        style: s
          .object({
            showAmounts: s.boolean({ description: "Print the dollars held at each stage." }).optional(),
            showExits: s.boolean({ description: "Show the Captured and No capture exits at the end of the rail." }).optional(),
          })
          .optional(),
      }),
    ),
  form: (params: AgWidgetFormParams<SettlementRailWidget>) => {
    const form = params.createDefaults({
      dataMappingItems: [
        { key: "stage", label: "Stage" },
        { key: "deals", label: "Deals" },
        { key: "held", label: "Held" },
        { key: "captured", label: "Captured" },
        { key: "released", label: "Released" },
      ],
    });
    form.items[0]?.items.push({
      type: "section",
      key: "pactRail",
      label: "Rail",
      items: [
        { type: "toggle", id: "format.style.showAmounts", label: "Show dollars held", defaultValue: WIDGET_DEFAULTS.rail.showAmounts },
        { type: "toggle", id: "format.style.showExits", label: "Show the two exits", defaultValue: WIDGET_DEFAULTS.rail.showExits },
      ],
    });
    form.items[1]?.items.push(params.createWidgetAppearanceSection());
    return form;
  },
  ai: {
    label: "Settlement rail",
    description:
      "PACT's settlement state machine as a horizontal rail: Negotiation, Contract, Payment, Fulfillment and Verification stations with the number of deals at each and the dollars held there, ending in two exits, Captured and No capture.",
    usage:
      "Use it to show where deals are in the lifecycle right now and where money is being held. It is the signature view of the product: prefer it over a bar chart of stages. Clicking a station cross-filters the page. Not for trends over time.",
    configuration:
      "Map stage to deals.stage, deals to sum(deals.deals), held to sum(deals.heldUsd), captured to sum(deals.capturedUsd), released to sum(deals.releasedUsd). Give it the full page width and about 13 rows of height.",
  },
};

const queueDefinition: QueueDefinition = {
  id: WIDGET_TYPE.queue,
  label: "Human review queue",
  icon: QUEUE_ICON,
  comp: ReviewQueue,
  defaultSize: { width: 520, height: 384 },
  minSize: { width: 280, height: 176 },
  dataMapping: {
    deal: {
      type: "field",
      supportedRoles: ["category"],
      requires: { cardinality: "many" },
      required: true,
      intent: "category",
      aiDescription: "The deal code: one card per deal. Use deals.code.",
    },
    status: {
      type: "field",
      supportedRoles: ["category"],
      requires: { per: "dataMapping.deal", cardinality: "one" },
      required: true,
      aiDescription: "Lifecycle status, used to keep only deals waiting for a person. Use deals.status.",
    },
    seller: {
      type: "field",
      supportedRoles: ["category"],
      requires: { per: "dataMapping.deal", cardinality: "one" },
      aiDescription: "Seller shown on the card. Use deals.seller.",
    },
    amount: {
      type: "field",
      supportedRoles: ["numeric"],
      requires: { per: "dataMapping.deal", cardinality: "one" },
      intent: "value",
      aiDescription: "Amount at stake in USD. Use sum of deals.priceUsd.",
    },
    reason: {
      type: "field",
      supportedRoles: ["category"],
      requires: { per: "dataMapping.deal", cardinality: "one" },
      aiDescription: "Why the deal stopped. Use deals.stopReason.",
    },
    since: {
      type: "field",
      supportedRoles: ["temporal", "category"],
      requires: { per: "dataMapping.deal", cardinality: "one" },
      aiDescription: "When the deal last moved, i.e. since when it has been waiting. Use deals.updatedAt.",
    },
  },
  formatShape: ({ api }) =>
    shapeOf<ReviewQueueWidget["format"]>(api, (s) =>
      s.object({
        ...commonFormat(s),
        style: s
          .object({
            maxItems: s.number({ description: "Cards shown before the rest is summarised. 1 to 20." }).optional(),
            showReason: s.boolean({ description: "Show the sentence explaining why each deal stopped." }).optional(),
          })
          .optional(),
      }),
    ),
  form: (params: AgWidgetFormParams<ReviewQueueWidget>) => {
    const form = params.createDefaults({
      dataMappingItems: [
        { key: "deal", label: "Deal" },
        { key: "status", label: "Status" },
        { key: "seller", label: "Seller" },
        { key: "amount", label: "Amount" },
        { key: "reason", label: "Why it stopped" },
        { key: "since", label: "Waiting since" },
      ],
    });
    form.items[0]?.items.push({
      type: "section",
      key: "pactQueue",
      label: "Queue",
      items: [
        { type: "number", id: "format.style.maxItems", label: "Cards shown", defaultValue: WIDGET_DEFAULTS.queue.maxItems, min: 1, max: 20, step: 1 },
        { type: "toggle", id: "format.style.showReason", label: "Show why it stopped", defaultValue: WIDGET_DEFAULTS.queue.showReason },
      ],
    });
    form.items[1]?.items.push(params.createWidgetAppearanceSection());
    return form;
  },
  ai: {
    label: "Human review queue",
    description:
      "A list of cards, one per deal that is waiting for a person: deals awaiting spend approval and deals in human review. Each card shows the deal code, what is being asked, the seller, the amount, why the engine stopped and how long it has waited.",
    usage:
      "Use it when the reader needs to act: 'which deals need a human', 'what is waiting for approval'. It only ever lists deals at a human gate, whatever else is on the page. The widget is read-only: opening a card navigates to the deal, where a person decides.",
    configuration:
      "Map deal to deals.code, status to deals.status, seller to deals.seller, amount to sum(deals.priceUsd), reason to deals.stopReason, since to deals.updatedAt. About 11 columns by 24 rows.",
  },
};

const verdictDefinition: VerdictDefinition = {
  id: WIDGET_TYPE.verdict,
  label: "Verdict card",
  icon: VERDICT_ICON,
  comp: VerdictCard,
  defaultSize: { width: 620, height: 384 },
  minSize: { width: 300, height: 208 },
  dataMapping: {
    deal: {
      type: "field",
      supportedRoles: ["category"],
      requires: { cardinality: "many" },
      required: true,
      intent: "category",
      aiDescription: "Deal code of the verified delivery. Use checks.deal.",
    },
    condition: {
      type: "field",
      supportedRoles: ["category"],
      requires: { cardinality: "many" },
      required: true,
      aiDescription: "The contract condition that was checked. Use checks.condition.",
    },
    result: {
      type: "field",
      supportedRoles: ["category"],
      requires: { per: "dataMapping.condition", cardinality: "one" },
      required: true,
      aiDescription: "Pass, Fail or Uncertain. Use checks.result.",
    },
    round: {
      type: "field",
      supportedRoles: ["numeric", "category"],
      requires: { cardinality: "many" },
      aiDescription: "Verification round, so the latest delivery is shown. Use checks.round without aggregation.",
    },
    rule: {
      type: "field",
      supportedRoles: ["category"],
      requires: { cardinality: "many" },
      aiDescription: "Rule id, used to order the conditions and to look up evidence. Use checks.rule.",
    },
    evaluator: {
      type: "field",
      supportedRoles: ["category"],
      requires: { per: "dataMapping.condition", cardinality: "one" },
      aiDescription: "Who evaluated the condition: Deterministic or AI. Use checks.evaluator.",
    },
    confidence: {
      type: "field",
      supportedRoles: ["numeric"],
      requires: { per: "dataMapping.condition", cardinality: "one" },
      intent: "value",
      aiDescription: "Confidence of the check, 0 to 1. Use min of checks.confidence.",
    },
    at: {
      type: "field",
      supportedRoles: ["temporal", "category"],
      requires: { cardinality: "many" },
      aiDescription: "When the report was written, so the most recent delivery is chosen. Use checks.at.",
    },
  },
  formatShape: ({ api }) =>
    shapeOf<VerdictCardWidget["format"]>(api, (s) =>
      s.object({
        ...commonFormat(s),
        style: s
          .object({
            dealCode: s
              .string({ description: "Deal code to pin the card to, e.g. PACT-7K2Q. Empty shows the most recently verified deal." })
              .optional(),
            thresholdPercent: s.number({ description: "Auto-capture confidence threshold in percent (50 to 100), drawn as a marker." }).optional(),
            showEvidence: s.boolean({ description: "Show what the verifier observed for each condition." }).optional(),
          })
          .optional(),
      }),
    ),
  form: (params: AgWidgetFormParams<VerdictCardWidget>) => {
    const form = params.createDefaults({
      dataMappingItems: [
        { key: "deal", label: "Deal" },
        { key: "condition", label: "Condition" },
        { key: "result", label: "Result" },
        { key: "round", label: "Round" },
        { key: "rule", label: "Rule" },
        { key: "evaluator", label: "Evaluator" },
        { key: "confidence", label: "Confidence" },
        { key: "at", label: "Verified at" },
      ],
    });
    form.items[0]?.items.push({
      type: "section",
      key: "pactVerdict",
      label: "Verdict",
      items: [
        {
          type: "textfield",
          id: "format.style.dealCode",
          label: "Pin to deal code",
          defaultValue: WIDGET_DEFAULTS.verdict.dealCode,
          placeholder: { raw: "Latest verified deal" },
        },
        {
          type: "number",
          id: "format.style.thresholdPercent",
          label: "Auto-capture threshold (%)",
          defaultValue: WIDGET_DEFAULTS.verdict.thresholdPercent,
          min: 50,
          max: 100,
          step: 5,
        },
        { type: "toggle", id: "format.style.showEvidence", label: "Show evidence", defaultValue: WIDGET_DEFAULTS.verdict.showEvidence },
      ],
    });
    form.items[1]?.items.push(params.createWidgetAppearanceSection());
    return form;
  },
  ai: {
    label: "Verdict card",
    description:
      "The verification verdict of one delivery: a banner with the decision, then every contract condition with a PASS / FAIL / UNCERTAIN pill, the evaluator (deterministic code or AI), a confidence bar against the auto-capture threshold and the evidence observed.",
    usage:
      "Use it to explain why a deal was or was not captured. It shows the deal pinned in its settings, or else the most recently verified deal under the page's filters, so filtering the page to one deal shows that deal's verdict. Not a chart: do not use it to compare deals.",
    configuration:
      "Map deal to checks.deal, condition to checks.condition, result to checks.result, round to checks.round, rule to checks.rule, evaluator to checks.evaluator, confidence to min(checks.confidence), at to checks.at. Set style.dealCode to pin a deal. About 13 columns by 24 rows.",
  },
};

const PACT_WIDGET_IDS = [WIDGET_TYPE.rail, WIDGET_TYPE.queue, WIDGET_TYPE.verdict] as const;

type Overrides<TRegistry extends AgRegistry | AgDefaultRegistry> = NonNullable<AgCreateWidgetsParams<TRegistry>["overrides"]>;

/**
 * The `widgets` Studio property: Studio's own catalogue with a "PACT" group in front of it and
 * the table widgets rendering statuses and deal codes the way the rest of the product does.
 */
export function createPactWidgets(context: PactStudioContext): (defaults: AgWidgetsConfig<AgDefaultRegistry>) => AgWidgetsConfig<PactRegistry> {
  const createCellRenderer = (field: AgWidgetField) => cellRendererFor(field, context);
  const tableOverrides: Overrides<AgDefaultRegistry> = [
    { id: "grid", options: { createCellRenderer } },
    { id: "pivot-grid", options: { createCellRenderer } },
  ];
  return (defaults) =>
    createWidgets<PactRegistry>({
      additionalTypes: [railDefinition, queueDefinition, verdictDefinition],
      menu: [{ label: "PACT", widgetIds: PACT_WIDGET_IDS }, ...defaults.menu],
      // Studio types an override against the registry's widget ids taken together, which leaves
      // nothing assignable once a registry adds ids of its own. These override two of Studio's
      // own widgets, so they are typed against the default registry and passed on as they are.
      overrides: tableOverrides as unknown as Overrides<PactRegistry>,
    });
}
