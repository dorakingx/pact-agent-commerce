/**
 * The data model AG Studio is given: four tables, their fields and the relationships between
 * them.
 *
 * Field names and descriptions are written twice over for two readers. A person sees the name
 * in the data panel, on axes and in column headers, so it has to be finished wording. Studio's
 * agents read the description when they decide which field answers a question, so it has to say
 * what the number means in PACT's terms (held is not captured; released is not refunded).
 *
 * The model is fixed. A refresh replaces the rows and nothing else, which is the only kind of
 * change Studio applies to `data` after the first render — and exactly why the user's layout,
 * filters and selections survive every poll.
 */
import type { AgDataRelationDefinition, AgFieldCardinality, AgFormats } from "ag-studio";
import type { CellContext } from "./studio-cells";
import type { StudioRows } from "./studio-data";

export const TABLE = { deals: "deals", stages: "stages", paymentEvents: "paymentEvents", checks: "checks" } as const;
export type StudioTableId = (typeof TABLE)[keyof typeof TABLE];

/**
 * A field as this model declares it: the plain-data subset of Studio's field definition. Kept
 * structural (rather than Studio's generic type) so the model fits a Studio instance whatever
 * custom widgets its registry adds.
 */
export interface StudioField {
  id: string;
  name: string;
  description?: string;
  format: keyof AgFormats;
  formatOptions?: { format: string };
  /** What an empty cell shows. */
  blankValue?: string;
  hide?: boolean;
  notBlank?: boolean;
  cardinality?: AgFieldCardinality;
  context?: CellContext;
}
type Field = StudioField;

export interface StudioTable {
  id: StudioTableId;
  name: string;
  description: string;
  data: object[];
  fields: StudioField[];
}

/** The value of Studio's `data` property. */
export interface StudioDataModel {
  description: string;
  sources: StudioTable[];
  relationships: AgDataRelationDefinition[];
}

const USD = { format: "$#,##0.00" } as const;
const WHOLE = { format: "#,##0" } as const;
const PERCENT = { format: "0%" } as const;
const ONE_DECIMAL = { format: "#,##0.0" } as const;
const DATE = { format: "d mmm yyyy" } as const;
const DATE_TIME = { format: "d mmm yyyy, hh:mm" } as const;
const YES_NO = { format: '"Yes";"No"' } as const;

/** One dash for "nothing here", instead of Studio's "(Blanks)" and "N/A", in every table and tooltip. */
const BLANK = "—";

const text = (id: string, name: string, description: string, extra: Partial<Field> = {}): Field => ({
  id,
  name,
  description,
  format: "textFormat",
  blankValue: BLANK,
  ...extra,
});
const usd = (id: string, name: string, description: string): Field => ({
  id,
  name,
  description,
  format: "currencyFormat",
  formatOptions: USD,
  blankValue: BLANK,
  notBlank: true,
});
const count = (id: string, name: string, description: string, extra: Partial<Field> = {}): Field => ({
  id,
  name,
  description,
  format: "integerFormat",
  formatOptions: WHOLE,
  blankValue: BLANK,
  ...extra,
});
const percent = (id: string, name: string, description: string): Field => ({
  id,
  name,
  description,
  format: "percentageFormat",
  formatOptions: PERCENT,
  blankValue: BLANK,
});
const dateTime = (id: string, name: string, description: string): Field => ({
  id,
  name,
  description,
  format: "dateTimeFormat",
  formatOptions: DATE_TIME,
  blankValue: BLANK,
});
const day = (id: string, name: string, description: string): Field => ({
  id,
  name,
  description,
  format: "dateFormat",
  formatOptions: DATE,
});
const yesNo = (id: string, name: string, description: string): Field => ({
  id,
  name,
  description,
  format: "booleanFormat",
  formatOptions: YES_NO,
});
/** Marks a field for one of the dashboard's cell renderers (see studio-cells.ts). */
const cell = (kind: CellContext["cell"]): Pick<Field, "context"> => ({ context: { cell: kind } satisfies CellContext });
/** Join keys: present for relationships, never offered in the data panel. */
const key = (id: string, name: string): Field => ({ id, name, format: "textFormat", hide: true });

