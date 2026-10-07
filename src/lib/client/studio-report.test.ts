import { describe, expect, it } from "vitest";
import { STUDIO_FIELDS, isStudioFieldRef, type StudioTableId } from "./studio-model";
import { CANVAS_COLUMNS, PAGE, PAGE_TITLE, buildDefaultReport, overlappingWidgets, reportFieldRefs, type PactWidgetState } from "./studio-report";
import { WIDGET_TYPE } from "./studio-widgets";

const report = buildDefaultReport();
const NUMERIC = new Set(["integerFormat", "decimalFormat", "percentageFormat", "currencyFormat"]);

interface FieldRef {
  id: string;
  aggregation?: string;
}

function mappedRefs(widget: PactWidgetState): FieldRef[] {
  return Object.values(widget.dataMapping as Record<string, FieldRef[] | undefined>).flatMap((slot) => slot ?? []);
}

function formatOf(ref: string): string | undefined {
  const [table, field] = ref.split(".") as [StudioTableId, string];
  return STUDIO_FIELDS[table].find((candidate) => candidate.id === field)?.format;
}

describe("the default report", () => {
  it("has the four pages, in order, and opens on the overview with every panel collapsed", () => {
    expect(report.pages.map((page) => page.id)).toEqual([PAGE.overview, PAGE.ledger, PAGE.verification, PAGE.payments]);
    expect(report.selectedPageId).toBe(PAGE.overview);
    expect(Object.keys(PAGE_TITLE).sort()).toEqual(report.pages.map((page) => page.id).sort());
    expect(Object.values(report.panels).every((panel) => panel?.collapsed === true)).toBe(true);
  });

  it("only maps, sorts and filters by fields the data model has", () => {
    const refs = reportFieldRefs(report);
    expect(refs.length).toBeGreaterThan(30);
    expect(refs.filter((ref) => !isStudioFieldRef(ref))).toEqual([]);
  });

  it("gives every widget a place on the canvas, and every place a widget", () => {
    for (const page of report.pages) {
      expect(Object.keys(page.widgetLayout).sort()).toEqual(Object.keys(page.widgets).sort());
    }
  });

  it("lays widgets out inside the 24 columns without overlaps or gaps at the top", () => {
    for (const page of report.pages) {
      expect(overlappingWidgets(page), page.id).toEqual([]);
      const layouts = Object.values(page.widgetLayout);
      for (const layout of layouts) {
        expect(layout.xTrack).toBeGreaterThanOrEqual(0);
        expect(layout.xTrack + layout.xSpan).toBeLessThanOrEqual(CANVAS_COLUMNS);
        expect(layout.xSpan).toBeGreaterThan(0);
        expect(layout.ySpan).toBeGreaterThan(0);
      }
      expect(Math.min(...layouts.map((layout) => layout.yTrack))).toBe(0);
    }
  });

  it("fills every row of the canvas edge to edge", () => {
    for (const page of report.pages) {
      const layouts = Object.values(page.widgetLayout);
      const height = Math.max(...layouts.map((layout) => layout.yTrack + layout.ySpan));
      for (let row = 0; row < height; row += 1) {
        const covered = layouts.filter((layout) => layout.yTrack <= row && row < layout.yTrack + layout.ySpan).reduce((total, layout) => total + layout.xSpan, 0);
        expect(covered, `${page.id} row ${row}`).toBe(CANVAS_COLUMNS);
      }
    }
  });

  it("aggregates numbers only, and with an aggregation their format supports", () => {
    for (const page of report.pages) {
      for (const [id, widget] of Object.entries(page.widgets)) {
        for (const ref of mappedRefs(widget)) {
          if (ref.aggregation === undefined) continue;
          expect(["sum", "avg", "min"], `${page.id}/${id}`).toContain(ref.aggregation);
          expect(NUMERIC.has(formatOf(ref.id) ?? ""), `${page.id}/${id}: ${ref.id}`).toBe(true);
        }
      }
    }
  });

  it("sorts every widget by a field it also maps (Studio ignores any other sort), one sort per table", () => {
    for (const page of report.pages) {
      for (const [id, widget] of Object.entries(page.widgets)) {
        const mapped = mappedRefs(widget).map((ref) => `${ref.id}:${ref.aggregation ?? ""}`);
        for (const sort of widget.sort ?? []) {
          expect(mapped, `${page.id}/${id}`).toContain(`${sort.field.id}:${sort.field.aggregation ?? ""}`);
        }
        if (widget.type === "grid") expect(widget.sort?.length ?? 0, `${page.id}/${id}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("titles every chart and table in finished words, and labels every headline number", () => {
    for (const page of report.pages) {
      for (const [id, widget] of Object.entries(page.widgets)) {
        if (widget.type.endsWith("-filter")) continue;
        const format = widget.format as { title?: { text?: string }; caption?: { text?: string } } | undefined;
        const label = widget.type === "value" ? format?.caption?.text : format?.title?.text;
        expect(label, `${page.id}/${id}`).toBeTruthy();
        expect(label, `${page.id}/${id}`).not.toMatch(/sum\(|avg\(|Usd|_/);
      }
    }
  });

  it("puts the three PACT widgets on the overview with their required slots mapped", () => {
    const overview = report.pages[0]!;
    const types = Object.values(overview.widgets).map((widget) => widget.type);
    expect(types).toEqual(expect.arrayContaining([WIDGET_TYPE.rail, WIDGET_TYPE.queue, WIDGET_TYPE.verdict]));
    expect(overview.widgets.rail?.dataMapping).toMatchObject({ stage: [{ id: "deals.stage" }], deals: [{ id: "deals.deals", aggregation: "sum" }] });
    expect(overview.widgets.queue?.dataMapping).toMatchObject({ deal: [{ id: "deals.code" }], status: [{ id: "deals.status" }] });
    expect(overview.widgets.verdict?.dataMapping).toMatchObject({
      deal: [{ id: "checks.deal" }],
      condition: [{ id: "checks.condition" }],
      result: [{ id: "checks.result" }],
    });
  });

  it("shows the five headline tiles the overview promises", () => {
    const captions = Object.values(report.pages[0]!.widgets)
      .filter((widget) => widget.type === "value")
      .map((widget) => (widget.format as { caption?: { text?: string } }).caption?.text);
    expect(captions).toEqual(
      expect.arrayContaining(["Authorized now held", "Captured", "Released back", "Deals awaiting a human", "First-pass verification rate"]),
    );
  });

  it("offers status, seller, risk and date filters on the ledger", () => {
    const ledger = report.pages[1]!;
    const filters = Object.values(ledger.widgets).filter((widget) => widget.type.endsWith("-filter"));
    expect(filters.map((widget) => (widget.dataMapping as { value: FieldRef[] }).value[0]!.id).sort()).toEqual([
      "deals.day",
      "deals.risk",
      "deals.seller",
      "deals.status",
    ]);
    expect(ledger.widgets["by-status"]?.type).toBe("grid");
    expect(ledger.widgets.deals?.type).toBe("grid");
  });

  it("is a fresh object on every call, so a reset never hands Studio state it already mutated", () => {
    const again = buildDefaultReport();
    expect(again).toEqual(report);
    expect(again).not.toBe(report);
    expect(again.pages[0]).not.toBe(report.pages[0]);
    expect(again.pages[0]!.widgets.rail).not.toBe(report.pages[0]!.widgets.rail);
  });
});

describe("overlappingWidgets", () => {
  it("reports intersecting rectangles and ignores ones that only touch", () => {
    const page = {
      id: PAGE.overview,
      widgets: {},
      widgetLayout: {
        a: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 6 },
        b: { xTrack: 12, yTrack: 0, xSpan: 12, ySpan: 6 },
        c: { xTrack: 10, yTrack: 5, xSpan: 4, ySpan: 4 },
      },
    };
    expect(overlappingWidgets(page)).toEqual([
      ["a", "c"],
      ["b", "c"],
    ]);
  });
});
