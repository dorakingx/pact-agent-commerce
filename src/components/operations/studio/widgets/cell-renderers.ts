/**
 * Cell renderers that teach Studio's table widgets PACT's vocabulary: a status is a pill, a
 * risk a badge, a simulated payment is labelled, a deal code opens the deal.
 *
 * They are plain DOM components, not React ones, on purpose. Studio sizes a table's columns to
 * their content the moment it is laid out; a React renderer paints a frame later, so its cells
 * are measured empty and every pill ends up truncated. A DOM renderer is in the cell when the
 * measurement happens. The markup and classes mirror the React primitives in components/ui
 * (StatusPill, Badge) so a pill in a table is indistinguishable from one anywhere else.
 */
import type { ICellRendererComp, ICellRendererParams } from "ag-grid-community";
import type { AgWidgetField } from "ag-studio";
import { cn } from "@/components/ui/cn";
import { CHECK_RESULT_TONE, DEAL_STATUS_TONE, VERIFICATION_DECISION_TONE } from "@/components/ui/status";
import { TONE_CLASSES, type StatusTone } from "@/components/ui/tone";
import {
  cellKindOf,
  checkResultOfLabel,
  dealStatusOfLabel,
  isSimulatedRail,
  riskOfLabel,
  verificationOfLabel,
  type RiskKey,
} from "@/lib/client/studio-cells";
import { isAuto } from "@/lib/domain/status";
import type { PactStudioContext } from "../context";

type CellRendererClass = new () => ICellRendererComp;

const RISK_TONE: Record<RiskKey, StatusTone> = { high: "danger", medium: "hold", low: "neutral" };

/** Group rows and total rows have no value of their own: draw nothing rather than an empty pill. */
function textOf(params: ICellRendererParams): string | null {
  const value: unknown = params.valueFormatted ?? params.value;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The DOM twin of <StatusPill size="sm">: dot plus text, so colour is never the only signal. */
function pill(text: string, tone: StatusTone, pulse = false): HTMLElement {
  const classes = TONE_CLASSES[tone];
  const node = element(
    "span",
    cn("inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full border px-2 align-middle text-xs font-medium whitespace-nowrap", classes.soft, classes.text, classes.line),
  );
  node.dataset.tone = tone;
  const dot = element("span", cn("size-1.5 shrink-0 rounded-full bg-current", pulse && "animate-pulse-dot"));
  dot.setAttribute("aria-hidden", "true");
  node.append(dot, text);
  return node;
}

/** The DOM twin of <Badge>. */
function badge(text: string, tone: StatusTone, outline = false): HTMLElement {
  const classes = TONE_CLASSES[tone];
  return element(
    "span",
    cn(
      "inline-flex h-[22px] shrink-0 items-center rounded-md border px-1.5 align-middle text-xs font-medium whitespace-nowrap",
      outline ? cn("bg-transparent", tone === "neutral" ? "border-hairline-strong text-muted" : cn(classes.line, classes.text)) : cn("border-transparent", classes.soft, classes.text),
    ),
    text,
  );
}

const plain = (text: string): HTMLElement => element("span", "", text);

/** A renderer class from a function of the cell's text. `refresh` redraws in place, so a data poll never recreates cells. */
function renderer(draw: (text: string, params: ICellRendererParams) => HTMLElement): CellRendererClass {
  return class implements ICellRendererComp {
    private readonly gui = element("span", "inline-flex max-w-full items-center");

    init(params: ICellRendererParams): void {
      this.draw(params);
    }

    getGui(): HTMLElement {
      return this.gui;
    }

    refresh(params: ICellRendererParams): boolean {
      this.draw(params);
      return true;
    }

    private draw(params: ICellRendererParams): void {
      const text = textOf(params);
      this.gui.replaceChildren(...(text === null ? [] : [draw(text, params)]));
    }
  };
}

const StatusCell = renderer((text) => {
  const status = dealStatusOfLabel(text);
  return status === null ? plain(text) : pill(text, DEAL_STATUS_TONE[status], isAuto(status));
});

const RiskCell = renderer((text) => {
  const risk = riskOfLabel(text);
  return risk === null ? plain(text) : badge(text, RISK_TONE[risk]);
});

const ResultCell = renderer((text) => {
  const result = checkResultOfLabel(text);
  return result === null ? plain(text) : pill(text, CHECK_RESULT_TONE[result]);
});

const VerificationCell = renderer((text) => {
  const decision = verificationOfLabel(text);
  return decision === null ? plain(text) : pill(text, VERIFICATION_DECISION_TONE[decision]);
});

/** A simulated payment is labelled as one in every row it appears in. */
const RailCell = renderer((text) => (isSimulatedRail(text) ? badge(text, "neutral", true) : plain(text)));

const EvaluatorCell = renderer((text) => badge(text, text === "AI" ? "info" : "neutral", true));

/** One deal-code renderer per Studio instance: it opens deals through that instance's context. */
const dealCells = new WeakMap<PactStudioContext, CellRendererClass>();

function dealCellFor(context: PactStudioContext): CellRendererClass {
  const existing = dealCells.get(context);
  if (existing) return existing;
  const DealCell = renderer((code) => {
    // Resolved on click, not on draw: the snapshot behind the context changes with every poll.
    if (context.dealByCode(code) === null) return element("span", "font-medium tabular-nums", code);
    const button = element(
      "button",
      "rounded-sm font-medium text-accent tabular-nums underline-offset-2 focus-ring hover:underline",
      code,
    );
    button.type = "button";
    button.title = `Open ${code}`;
    button.dataset.testid = "ledger-open-deal";
    button.dataset.dealCode = code;
    button.addEventListener("click", (event) => {
      // The click is the cell's own action, not a row selection or a cross filter.
      event.stopPropagation();
      const row = context.dealByCode(code);
      if (row !== null) context.openDeal(row.id);
    });
    return button;
  });
  dealCells.set(context, DealCell);
  return DealCell;
}

/** The renderer for a field's column, chosen by the `cell` kind the data model tagged it with. */
export function cellRendererFor(field: AgWidgetField, context: PactStudioContext): CellRendererClass | undefined {
  switch (cellKindOf(field.context)) {
    case "deal":
      return dealCellFor(context);
    case "status":
      return StatusCell;
    case "risk":
      return RiskCell;
    case "result":
      return ResultCell;
    case "verification":
      return VerificationCell;
    case "rail":
      return RailCell;
    case "evaluator":
      return EvaluatorCell;
    case null:
      return undefined;
  }
}