export const DEAL_FIELDS: readonly Field[] = [
  key("id", "Deal ID"),
  text("code", "Deal", "Short human-readable deal code, e.g. PACT-7K2Q. Unique per deal.", { cardinality: "high", ...cell("deal") }),
  text("title", "Title", "What was bought: the contract title, or the buyer agent's summary before a contract exists.", {
    cardinality: "high",
  }),
  text("status", "Status", "Exact lifecycle state of the deal, e.g. 'Authorized · work in progress' or 'Human review required'.", {
    cardinality: "low",
    ...cell("status"),
  }),
  text(
    "stage",
    "Stage",
    "Coarse stage the deal is in now: Negotiation, Contract, Payment, Fulfillment, Verification, Settled (captured) or Closed (ended without a capture).",
    { cardinality: "low" },
  ),
  count("stageOrder", "Stage order", "Position of the stage in the lifecycle (1 = Negotiation … 7 = Closed). Use it to sort stages.", {
    formatOptions: { format: "0" },
  }),
  text(
    "outcome",
    "Outcome",
    "How the deal ended, or 'In progress': Captured, Voided (hold released), Declined (by a human), Blocked (by policy), No agreement, Failed (payment).",
    { cardinality: "low" },
  ),
  text("seller", "Seller", "The seller agent the buyer agent dealt with.", { cardinality: "low" }),
  text("sellerTrust", "Seller trust", "'Established' or 'New seller'. New sellers can require human approval under policy.", {
    cardinality: "low",
  }),
  text("sellerNote", "Seller note", "Set for controlled demo-fault sellers, e.g. 'Demo fault: omits a required variant'.", {
    cardinality: "low",
  }),
  text("category", "Category", "Kind of work: Illustration, Copywriting, Translation.", { cardinality: "low" }),
  text("origin", "Origin", "'This session' for deals started in this browser, 'Showcase' for seeded reference deals.", {
    cardinality: "low",
  }),
  count("deals", "Deals", "Always 1. Sum it to count deals.", { notBlank: true }),
  usd("priceUsd", "Contract value", "Agreed contract price in USD. 0 until a contract exists."),
  usd("listPriceUsd", "List price", "The seller's opening quote in USD, before negotiation."),
  usd("savedUsd", "Saved by negotiation", "List price minus contract price in USD: what the buyer agent negotiated off."),
  usd("authorizedUsd", "Authorized", "Amount PayPal authorized (placed on hold) for the deal in USD, whatever happened afterwards."),
  usd("capturedUsd", "Captured", "Amount actually captured (paid to the seller) in USD. Only happens after verification passes."),
  usd("heldUsd", "Held", "Authorized and still held right now in USD: not yet captured and not yet released."),
  usd("releasedUsd", "Released back", "Authorized money released without capture in USD (voided, expired, or the remainder of a partial capture)."),
  text("paymentStatus", "Payment status", "State of the PayPal payment: Order created, Authorized · held, Captured, Voided, Expired, Failed.", {
    cardinality: "low",
  }),
  text("paymentRail", "Rail", "Payment rail: 'PayPal Sandbox' or 'Simulated' (keyless demo mode; no PayPal call was made).", {
    cardinality: "low",
    ...cell("rail"),
  }),
  text("approvalMode", "Approval mode", "How the payer consented: 'Interactive approval' (in PayPal) or 'Delegated wallet' (pre-consented agent wallet).", {
    cardinality: "low",
  }),
  text("paypalOrderId", "PayPal order ID", "PayPal order id, if an order was created.", { cardinality: "high" }),
  text("paypalAuthorizationId", "PayPal authorization ID", "PayPal authorization id, once funds were held.", { cardinality: "high" }),
  text("paypalCaptureId", "PayPal capture ID", "PayPal capture id, once funds were captured.", { cardinality: "high" }),
  yesNo("webhookConfirmed", "Webhook confirmed", "Whether a verified PayPal webhook has confirmed the payment state."),
  text(
    "verification",
    "Verification",
    "Decision of the latest verification report: Capture eligible, Human review, Revision required, Rejected. Blank before any delivery was verified.",
    { cardinality: "low", ...cell("verification") },
  ),
  percent("confidence", "Confidence", "Weakest required check of the latest verification report, 0–1. Average it; do not sum it."),
  percent(
    "firstPass",
    "First-pass rate",
    "1 when the deal's FIRST delivery passed verification, 0 when it did not, blank when nothing was verified. Average it to get the first-pass rate.",
  ),
  count("failedRules", "Failed conditions", "Number of contract conditions the latest verification report marked as failed."),
  count("revisionsUsed", "Revisions used", "Revision rounds the seller has used."),
  count("negotiationMoves", "Negotiation moves", "Offers and counter-offers exchanged by the two agents."),
  count("guardrailInterventions", "Guardrail interventions", "Negotiation moves the deterministic rules engine had to correct."),
  text("policy", "Policy outcome", "Result of the spending policy: Within policy, Needs approval, Blocked.", { cardinality: "low" }),
  text("policyFlags", "Policy flags", "Plain-language list of the policy checks that did not pass.", { cardinality: "medium" }),
  count("humanDecisions", "Human decisions", "How many decisions a person made on this deal."),
  count("awaitingHuman", "Deals awaiting a human", "1 while the deal waits for a person (approval or review gate), else 0. Sum it.", {
    notBlank: true,
  }),
  text("stopReason", "Why it stopped", "One sentence on why the deal is standing still or at risk. Blank for healthy deals.", {
    cardinality: "high",
  }),
  text("risk", "Risk", "Operational risk rating: High, Medium or Low.", { cardinality: "low", ...cell("risk") }),
  count("riskOrder", "Risk order", "1 = High, 2 = Medium, 3 = Low. Use it to sort by risk.", { formatOptions: { format: "0" } }),
  text("riskReasons", "Risk reasons", "The reasons behind the risk rating, e.g. a deadline inside 24h with nothing delivered.", {
    cardinality: "high",
  }),
  yesNo("aiDegraded", "AI degraded", "Whether an AI call failed and a scripted fallback or degraded verification was used."),
  dateTime("deadline", "Deadline", "Delivery deadline in force for the deal."),
  {
    id: "hoursToDeadline",
    name: "Hours to deadline",
    description: "Hours until the deadline; negative once it has passed. Blank when there is no deadline.",
    format: "decimalFormat",
    formatOptions: ONE_DECIMAL,
    blankValue: BLANK,
  },
  dateTime("createdAt", "Created", "When the deal was started."),
  dateTime("updatedAt", "Last update", "When the deal last changed."),
  day("day", "Day", "UTC calendar day the deal was started, for time series."),
];

