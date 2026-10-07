"use client";

import type { AgWidgetParams } from "ag-studio";
import { ArrowRightLeft, BadgeCheck, FileCheck2, LockKeyhole, PackageCheck, ScanSearch, Undo2 } from "lucide-react";
import { useMemo } from "react";
import { cn } from "@/components/ui/cn";
import { buildRailModel, describeRail, formatUsd, type RailExit, type RailStation, type RailStationKey } from "@/lib/client/studio-rail";
import { stageKeyOf } from "@/lib/client/studio-data";
import { WIDGET_DEFAULTS, type SettlementRailWidget } from "@/lib/client/studio-widgets";
import type { PactStudioContext } from "../context";
import { mapped, planQuery, useWidgetRows, valueOf, type WidgetQueryPlan } from "./use-widget-rows";
import { WidgetMessage } from "./widget-message";

type Params = AgWidgetParams<SettlementRailWidget, unknown, PactStudioContext>;

const STATION_ICON: Record<RailStationKey, React.ReactNode> = {
  negotiation: <ArrowRightLeft />,
  contract: <FileCheck2 />,
  payment: <LockKeyhole />,
  fulfillment: <PackageCheck />,
  verification: <ScanSearch />,
};

function railPlan(params: Params): WidgetQueryPlan {
  const { stage, deals, held, captured, released } = params.dataMapping;
  return planQuery([mapped(stage), mapped(deals)], [mapped(held), mapped(captured), mapped(released)]);
}

/**
 * The PACT state machine as a rail: five stations a deal can be standing at, then the two ways
 * out. Each station shows how many deals are there and the dollars held there; amber marks the
 * stations where an authorization is being held. A station is a button: pressing it cross-filters
 * the page to that stage through Studio, and every Studio filter narrows the rail in turn.
 */
export function SettlementRail(params: Params) {
  const { rows, error } = useWidgetRows(params, railPlan);
  const { widgetApi, dataMapping, format } = params;
  const stageField = mapped(dataMapping.stage);
  const showAmounts = format?.style?.showAmounts ?? WIDGET_DEFAULTS.rail.showAmounts;
  const showExits = format?.style?.showExits ?? WIDGET_DEFAULTS.rail.showExits;

  const model = useMemo(
    () =>
      buildRailModel(
        (rows ?? []).map((row) => ({
          stage: valueOf(row, mapped(dataMapping.stage)),
          deals: valueOf(row, mapped(dataMapping.deals)),
          held: valueOf(row, mapped(dataMapping.held)),
          captured: valueOf(row, mapped(dataMapping.captured)),
          released: valueOf(row, mapped(dataMapping.released)),
        })),
      ),
    [rows, dataMapping],
  );

  // The value Studio knows each stage by, so a cross filter is set with exactly what the data holds.
  const rawByStage = useMemo(() => {
    const raw = new Map<string, unknown>();
    for (const row of rows ?? []) {
      const value = valueOf(row, stageField);
      const key = stageKeyOf(value);
      if (key !== null) raw.set(key, value);
    }
    return raw;
  }, [rows, stageField]);

  const selected = new Set(
    (widgetApi.getCrossFilterSelections() ?? [])
      .flatMap((selection) => (selection.type === "value" ? selection.values : []))
      .map((value) => stageKeyOf(value))
      .filter((key) => key !== null),
  );

  function toggle(stage: string): void {
    if (stageField === undefined || !rawByStage.has(stage)) return;
    widgetApi.toggleCrossFilter({ type: "value", field: stageField, value: rawByStage.get(stage), group: 0 });
  }

  if (error !== null) return <WidgetMessage tone="danger" title="The rail could not load" detail={error} />;
  if (rows === null) return null;

  const anySelected = selected.size > 0;
  return (
    <div data-testid="settlement-rail" className="@container flex h-full min-h-0 flex-col overflow-auto px-3 pt-1 pb-3 font-sans text-fg">
      <p className="sr-only" aria-live="polite">
        {describeRail(model)}
      </p>
      <div className="flex min-h-0 flex-1 flex-col gap-3 @2xl:flex-row @2xl:gap-6">
        <ol aria-label="Deals by stage" className="@container/stations grid flex-1 grid-cols-2 gap-y-3 @md:grid-cols-5">
          {model.stations.map((station, index) => (
            <Station
              key={station.key}
              station={station}
              icon={STATION_ICON[station.key]}
              // The last station's line runs on into the "Captured" exit: the path a verified delivery takes.
              line={index < model.stations.length - 1 ? "next" : showExits ? "exit" : "none"}
              showAmounts={showAmounts}
              pressed={selected.has(station.key)}
              dimmed={anySelected && !selected.has(station.key)}
              onToggle={rawByStage.has(station.key) ? () => toggle(station.key) : undefined}
            />
          ))}
        </ol>
        {showExits ? (
          <ul aria-label="How deals ended" className="flex shrink-0 flex-row gap-2 @2xl:w-56 @2xl:flex-col @4xl:w-60">
            <Exit
              exit={model.settled}
              tone="success"
              icon={<BadgeCheck />}
              amountLabel="captured"
              pressed={selected.has("settled")}
              dimmed={anySelected && !selected.has("settled")}
              onToggle={rawByStage.has("settled") ? () => toggle("settled") : undefined}
            />
            <Exit
              exit={model.closed}
              tone="neutral"
              icon={<Undo2 />}
              amountLabel="released"
              pressed={selected.has("closed")}
              dimmed={anySelected && !selected.has("closed")}
              onToggle={rawByStage.has("closed") ? () => toggle("closed") : undefined}
            />
          </ul>
        ) : null}
      </div>
      {model.unrecognised > 0 ? (
        <p className="mt-2 text-xs text-muted">
          {model.unrecognised} {model.unrecognised === 1 ? "deal is" : "deals are"} in a stage the rail does not know. Map the Stage field to
          place them.
        </p>
      ) : null}
    </div>
  );
}

