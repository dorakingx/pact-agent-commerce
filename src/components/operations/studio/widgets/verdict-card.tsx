"use client";

import type { AgWidgetParams } from "ag-studio";
import { ArrowUpRight, CircleCheck, CircleHelp, CircleX, ScanSearch } from "lucide-react";
import { useMemo } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import { ConfidenceBar } from "@/components/ui/confidence-bar";
import { RelativeTime } from "@/components/ui/relative-time";
import { StatusPill } from "@/components/ui/status-pill";
import { TONE_CLASSES, type StatusTone } from "@/components/ui/tone";
import type { DealResponse } from "@/lib/api/dto";
import { fetcher } from "@/lib/client/api";
import { buildVerdict, withEvidence, type VerdictCheck } from "@/lib/client/studio-verdict";
import { WIDGET_DEFAULTS, type VerdictCardWidget } from "@/lib/client/studio-widgets";
import type { CheckResult } from "@/lib/domain/schemas";
import type { PactStudioContext } from "../context";
import { mapped, planQuery, useWidgetRows, valueOf, type WidgetQueryPlan } from "./use-widget-rows";
import { WidgetMessage } from "./widget-message";

type Params = AgWidgetParams<VerdictCardWidget, unknown, PactStudioContext>;

const RESULT: Record<CheckResult, { tone: StatusTone; label: string; icon: React.ReactNode }> = {
  pass: { tone: "success", label: "Pass", icon: <CircleCheck aria-hidden="true" /> },
  fail: { tone: "danger", label: "Fail", icon: <CircleX aria-hidden="true" /> },
  uncertain: { tone: "review", label: "Uncertain", icon: <CircleHelp aria-hidden="true" /> },
};

function verdictPlan(params: Params): WidgetQueryPlan {
  const { deal, condition, result, round, rule, evaluator, confidence, at } = params.dataMapping;
  return planQuery(
    [mapped(deal), mapped(condition), mapped(result)],
    [mapped(round), mapped(rule), mapped(evaluator), mapped(confidence), mapped(at)],
  );
}

/**
 * One verified delivery, condition by condition: result, evaluator, confidence against the
 * auto-capture threshold, and what the verifier observed. It shows the pinned deal, or else the
 * most recently verified one under the page's filters — so focusing a deal anywhere on the page
 * brings its verdict up here.
 */