export const STAGE_FIELDS: readonly Field[] = [
  key("id", "Row ID"),
  key("dealId", "Deal ID"),
  text("stage", "Stage reached", "A stage the deal passed through: Negotiation, Contract, Payment, Fulfillment, Verification, Settled.", {
    cardinality: "low",
  }),
  count("stageOrder", "Stage order", "Position of the stage in the funnel (1 = Negotiation … 6 = Settled). Use it to sort stages.", {
    formatOptions: { format: "0" },
    notBlank: true,
  }),
  count("deals", "Deals", "Always 1. Sum it to count the deals that reached a stage.", { notBlank: true }),
  usd("valueUsd", "Contract value", "Contract value in USD of the deal that reached the stage."),
];

export const PAYMENT_EVENT_FIELDS: readonly Field[] = [
  key("id", "Event ID"),
  key("dealId", "Deal ID"),
  text("deal", "Deal", "Code of the deal the event belongs to.", { cardinality: "high", ...cell("deal") }),
  dateTime("at", "Time", "When the event was recorded."),
  day("day", "Day", "UTC calendar day of the event, for time series."),
  text(
    "type",
    "Event",
    "What happened at PayPal: Order created, Approved by payer, Authorized, Captured, Voided, Capture blocked, Webhook confirmation, Reconciled …",
    { cardinality: "low" },
  ),
  count("events", "Events", "Always 1. Sum it to count events.", { notBlank: true }),
  count("captures", "Captures", "1 for a capture event, else 0.", { notBlank: true }),
  count("authorizations", "Authorizations", "1 for an authorization (funds placed on hold), else 0.", { notBlank: true }),
  count("problems", "Blocked or failed", "1 when a capture was blocked by the settlement guard or a payment step failed, else 0.", { notBlank: true }),
  count("orders", "Orders and approvals", "1 for an order being created or approved by the payer, else 0.", { notBlank: true }),
  count("releases", "Voided or released", "1 when a hold was voided, cancelled by the payer or expired, else 0.", { notBlank: true }),
  count("confirmations", "Confirmations", "1 for a webhook confirmation, a pending-capture notice or a reconciliation, else 0.", { notBlank: true }),
  usd("amountUsd", "Amount", "Amount the event itself states in USD; 0 for events that move or hold no money."),
  text("seller", "Seller", "The seller agent of the deal.", { cardinality: "low" }),
  text("paymentRail", "Rail", "Payment rail: 'PayPal Sandbox' or 'Simulated'.", { cardinality: "low", ...cell("rail") }),
  text("reference", "PayPal reference", "The most specific PayPal id the event is about: capture, authorization or order id.", {
    cardinality: "high",
  }),
];