/*
 * Geometry shared by the stations and the exits. A node is 38px and sits 6px below the top of
 * its station, which puts the rail line at 25px — the vertical centre of the first exit card
 * (50px tall), so the line from "Verification" meets "Captured" head-on.
 */
const LINE_TOP = "top-[25px]";

interface StationProps {
  station: RailStation;
  icon: React.ReactNode;
  /** Where this station's line leads: the next station, the exits, or nowhere. */
  line: "next" | "exit" | "none";
  showAmounts: boolean;
  pressed: boolean;
  dimmed: boolean;
  onToggle: (() => void) | undefined;
}

function Station({ station, icon, line, showAmounts, pressed, dimmed, onToggle }: StationProps) {
  const holding = station.heldUsd > 0;
  const occupied = station.deals > 0;
  return (
    <li className="relative min-w-0">
      {/* The rail itself: a line from this node to the next one. Amber while it carries held funds. */}
      {line === "none" ? null : (
        <span
          aria-hidden="true"
          className={cn(
            "absolute left-[calc(50%+23px)] hidden h-px",
            LINE_TOP,
            // To the next node while the stations sit in one row; across the gap once the exits sit beside them.
            line === "next" ? "right-[calc(-50%+23px)] @md:block" : "right-[-24px] @2xl:block",
            line === "exit" ? "bg-accent" : holding ? "bg-hold/60" : "bg-hairline-strong",
          )}
        />
      )}
      <button
        type="button"
        data-testid={`rail-station-${station.key}`}
        data-deals={station.deals}
        aria-pressed={pressed}
        disabled={onToggle === undefined}
        onClick={onToggle}
        title={onToggle === undefined ? undefined : pressed ? "Clear the stage filter" : `Filter the page to ${station.label.toLowerCase()}`}
        className={cn(
          "group flex w-full flex-col items-center gap-1 rounded-control px-1 pt-1.5 pb-1.5 text-center transition-opacity focus-ring",
          onToggle === undefined ? "cursor-default" : "hover:bg-subtle",
          pressed && "bg-accent-soft",
          dimmed && "opacity-55",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "relative z-10 flex size-[38px] shrink-0 items-center justify-center rounded-full border [&_svg]:size-4",
            holding
              ? "border-hold/40 bg-hold-soft text-hold"
              : occupied
                ? "border-info/30 bg-info-soft text-info"
                : "border-hairline-strong bg-surface text-faint",
          )}
        >
          {icon}
        </span>
        {/* Count beside the label where a station has the width for it, above it where it does not. */}
        <span className="mt-0.5 flex flex-col items-center @xl/stations:flex-row @xl/stations:items-baseline @xl/stations:gap-1.5">
          <span className={cn("font-mono text-xl leading-6 font-semibold tabular-nums", occupied ? "text-fg" : "text-faint")}>{station.deals}</span>
          <span className="text-[13px] leading-5 font-semibold text-fg">{station.label}</span>
        </span>
        {/* Captions need about 150px a station to stay on one line; narrower rails do without them. */}
        <span className="hidden text-xs leading-4 whitespace-nowrap text-muted @3xl/stations:block">{station.caption}</span>
        {showAmounts ? (
          <span
            className={cn(
              "mt-0.5 inline-flex h-[22px] items-center rounded-full border px-2 font-mono text-xs whitespace-nowrap tabular-nums",
              holding ? "border-hold/30 bg-hold-soft text-hold" : "border-transparent text-faint",
            )}
          >
            {holding ? formatUsd(station.heldUsd) : <span className="@xl/stations:hidden">—</span>}
            <span className="hidden @xl/stations:inline">{holding ? "\u00a0held" : "nothing held"}</span>
            {/* The short form above drops the word; this keeps it for screen readers. */}
            <span className="sr-only @xl/stations:hidden">{holding ? " held" : "nothing held"}</span>
          </span>
        ) : null}
      </button>
    </li>
  );
}

