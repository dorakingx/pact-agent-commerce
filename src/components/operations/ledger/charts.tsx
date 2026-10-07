"use client";

/**
 * The four ledger charts (AG Charts Community). They are drawn from the rows the grid's filters
 * let through, so the charts and the grid always describe the same set of deals; clicking a bar
 * or slice sets a cross-filter that narrows both.
 *
 * AG Charts paints on a canvas, which cannot read CSS variables, so the palette is resolved
 * from the app's variables in the browser and rebuilt whenever the theme changes.
 */
import { useMemo } from "react";
import {
  AllCommunityModule,
  type AgCartesianChartOptions,
  type AgChartOptions,
  type AgChartTheme,
  type AgNodeClickEvent,
  type AgPolarChartOptions,
} from "ag-charts-community";
import { AgCharts } from "ag-charts-react";
import { cn, useTheme, type Theme } from "@/components/ui";
import type { OpsCheckRow, OpsRow } from "@/lib/api/dto";
import {
  CHECK_RESULTS,
  checksByRuleKind,
  dealCountLabel,
  formatMoneyCompact,
  outcomeBreakdown,
  sellerVolume,
  volumeByDay,
  type CheckFilter,
  type CrossFilter,
  type DayVolumeDatum,
  type OpsOutcome,
  type OutcomeDatum,
  type RuleKindDatum,
  type SellerVolumeDatum,
} from "@/lib/client/ops-derive";
import { formatMoney } from "@/lib/domain/money";
import type { CheckResult } from "@/lib/domain/schemas";

const CHART_MODULES = [AllCommunityModule];
const CHART_HEIGHT = 156;

interface ChartPalette {
  mode: Theme;
  fg: string;
  muted: string;
  surface: string;
  hairline: string;
  accent: string;
  inverse: string;
  onInverse: string;
  info: string;
  hold: string;
  success: string;
  review: string;
  danger: string;
  neutral: string;
  faint: string;
  hairlineStrong: string;
  fontFamily: string;
}

/** Light-theme values, used until the browser has resolved the real ones (and if it cannot). */
const FALLBACK_PALETTE: ChartPalette = {
  mode: "light",
  fg: "#0b1220",
  muted: "#5b6472",
  surface: "#ffffff",
  hairline: "#e4e7ec",
  accent: "#0b7a5b",
  inverse: "#0b1220",
  onInverse: "#f2f4f7",
  info: "#4338ca",
  hold: "#b45309",
  success: "#0b7a5b",
  review: "#6d28d9",
  danger: "#b42318",
  neutral: "#475467",
  faint: "#667085",
  hairlineStrong: "#cfd4dc",
  fontFamily: "system-ui, sans-serif",
};

/** Reads the palette for `mode` from the CSS variables on <html>, which already reflect that mode. */
function readPalette(mode: Theme): ChartPalette {
  if (typeof document === "undefined") return FALLBACK_PALETTE;
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
  return {
    mode,
    fg: read("--fg", FALLBACK_PALETTE.fg),
    muted: read("--fg-muted", FALLBACK_PALETTE.muted),
    surface: read("--surface", FALLBACK_PALETTE.surface),
    hairline: read("--hairline", FALLBACK_PALETTE.hairline),
    accent: read("--accent", FALLBACK_PALETTE.accent),
    inverse: read("--inverse", FALLBACK_PALETTE.inverse),
    onInverse: read("--on-inverse", FALLBACK_PALETTE.onInverse),
    info: read("--info", FALLBACK_PALETTE.info),
    hold: read("--hold", FALLBACK_PALETTE.hold),
    success: read("--success", FALLBACK_PALETTE.success),
    review: read("--review", FALLBACK_PALETTE.review),
    danger: read("--danger", FALLBACK_PALETTE.danger),
    neutral: read("--neutral", FALLBACK_PALETTE.neutral),
    faint: read("--fg-faint", FALLBACK_PALETTE.faint),
    hairlineStrong: read("--hairline-strong", FALLBACK_PALETTE.hairlineStrong),
    fontFamily: getComputedStyle(document.body).fontFamily || FALLBACK_PALETTE.fontFamily,
  };
}

function chartTheme(palette: ChartPalette): AgChartTheme {
  return {
    baseTheme: palette.mode === "dark" ? "ag-default-dark" : "ag-default",
    params: {
      foregroundColor: palette.fg,
      backgroundColor: palette.surface,
      accentColor: palette.accent,
      fontFamily: palette.fontFamily,
      fontSize: 12,
      axisLineColor: palette.hairlineStrong,
      gridLineColor: palette.hairline,
      subtleTextColor: palette.muted,
      tooltipBackgroundColor: palette.inverse,
      tooltipTextColor: palette.onInverse,
      tooltipSubtleTextColor: palette.onInverse,
    },
  };
}