export const CHECK_FIELDS: readonly Field[] = [
  key("id", "Check ID"),
  key("dealId", "Deal ID"),
  text("deal", "Deal", "Code of the deal that was verified.", { cardinality: "high", ...cell("deal") }),
  count("round", "Round", "Verification round: 1 for the first delivery, 2 after a revision.", { formatOptions: { format: "0" } }),
  text("rule", "Rule", "Rule id inside the contract, e.g. R3.", { cardinality: "low" }),
  text("kind", "Rule kind", "What the rule checks: Deliverable count, Aspect ratios, File format, Deadline, Brief adherence, Hidden instructions …", {
    cardinality: "low",
  }),
  text("condition", "Condition", "The contract condition in plain language.", { cardinality: "high" }),
  text("evaluator", "Evaluator", "'Deterministic' (plain code) or 'AI' (model judgement).", { cardinality: "low", ...cell("evaluator") }),
  text("result", "Result", "Pass, Fail or Uncertain.", { cardinality: "low", ...cell("result") }),
  percent("confidence", "Confidence", "Confidence of the check, 0–1. Deterministic checks are always 100%."),
  text("confidenceBand", "Confidence band", "Confidence bucket: 0–49%, 50–69%, 70–84%, 85–94%, 95–100%. Sorts alphabetically into numeric order.", {
    cardinality: "low",
  }),
  yesNo("required", "Required", "Whether the rule gates payment. Advisory rules never block a capture."),
  count("checks", "Checks", "Always 1. Sum it to count checks.", { notBlank: true }),
  count("passed", "Passed", "1 when the check passed, else 0.", { notBlank: true }),
  count("failed", "Failed", "1 when the check failed, else 0. Sum it to count failures.", { notBlank: true }),
  count("uncertain", "Uncertain", "1 when the check was inconclusive, else 0.", { notBlank: true }),
  {
    id: "failPercent",
    name: "Failure share",
    description: "100 when the check failed, else 0. Average it: the percentage of checked conditions that failed.",
    format: "decimalFormat",
    formatOptions: { format: '0.0"%"' },
    blankValue: BLANK,
    notBlank: true,
  },
  text("seller", "Seller", "The seller agent whose delivery was checked.", { cardinality: "low" }),
  dateTime("at", "Verified at", "When the verification report was written."),
  day("day", "Day", "UTC calendar day of the verification report."),
];