interface ExitProps {
  exit: RailExit;
  tone: "success" | "neutral";
  icon: React.ReactNode;
  amountLabel: string;
  pressed: boolean;
  dimmed: boolean;
  onToggle: (() => void) | undefined;
}

function Exit({ exit, tone, icon, amountLabel, pressed, dimmed, onToggle }: ExitProps) {
  return (
    <li className="relative min-w-0 flex-1 @2xl:flex-none">
      {/* The other way out: a branch that drops from the rail into "No capture". */}
      {tone === "neutral" ? (
        <span
          aria-hidden="true"
          className="absolute bottom-1/2 left-[-13px] hidden h-[58px] w-[13px] rounded-bl-md border-b border-l border-dashed border-hairline-strong @2xl:block"
        />
      ) : null}
      <button
        type="button"
        data-testid={`rail-exit-${exit.key}`}
        data-deals={exit.deals}
        aria-pressed={pressed}
        disabled={onToggle === undefined}
        onClick={onToggle}
        title={onToggle === undefined ? undefined : pressed ? "Clear the stage filter" : `Filter the page to ${exit.label.toLowerCase()}`}
        className={cn(
          "relative flex h-[50px] w-full items-center gap-2.5 rounded-control border px-2.5 text-left transition-opacity focus-ring",
          tone === "success" ? "border-success/25 bg-success-soft/50" : "border-hairline bg-subtle/60",
          onToggle === undefined ? "cursor-default" : "hover:border-hairline-strong",
          pressed && "ring-2 ring-accent",
          dimmed && "opacity-55",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full [&_svg]:size-4",
            tone === "success" ? "bg-accent text-on-accent" : "border border-hairline-strong bg-surface text-neutral",
          )}
        >
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-1.5">
            <span className="font-mono text-base leading-5 font-semibold text-fg tabular-nums">{exit.deals}</span>
            <span className="truncate text-[13px] leading-5 font-semibold text-fg">{exit.label}</span>
          </span>
          <span className="truncate text-xs leading-4 text-muted">
            <span className={cn("font-mono tabular-nums", tone === "success" ? "text-success" : "text-neutral")}>{formatUsd(exit.amountUsd)}</span>{" "}
            {amountLabel}
          </span>
        </span>
      </button>
    </li>
  );
}