export function VerdictCard(params: Params) {
  const { rows, error } = useWidgetRows(params, verdictPlan);
  const { dataMapping, format, context } = params;
  const pinned = format?.style?.dealCode ?? WIDGET_DEFAULTS.verdict.dealCode;
  const threshold = (format?.style?.thresholdPercent ?? WIDGET_DEFAULTS.verdict.thresholdPercent) / 100;
  const showEvidence = format?.style?.showEvidence ?? WIDGET_DEFAULTS.verdict.showEvidence;

  const base = useMemo(
    () =>
      buildVerdict(
        (rows ?? []).map((row) => ({
          deal: valueOf(row, mapped(dataMapping.deal)),
          condition: valueOf(row, mapped(dataMapping.condition)),
          result: valueOf(row, mapped(dataMapping.result)),
          round: valueOf(row, mapped(dataMapping.round)),
          rule: valueOf(row, mapped(dataMapping.rule)),
          evaluator: valueOf(row, mapped(dataMapping.evaluator)),
          confidence: valueOf(row, mapped(dataMapping.confidence)),
          at: valueOf(row, mapped(dataMapping.at)),
        })),
        pinned,
      ),
    [rows, dataMapping, pinned],
  );

  const row = base === null ? null : context.dealByCode(base.dealCode);
  const { data, error: evidenceError } = useSWR<DealResponse>(showEvidence && row !== null ? `/api/deals/${row.id}` : null, fetcher, {
    revalidateOnFocus: false,
    // The card is complete without this: one attempt, no retry storm if the deal cannot be read.
    shouldRetryOnError: false,
    dedupingInterval: 30_000,
  });
  const model = useMemo(() => (base === null || !data ? base : withEvidence(base, data.deal.reports)), [base, data]);

  if (error !== null) return <WidgetMessage tone="danger" title="The verdict could not load" detail={error} />;
  if (rows === null) return null;
  if (model === null) {
    return (
      <WidgetMessage
        icon={<ScanSearch />}
        title="No delivery has been verified yet"
        detail="Once a seller agent delivers, every contract condition is checked here with its evidence. Nothing is captured before that."
      />
    );
  }

  const tone = TONE_CLASSES[model.tone];
  return (
    <div data-testid="verdict-card" data-deal-code={model.dealCode} className="flex h-full min-h-0 flex-col font-sans text-fg">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2 text-xs leading-[18px] text-muted">
        <span className="font-mono text-[13px] font-semibold tracking-tight text-fg">{model.dealCode}</span>
        {row === null ? null : <span className="text-fg">{row.seller}</span>}
        <Badge tone="neutral" variant="outline">
          {model.round === 1 ? "First delivery" : `Revision ${model.round - 1}`}
        </Badge>
        {model.verifiedAtMs === null ? null : (
          <span>
            verified <RelativeTime value={model.verifiedAtMs} />
          </span>
        )}
        {row === null ? null : (
          <button
            type="button"
            data-testid="verdict-open"
            onClick={() => context.openDeal(row.id)}
            className="ml-auto inline-flex items-center gap-1 rounded-control px-1 font-medium text-accent focus-ring hover:underline"
          >
            Open deal
            <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </button>
        )}
      </div>

      <div className={cn("mx-3 mb-2 rounded-control border px-3 py-2", tone.soft, tone.line)} aria-live="polite">
        <p className={cn("text-[13px] leading-5 font-semibold", tone.text)}>{model.headline}</p>
        {/* When everything passed the verifier's summary only repeats the headline; otherwise it says what went wrong. */}
        {model.summary === null || model.tone === "success" ? null : <p className="text-xs leading-[18px] text-fg">{model.summary}</p>}
        <p className="text-xs leading-[18px] text-muted">{model.consequence}</p>
        {model.degraded ? (
          <p className="mt-1 text-xs leading-[18px] text-muted">The AI verifier was unavailable: its conditions were marked uncertain, never passed.</p>
        ) : null}
      </div>

      <ul aria-label={`Conditions checked for ${model.dealCode}`} className="min-h-0 flex-1 divide-y divide-hairline overflow-auto px-3 pb-2">
        {model.checks.map((check, index) => (
          <CheckRow key={`${check.rule ?? "rule"}-${index}`} check={check} threshold={threshold} />
        ))}
      </ul>
      {showEvidence && evidenceError && !data ? (
        <p className="border-t border-hairline px-3 py-2 text-xs text-muted">Evidence is unavailable right now; the results above are complete.</p>
      ) : null}
    </div>
  );
}

function CheckRow({ check, threshold }: { check: VerdictCheck; threshold: number }) {
  const result = RESULT[check.result];
  return (
    <li data-testid="verdict-check" data-result={check.result} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-1 py-2">
      <StatusPill tone={result.tone} size="sm" icon={result.icon} className="mt-px w-[92px] justify-start">
        {result.label}
      </StatusPill>
      <div className="min-w-0">
        <p className="text-[13px] leading-5 text-fg">
          {check.rule === null ? null : <span className="mr-1.5 font-mono text-xs text-faint">{check.rule}</span>}
          {check.condition}
        </p>
        {check.evidence === null ? null : <p className="text-xs leading-[18px] text-muted">{check.evidence}</p>}
        <div className="mt-1 flex items-center gap-2.5">
          {check.evaluator === null ? null : (
            <Badge tone={check.evaluator === "ai" ? "info" : "neutral"} variant="outline">
              {check.evaluator === "ai" ? "AI" : "Deterministic"}
            </Badge>
          )}
          {check.confidence === null ? null : (
            <ConfidenceBar
              value={check.confidence}
              // Plain code is certain by construction: the threshold is a question for model judgements only.
              threshold={check.evaluator === "deterministic" ? undefined : threshold}
              tone={check.result === "pass" ? undefined : result.tone}
              label={`Confidence for: ${check.condition}`}
              className="max-w-56 flex-1"
            />
          )}
        </div>
      </div>
    </li>
  );
}