/**
 * Options every chart shares. The tile supplies the title, the legend and the frame as HTML
 * (readable by assistive technology, and clickable where a legend entry is a filter), so the
 * canvas only draws the plot.
 */
function baseOptions(
  palette: ChartPalette,
): Pick<AgChartOptions, "theme" | "background" | "padding" | "legend" | "height" | "minWidth" | "minHeight"> {
  return {
    theme: chartTheme(palette),
    height: CHART_HEIGHT,
    // AG Charts keeps its wrapper at least 300px wide by default. In a narrower tile that invisible
    // overhang would cover the neighbouring legend and swallow its clicks.
    minWidth: 0,
    minHeight: 0,
    background: { visible: false },
    padding: { top: 6, right: 14, bottom: 2, left: 6 },
    legend: { enabled: false },
  };
}

/** Category axis drawn on the left of a horizontal bar chart: names may take up to this share of the width before they are cut. */
const NAME_AXIS_MAX_RATIO = 0.46;

const OUTCOME_COLOR: Record<OpsOutcome, keyof ChartPalette> = {
  in_progress: "info",
  captured: "success",
  voided: "neutral",
  declined: "faint",
  blocked: "review",
  no_agreement: "hairlineStrong",
  failed: "danger",
};

const RESULT_COLOR: Record<CheckResult, keyof ChartPalette> = { pass: "success", fail: "danger", uncertain: "review" };
const RESULT_NAME: Record<CheckResult, string> = { pass: "Pass", fail: "Fail", uncertain: "Uncertain" };

function isCheckResult(value: unknown): value is CheckResult {
  return typeof value === "string" && (CHECK_RESULTS as readonly string[]).includes(value);
}

export interface LedgerChartsProps {
  /** The rows the grid currently shows (after every filter). */
  rows: readonly OpsRow[];
  /** All verification checks of the snapshot; narrowed to `rows` here. */
  checks: readonly OpsCheckRow[];
  cross: CrossFilter;
  onSeller: (seller: string) => void;
  onOutcome: (outcome: OpsOutcome) => void;
  onCheck: (check: CheckFilter) => void;
  onDay: (day: string) => void;
}

interface LegendEntry {
  label: string;
  color: string;
}