export const STUDIO_FIELDS: Record<StudioTableId, readonly Field[]> = {
  deals: DEAL_FIELDS,
  stages: STAGE_FIELDS,
  paymentEvents: PAYMENT_EVENT_FIELDS,
  checks: CHECK_FIELDS,
};

/**
 * Deals are the shared dimension: every other table points at them, so a filter on a deal
 * attribute (seller, status, risk, date) narrows the funnel, the payment events and the
 * verification checks with it.
 */
export const STUDIO_RELATIONSHIPS: readonly AgDataRelationDefinition[] = [
  { id: "stages-deals", source: { tableId: "stages", fieldId: "dealId" }, target: { tableId: "deals", fieldId: "id" }, type: "many-to-one" },
  {
    id: "paymentEvents-deals",
    source: { tableId: "paymentEvents", fieldId: "dealId" },
    target: { tableId: "deals", fieldId: "id" },
    type: "many-to-one",
  },
  { id: "checks-deals", source: { tableId: "checks", fieldId: "dealId" }, target: { tableId: "deals", fieldId: "id" }, type: "many-to-one" },
];

const TABLE_META: Record<StudioTableId, { name: string; description: string }> = {
  deals: {
    name: "Deals",
    description:
      "One row per deal between the buyer agent and a seller agent: where it is in the lifecycle, the money authorized, held, captured and released, the verification decision, the policy outcome and a risk rating.",
  },
  stages: {
    name: "Settlement funnel",
    description:
      "One row per stage a deal passed through (Negotiation → Contract → Payment → Fulfillment → Verification → Settled). Count Deals by Stage reached for the funnel.",
  },
  paymentEvents: {
    name: "Payment events",
    description: "One row per PayPal-facing event of a deal, in the order it was recorded: orders, authorizations, captures, voids, webhooks.",
  },
  checks: {
    name: "Verification checks",
    description:
      "One row per contract condition checked in a verification report, across all rounds: which rule, who evaluated it (code or AI), the result and the confidence.",
  },
};

export const STUDIO_DATA_DESCRIPTION =
  "PACT (Programmable Agent Commerce Trust) operations data. AI agents negotiate a deal, PACT compiles a contract, places a PayPal authorization hold, and captures the money only if the delivery is verified against the contract; otherwise the hold is revised, reviewed by a human or voided. All amounts are USD. 'Held' means authorized but not captured; nothing is paid to a seller until a capture.";

/** The `data` property for AG Studio: the fixed model around the current rows. */
export function buildStudioDataSources(rows: StudioRows): StudioDataModel {
  const source = (id: StudioTableId, data: readonly object[]): StudioTable => ({
    id,
    name: TABLE_META[id].name,
    description: TABLE_META[id].description,
    data: [...data],
    fields: [...STUDIO_FIELDS[id]],
  });
  return {
    description: STUDIO_DATA_DESCRIPTION,
    sources: [
      source("deals", rows.deals),
      source("stages", rows.stages),
      source("paymentEvents", rows.paymentEvents),
      source("checks", rows.checks),
    ],
    relationships: [...STUDIO_RELATIONSHIPS],
  };
}

/** Whether `ref` ("table.field") names a field of the model. Used to keep the default report honest. */
export function isStudioFieldRef(ref: string): boolean {
  const dot = ref.indexOf(".");
  if (dot <= 0) return false;
  const table = ref.slice(0, dot);
  const field = ref.slice(dot + 1);
  return Object.hasOwn(STUDIO_FIELDS, table) && STUDIO_FIELDS[table as StudioTableId].some((candidate) => candidate.id === field);
}
