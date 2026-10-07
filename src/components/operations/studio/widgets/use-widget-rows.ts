import type { AgWidgetApi, AgWidgetField } from "ag-studio";
import { useEffect, useRef, useState } from "react";

export type WidgetRow = Record<string, unknown>;

export interface WidgetRowsState {
  /** Null until the first query has answered. */
  rows: WidgetRow[] | null;
  /** Set when the query failed; the widget shows it instead of stale or empty content. */
  error: string | null;
}

/** What a widget asks Studio for, derived from the slots its author mapped. */
export interface WidgetQueryPlan {
  /** Fields to query. Unaggregated ones group the result. */
  fields: AgWidgetField[];
  /** False when a slot the widget cannot draw without is unmapped. */
  complete: boolean;
}

/** The first field mapped to a slot, if the author mapped one. */
export function mapped(fields: readonly AgWidgetField[] | undefined): AgWidgetField | undefined {
  return fields?.[0];
}

/** A row's value for a mapped slot. Studio keys result rows by each field's `key`. */
export function valueOf(row: WidgetRow, field: AgWidgetField | undefined): unknown {
  return field === undefined ? undefined : row[field.key];
}

/** Build a plan from optional slots: `required` ones must all be mapped. */
export function planQuery(required: readonly (AgWidgetField | undefined)[], optional: readonly (AgWidgetField | undefined)[]): WidgetQueryPlan {
  const present = (field: AgWidgetField | undefined): field is AgWidgetField => field !== undefined;
  return { fields: [...required, ...optional].filter(present), complete: required.every(present) };
}

/**
 * Run a custom widget's query through Studio and keep the widget's overlay in step with it.
 *
 * Studio re-renders a custom widget with a fresh props object whenever something it depends on
 * changed: its mapping, its format, a page or cross filter, or the data itself. That object is
 * therefore the one dependency worth having — it is what "ask again" looks like from inside a
 * widget — while a re-render caused by the widget's own state keeps the same object and does not
 * query again. `plan` must be a stable (module-level) function for the same reason.
 *
 * When a required slot is unmapped Studio shows its own "choose a field" overlay. After the
 * first answer, refreshes use the unobtrusive loading state, so a 15-second data poll never
 * blanks the widget.
 */
export function useWidgetRows<TParams extends { widgetApi: AgWidgetApi }>(
  params: TParams,
  plan: (params: TParams) => WidgetQueryPlan,
): WidgetRowsState {
  const [state, setState] = useState<WidgetRowsState>({ rows: null, error: null });
  const answered = useRef(false);

  useEffect(() => {
    const { widgetApi } = params;
    const { fields, complete } = plan(params);
    if (!complete || fields.length === 0) {
      widgetApi.setDisplayState("incompleteDataMapping");
      return;
    }
    const controller = new AbortController();
    widgetApi.setDisplayState("loading", { prominent: !answered.current });
    widgetApi
      .getData({ fields }, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        answered.current = true;
        setState({ rows: response.results.rows, error: null });
        // The widget draws its own empty state: "nobody is waiting" is an answer, not missing data.
        widgetApi.setDisplayState("displayed");
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        answered.current = true;
        setState({ rows: null, error: cause instanceof Error ? cause.message : "The query failed." });
        widgetApi.setDisplayState("displayed");
      });
    return () => controller.abort();
  }, [params, plan]);

  return state;
}
