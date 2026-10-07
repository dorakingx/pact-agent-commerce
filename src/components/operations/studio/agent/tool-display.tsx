"use client";

/**
 * How the PACT auditor's tool calls appear in Studio's chat panel.
 *
 * Studio draws each call as a step: a status marker, a few words and an optional pill. This
 * file supplies the words for PACT's tools and, for the calls worth opening, a detail component:
 * the reconciliation as a field-by-field table, an explained deal as its facts, a list as rows.
 *
 * A detail component can be rendered from a conversation replayed long after the call ran, so
 * nothing here trusts the shape of `result.data`: each component checks what it was handed and
 * falls back to the tool's own sentence.
 */
import type { AgAiToolDetailParams, AgAiToolLabelParams } from "ag-studio";
import type { AgAiToolDisplay } from "ag-studio-react";
import { Check, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import { TOOL, type AttentionResult, type DealBrief, type DealExplanation, type ReconciliationSummary } from "@/lib/client/studio-agent";

/** What a deal with no contract or no hold reports as its amount: shown as nothing rather than "$0.00". */
const ZERO = "$0.00";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dataOf(params: AgAiToolDetailParams | AgAiToolLabelParams): unknown {
  return params.result?.success ? params.result.data : undefined;
}

function codeOf(args: Partial<Record<string, unknown>>): string | null {
  return typeof args.code === "string" && args.code.trim().length > 0 ? args.code.trim().toUpperCase() : null;
}

function isReconciliation(value: unknown): value is ReconciliationSummary {
  return isRecord(value) && typeof value.status === "string" && Array.isArray(value.facts) && typeof value.verdict === "string";
}

function isExplanation(value: unknown): value is DealExplanation {
  return isRecord(value) && typeof value.code === "string" && typeof value.why === "string" && typeof value.status === "string";
}

function isAttention(value: unknown): value is AttentionResult {
  return isRecord(value) && Array.isArray(value.items) && typeof value.total === "number";
}

function isDealList(value: unknown): value is { total: number; deals: DealBrief[] } {
  return isRecord(value) && Array.isArray(value.deals) && typeof value.total === "number";
}

/* -------------------------------------------------------------------------- */
/*  Detail components                                                          */
/* -------------------------------------------------------------------------- */

const shell = "rounded-control border border-hairline bg-surface font-sans text-xs leading-[18px] text-fg";

function Fallback({ params }: { params: AgAiToolDetailParams }) {
  const text = params.result?.success ? params.result.response : null;
  return text ? <p className={cn(shell, "px-2.5 py-2 text-muted")}>{text}</p> : null;
}

/** PACT's ledger against PayPal's record, one row per compared field. */
function ReconciliationDetail(params: AgAiToolDetailParams) {
  const data = dataOf(params);
  if (!isReconciliation(data)) return <Fallback params={params} />;
  const tone = data.status === "match" ? "success" : data.status === "mismatch" ? "danger" : "neutral";
  return (
    <div data-testid="agent-reconciliation" data-status={data.status} className={cn(shell, "overflow-hidden")}>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-hairline px-2.5 py-2">
        <Badge tone={tone}>{data.status === "match" ? "Match" : data.status === "mismatch" ? "Mismatch" : "Unavailable"}</Badge>
        <span className="font-mono font-semibold">{data.code}</span>
        <Badge tone="neutral" variant="outline">
          Read-only
        </Badge>
      </div>
      {data.facts.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">PACT ledger compared with PayPal for {data.code}</caption>
            <thead>
              <tr className="bg-subtle text-muted">
                <th scope="col" className="px-2.5 py-1.5 font-semibold">
                  Field
                </th>
                <th scope="col" className="px-2 py-1.5 font-semibold">
                  PACT
                </th>
                <th scope="col" className="px-2 py-1.5 font-semibold">
                  PayPal
                </th>
                <th scope="col" className="w-8 px-2 py-1.5">
                  <span className="sr-only">Agrees</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.facts.map((fact) => (
                <tr key={fact.field} className="border-t border-hairline align-top">
                  <th scope="row" className="px-2.5 py-1.5 font-medium">
                    {fact.field}
                  </th>
                  <td className="px-2 py-1.5 font-mono [overflow-wrap:anywhere] text-muted">{fact.pact ?? "—"}</td>
                  <td className="px-2 py-1.5 font-mono [overflow-wrap:anywhere] text-muted">{fact.paypal ?? "—"}</td>
                  <td className="px-2 py-1.5">
                    {fact.match ? (
                      <Check aria-label="Agrees" className="size-3.5 text-success" />
                    ) : (
                      <X aria-label="Differs" className="size-3.5 text-danger" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="border-t border-hairline px-2.5 py-2 text-muted">
        {data.source}.{data.note ? ` ${data.note}` : ""}
      </p>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 px-2.5 py-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** The facts behind an explanation: status, the conditions that did not pass, policy flags, PayPal ids. */
function ExplanationDetail(params: AgAiToolDetailParams) {
  const data = dataOf(params);
  if (!isExplanation(data)) return <Fallback params={params} />;
  const { payment, verification, policy } = data;
  return (
    <dl data-testid="agent-explanation" data-deal-code={data.code} className={cn(shell, "divide-y divide-hairline")}>
      <Fact label="Deal">
        <span className="font-mono font-semibold">{data.code}</span> · {data.status}
      </Fact>
      <Fact label="Why">{data.why}</Fact>
      {verification && verification.notPassed.length > 0 ? (
        <Fact label="Not passed">
          <ul className="flex flex-col gap-1">
            {verification.notPassed.map((check) => (
              <li key={check.rule}>
                <Badge tone={check.result === "fail" ? "danger" : "review"}>{check.result === "fail" ? "Fail" : "Uncertain"}</Badge>{" "}
                <span className="font-mono text-faint">{check.rule}</span> {check.condition}
                {check.evidence ? <span className="block text-muted">{check.evidence}</span> : null}
              </li>
            ))}
          </ul>
        </Fact>
      ) : null}
      {policy && policy.flags.length > 0 ? (
        <Fact label="Policy">
          {policy.flags.map((flag) => (
            <span key={flag.check} className="block">
              {flag.detail}
            </span>
          ))}
        </Fact>
      ) : null}
      {payment ? (
        <Fact label="Payment">
          <span className="flex flex-wrap items-center gap-1.5">
            {payment.simulated ? (
              <Badge tone="neutral" variant="outline">
                Simulated
              </Badge>
            ) : (
              <Badge tone="info" variant="outline">
                PayPal Sandbox
              </Badge>
            )}
            {payment.status} · {payment.authorized} authorized · {payment.captured} captured
          </span>
          {[
            ["Order", payment.paypalOrderId],
            ["Authorization", payment.paypalAuthorizationId],
            ["Capture", payment.paypalCaptureId],
          ].map(([label, id]) =>
            id ? (
              <span key={label} className="block font-mono break-all text-muted">
                {label}: {id}
              </span>
            ) : null,
          )}
        </Fact>
      ) : null}
    </dl>
  );
}

function DealRows({ rows }: { rows: { code: string; status: string; detail: string | null; amount: string | null }[] }) {
  return (
    <ul className={cn(shell, "divide-y divide-hairline")}>
      {rows.map((row) => (
        <li key={row.code} className="px-2.5 py-1.5">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono font-semibold">{row.code}</span>
            <span>{row.status}</span>
            {row.amount === null ? null : <span className="ml-auto font-mono text-muted tabular-nums">{row.amount}</span>}
          </span>
          {row.detail === null ? null : <span className="block text-muted">{row.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

function AttentionDetail(params: AgAiToolDetailParams) {
  const data = dataOf(params);
  if (!isAttention(data) || data.items.length === 0) return <Fallback params={params} />;
  return (
    <DealRows
      rows={data.items.map((item) => ({
        code: item.code,
        status: item.status,
        detail: item.reasons.length > 0 ? item.reasons.join(" · ") : null,
        amount: item.held === ZERO ? (item.contractValue === ZERO ? null : item.contractValue) : `${item.held} held`,
      }))}
    />
  );
}

function DealListDetail(params: AgAiToolDetailParams) {
  const data = dataOf(params);
  if (!isDealList(data) || data.deals.length === 0) return <Fallback params={params} />;
  return (
    <DealRows
      rows={data.deals.map((deal) => ({
        code: deal.code,
        status: deal.status,
        detail: `${deal.seller}${deal.failedConditions > 0 ? ` · ${deal.failedConditions} failed` : ""}`,
        amount: deal.contractValue === ZERO ? null : deal.contractValue,
      }))}
    />
  );
}

/* -------------------------------------------------------------------------- */
/*  Labels                                                                     */
/* -------------------------------------------------------------------------- */

const settled = (params: AgAiToolLabelParams): boolean => params.result !== undefined;
const failed = (params: AgAiToolLabelParams): boolean => params.result?.success === false;

/** The `aiToolDisplay` Studio property for PACT's tools, keyed by the name each tool advertises. */
export const PACT_TOOL_DISPLAY: Record<string, AgAiToolDisplay> = {
  [TOOL.attention]: {
    label: (params) => {
      if (failed(params)) return { text: "Could not list what needs attention" };
      const data = dataOf(params);
      return {
        text: settled(params) ? "Listed what needs attention" : "Checking what needs attention",
        pill: isAttention(data) ? `${data.total} ${data.total === 1 ? "deal" : "deals"}` : undefined,
      };
    },
    detail: AttentionDetail,
  },
  [TOOL.find]: {
    label: (params) => {
      if (failed(params)) return { text: "Could not look up deals" };
      const data = dataOf(params);
      return {
        text: settled(params) ? "Looked up deals" : "Looking up deals",
        pill: isDealList(data) ? `${data.total} found` : undefined,
      };
    },
    detail: DealListDetail,
  },
  [TOOL.explain]: {
    label: (params) => {
      const code = codeOf(params.args) ?? "the deal";
      if (failed(params)) return { text: `Could not read ${code}` };
      const data = dataOf(params);
      return { text: settled(params) ? `Read ${code}` : `Reading ${code}`, pill: isExplanation(data) ? data.status : undefined };
    },
    detail: ExplanationDetail,
  },
  [TOOL.reconcile]: {
    label: (params) => {
      const code = codeOf(params.args) ?? "the deal";
      if (failed(params)) return { text: `Could not reconcile ${code} with PayPal` };
      const data = dataOf(params);
      return {
        text: settled(params) ? `Reconciled ${code} with PayPal` : `Reconciling ${code} with PayPal`,
        pill: isReconciliation(data) ? (data.status === "match" ? "Match" : data.status === "mismatch" ? "Mismatch" : "Unavailable") : undefined,
      };
    },
    detail: ReconciliationDetail,
  },
};