function Swatches({ entries }: { entries: readonly LegendEntry[] }) {
  return (
    <ul className="flex min-w-0 items-center gap-x-3">
      {entries.map((entry) => (
        <li key={entry.label} className="flex items-center gap-1.5 whitespace-nowrap">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: entry.color }} />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}

function ChartTile({
  testId,
  title,
  legend,
  summary,
  active,
  empty,
  children,
}: {
  testId: string;
  title: string;
  /** Series swatches under the title; omitted where the body brings its own legend. */
  legend?: readonly LegendEntry[];
  /** The chart's content as a sentence, for screen readers. */
  summary: string;
  /** This chart is the source of an active cross-filter. */
  active: boolean;
  /** Shown instead of the chart when there is nothing to draw. */
  empty: string | null;
  children: React.ReactNode;
}) {
  return (
    <figure
      data-testid={testId}
      data-active={active ? "" : undefined}
      className={cn(
        "flex min-w-0 flex-col rounded-control border bg-surface transition-colors duration-150",
        active ? "border-accent/50" : "border-hairline",
      )}
    >
      <figcaption className="px-3.5 pt-2.5">
        <h3 className="truncate text-[13px] leading-5 font-semibold text-fg">{title}</h3>
        <div className="flex h-[1.125rem] items-center justify-between gap-3 text-xs text-muted">
          {legend ? <Swatches entries={legend} /> : <span />}
          {empty === null ? <span className="shrink-0 text-faint">Click to filter</span> : null}
        </div>
      </figcaption>
      <p className="sr-only">{summary}</p>
      {empty === null ? (
        <div style={{ height: CHART_HEIGHT }} className="px-1 pb-1">
          {children}
        </div>
      ) : (
        <div style={{ height: CHART_HEIGHT }} className="flex items-center justify-center px-6 pb-3 text-center text-[13px] leading-5 text-muted">
          {empty}
        </div>
      )}
    </figure>
  );
}

function Chart({ options }: { options: AgChartOptions }) {
  return <AgCharts options={options} modules={CHART_MODULES} style={{ width: "100%", height: "100%" }} />;
}

export function LedgerCharts({ rows, checks, cross, onSeller, onOutcome, onCheck, onDay }: LedgerChartsProps) {
  const { theme } = useTheme();
  const palette = useMemo(() => readPalette(theme), [theme]);

  const sellers = useMemo(() => sellerVolume(rows), [rows]);
  const outcomes = useMemo(() => outcomeBreakdown(rows), [rows]);
  const ruleKinds = useMemo(() => checksByRuleKind(checks, new Set(rows.map((row) => row.id))), [checks, rows]);
  const days = useMemo(() => volumeByDay(rows), [rows]);

  const sellerOptions = useMemo<AgCartesianChartOptions>(() => {
    const series = (yKey: "authorizedMinor" | "capturedMinor", yName: string, color: string) => ({
      type: "bar" as const,
      direction: "horizontal" as const,
      xKey: "seller",
      yKey,
      yName,
      fill: color,
      stroke: color,
      cornerRadius: 3,
      tooltip: {
        renderer: ({ datum }: { datum: SellerVolumeDatum }) => ({
          heading: datum.seller,
          data: [
            { label: "Authorized", value: formatMoney(datum.authorizedMinor) },
            { label: "Captured", value: formatMoney(datum.capturedMinor) },
            { label: "Deals", value: String(datum.deals) },
          ],
        }),
      },
      listeners: {
        seriesNodeClick: (event: AgNodeClickEvent<"seriesNodeClick", SellerVolumeDatum>) => onSeller(event.datum.seller),
      },
    });
    return {
      ...baseOptions(palette),
      data: sellers,
      series: [series("authorizedMinor", "Authorized", palette.hold), series("capturedMinor", "Captured", palette.success)],
      axes: {
        x: {
          type: "category",
          position: "left",
          maxThicknessRatio: NAME_AXIS_MAX_RATIO,
          label: { color: palette.fg, fontSize: 12, wrapping: "on-space" },
          line: { enabled: false },
          paddingInner: 0.34,
        },
        y: {
          type: "number",
          position: "bottom",
          nice: true,
          label: { color: palette.muted, fontSize: 11, formatter: ({ value }) => formatMoneyCompact(Number(value)) },
        },
      },
    };
  }, [palette, sellers, onSeller]);

  const outcomeOptions = useMemo<AgPolarChartOptions>(() => {
    const total = outcomes.reduce((sum, datum) => sum + datum.count, 0);
    return {
      ...baseOptions(palette),
      padding: { top: 4, right: 4, bottom: 4, left: 4 },
      data: outcomes,
      series: [
        {
          type: "donut",
          angleKey: "count",
          legendItemKey: "label",
          innerRadiusRatio: 0.68,
          sectorSpacing: 2,
          fills: outcomes.map((datum) => palette[OUTCOME_COLOR[datum.outcome]]),
          strokeWidth: 0,
          innerLabels: [
            { text: String(total), fontSize: 22, fontWeight: 600, color: palette.fg },
            { text: total === 1 ? "deal" : "deals", fontSize: 11, color: palette.muted, spacing: 2 },
          ],
          tooltip: {
            renderer: ({ datum }: { datum: OutcomeDatum }) => ({
              heading: datum.label,
              data: [{ label: "Deals", value: `${datum.count} of ${total}` }],
            }),
          },
          listeners: {
            seriesNodeClick: (event: AgNodeClickEvent<"seriesNodeClick", OutcomeDatum>) => onOutcome(event.datum.outcome),
          },
        },
      ],
    };
  }, [palette, outcomes, onOutcome]);

  const ruleOptions = useMemo<AgCartesianChartOptions>(() => {
    return {
      ...baseOptions(palette),
      data: ruleKinds,
      series: CHECK_RESULTS.map((result) => ({
        type: "bar" as const,
        direction: "horizontal" as const,
        stacked: true,
        xKey: "label",
        yKey: result,
        yName: RESULT_NAME[result],
        fill: palette[RESULT_COLOR[result]],
        stroke: palette[RESULT_COLOR[result]],
        tooltip: {
          renderer: ({ datum }: { datum: RuleKindDatum }) => ({
            heading: datum.label,
            data: CHECK_RESULTS.map((each) => ({ label: RESULT_NAME[each], value: String(datum[each]) })),
          }),
        },
        listeners: {
          seriesNodeClick: (event: AgNodeClickEvent<"seriesNodeClick", RuleKindDatum>) => {
            if (isCheckResult(event.yKey)) onCheck({ kind: event.datum.kind, result: event.yKey });
          },
        },
      })),
      axes: {
        x: {
          type: "category",
          position: "left",
          maxThicknessRatio: NAME_AXIS_MAX_RATIO,
          // Up to eight rule kinds share the height: every one keeps its label, at a size that fits its band.
          label: { color: palette.fg, fontSize: 11, truncate: true, avoidCollisions: false },
          line: { enabled: false },
          paddingInner: 0.4,
        },
        y: {
          type: "number",
          position: "bottom",
          nice: true,
          interval: { minSpacing: 40 },
          label: { color: palette.muted, fontSize: 11, formatter: ({ value }) => (Number.isInteger(value) ? String(value) : "") },
        },
      },
    };
  }, [palette, ruleKinds, onCheck]);

  const dayOptions = useMemo<AgCartesianChartOptions>(() => {
    const series = (yKey: "authorizedMinor" | "capturedMinor", yName: string, color: string) => ({
      type: "bar" as const,
      xKey: "label",
      yKey,
      yName,
      fill: color,
      stroke: color,
      cornerRadius: 3,
      tooltip: {
        renderer: ({ datum }: { datum: DayVolumeDatum }) => ({
          heading: `${datum.label} (UTC)`,
          data: [
            { label: "Authorized", value: formatMoney(datum.authorizedMinor) },
            { label: "Captured", value: formatMoney(datum.capturedMinor) },
            { label: "Deals created", value: String(datum.deals) },
          ],
        }),
      },
      listeners: {
        seriesNodeClick: (event: AgNodeClickEvent<"seriesNodeClick", DayVolumeDatum>) => onDay(event.datum.day),
      },
    });
    return {
      ...baseOptions(palette),
      data: days,
      series: [series("authorizedMinor", "Authorized", palette.hold), series("capturedMinor", "Captured", palette.success)],
      axes: {
        x: { type: "category", position: "bottom", label: { color: palette.fg, fontSize: 12 }, paddingInner: 0.5, paddingOuter: 0.3 },
        y: {
          type: "number",
          position: "left",
          nice: true,
          label: { color: palette.muted, fontSize: 11, formatter: ({ value }) => formatMoneyCompact(Number(value)) },
        },
      },
    };
  }, [palette, days, onDay]);

  const noRows = rows.length === 0;
  const volumeLegend: LegendEntry[] = [
    { label: "Authorized", color: palette.hold },
    { label: "Captured", color: palette.success },
  ];
  return (
    <div data-testid="ledger-charts" className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <ChartTile
        testId="chart-seller-volume"
        title="Authorized vs captured by seller"
        legend={volumeLegend}
        active={cross.seller !== null}
        empty={sellers.length === 0 ? (noRows ? "No deals in this view." : "No payment has been authorized in this view yet.") : null}
        summary={sellers
          .map((datum) => `${datum.seller}: ${formatMoney(datum.authorizedMinor)} authorized, ${formatMoney(datum.capturedMinor)} captured`)
          .join("; ")}
      >
        <Chart options={sellerOptions} />
      </ChartTile>

      <ChartTile
        testId="chart-outcomes"
        title="Deals by outcome"
        active={cross.outcome !== null}
        empty={outcomes.length === 0 ? "No deals in this view." : null}
        summary={outcomes.map((datum) => `${datum.label}: ${dealCountLabel(datum.count)}`).join("; ")}
      >
        <div className="flex h-full items-center gap-1">
          <div className="h-full w-[46%] shrink-0">
            <Chart options={outcomeOptions} />
          </div>
          {/* The legend doubles as the keyboard and screen-reader way to apply the same filter as a slice. */}
          <ul className="flex min-w-0 flex-1 flex-col gap-0.5 pr-2.5">
            {outcomes.map((datum) => (
              <li key={datum.outcome}>
                <button
                  type="button"
                  aria-pressed={cross.outcome === datum.outcome}
                  data-testid={`chart-outcome-${datum.outcome}`}
                  onClick={() => onOutcome(datum.outcome)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors duration-150 focus-ring hover:bg-subtle",
                    cross.outcome === datum.outcome ? "bg-accent-soft text-accent" : "text-fg",
                  )}
                >
                  <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: palette[OUTCOME_COLOR[datum.outcome]] }} />
                  <span className="min-w-0 flex-1 truncate">{datum.label}</span>
                  <span className="font-mono text-muted tabular-nums">{datum.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </ChartTile>

      <ChartTile
        testId="chart-rule-kinds"
        title="Verification results by rule"
        legend={CHECK_RESULTS.map((result) => ({ label: RESULT_NAME[result], color: palette[RESULT_COLOR[result]] }))}
        active={cross.check !== null}
        empty={ruleKinds.length === 0 ? (noRows ? "No deals in this view." : "No delivery in this view has been verified yet.") : null}
        summary={ruleKinds
          .map((datum) => `${datum.label}: ${datum.pass} passed, ${datum.fail} failed, ${datum.uncertain} uncertain`)
          .join("; ")}
      >
        <Chart options={ruleOptions} />
      </ChartTile>

      <ChartTile
        testId="chart-day-volume"
        title="Volume by day"
        legend={volumeLegend}
        active={cross.day !== null}
        empty={days.length === 0 ? "No deals in this view." : null}
        summary={days
          .map((datum) => `${datum.label}: ${formatMoney(datum.authorizedMinor)} authorized, ${formatMoney(datum.capturedMinor)} captured`)
          .join("; ")}
      >
        <Chart options={dayOptions} />
      </ChartTile>
    </div>
  );
}
