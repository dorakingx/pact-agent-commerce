/**
 * The PACT auditor's tools, defined with AG Studio's tool API.
 *
 * Four tools, all of them reads: two over the snapshot the dashboard already holds, one over
 * GET /api/deals/{id}, one over POST /api/deals/{id}/reconcile (a POST because it costs PayPal
 * calls; it changes no payment and no status). They run in the browser with the visitor's own
 * session, so an agent can see exactly what the visitor can see and nothing else.
 *
 * There is deliberately no tool that captures, voids, approves, declines or decides. That is
 * the whole safety argument: a model cannot be talked into an action it has no way to take.
 */
import type { AgAiTool, AgStudioApi } from "ag-studio";
import type { DealResponse, ReconciliationView } from "@/lib/api/dto";
import { ApiClientError, api as http } from "@/lib/client/api";
import {
  ATTENTION_FOCUS,
  DEAL_FILTER,
  TOOL,
  dealByCode,
  explainDeal,
  findDeals,
  listAttentionItems,
  summarizeReconciliation,
} from "@/lib/client/studio-agent";
import type { PactStudioContext } from "../context";

/** What the model is told when a call to PACT's API fails: the reason, and the id to quote. */
function describeFailure(action: string, cause: unknown): string {
  if (cause instanceof ApiClientError) {
    const reference = cause.requestId === null ? "" : ` (request ${cause.requestId})`;
    if (cause.status === 429) return `${action} is rate limited right now. Tell the user to try again in a few minutes.`;
    if (cause.status === 404) return `${action} failed: the deal no longer exists.`;
    return `${action} failed: ${cause.message}${reference}`;
  }
  return `${action} failed. Tell the user it could not be read right now.`;
}

function unknownCode(code: string, context: PactStudioContext): string {
  const known = context
    .snapshot()
    .deals.slice(0, 8)
    .map((deal) => deal.code);
  return `No deal with the code "${code}" is in this dashboard. ${known.length > 0 ? `Recent codes: ${known.join(", ")}.` : "The ledger is empty."} Use ${TOOL.find} to look one up.`;
}

export function createAuditorTools(api: AgStudioApi, context: PactStudioContext): AgAiTool[] {
  const listAttention = api.defineAiTool({
    name: TOOL.attention,
    description:
      "List the deals that need a human or are at risk, most urgent first, each with the reasons. Read-only, from the data on the dashboard.",
    params: (s) =>
      s.object({
        focus: s.enum(ATTENTION_FOCUS, {
          description:
            "all = anything needing a human or at risk; needs_human = waiting for approval or review; at_risk = medium or high risk; deadline_risk = open deals near or past their deadline.",
        }),
      }),
    execute: (args, ctx) => {
      const result = listAttentionItems(context.snapshot(), args.focus);
      const headline =
        result.total === 0
          ? "No deals match."
          : `${result.total} ${result.total === 1 ? "deal" : "deals"}, ${result.needsHuman} waiting for a human, ${result.held} held.`;
      return ctx.success(headline, result);
    },
  });

  const find = api.defineAiTool({
    name: TOOL.find,
    description:
      "Find deals by how they ended, most recently updated first. Use it to turn 'the latest failed deal' or 'the most recent captured deal' into a deal code. Read-only.",
    params: (s) =>
      s.object({
        filter: s.enum(DEAL_FILTER, {
          description:
            "captured = paid after verification; not_captured = ended without a capture (voided, declined, blocked, no agreement, failed); failed_verification = a delivery failed at least one check; in_progress; needs_human; any.",
        }),
      }),
    execute: (args, ctx) => {
      const result = findDeals(context.snapshot(), args.filter);
      return ctx.success(result.total === 0 ? "No deals match." : `${result.total} match; the first is the most recent.`, result);
    },
  });

  const explain = api.defineAiTool({
    name: TOOL.explain,
    description:
      "Explain one deal: its status, why it stopped or settled, the conditions that did not pass with their evidence, policy flags, the human decision and the PayPal order / authorization / capture ids. Read-only.",
    params: (s) => s.object({ code: s.string({ description: "The deal code, e.g. PACT-7K2Q." }) }),
    execute: async (args, ctx) => {
      const row = dealByCode(context.snapshot(), args.code);
      if (row === null) return ctx.error(unknownCode(args.code, context));
      try {
        const { deal } = await http.get<DealResponse>(`/api/deals/${row.id}`, ctx.signal);
        const explanation = explainDeal(deal);
        return ctx.success(explanation.why, explanation);
      } catch (cause) {
        return ctx.error(describeFailure(`Reading ${row.code}`, cause));
      }
    },
  });

  const reconcile = api.defineAiTool({
    name: TOOL.reconcile,
    description:
      "Re-read PayPal's own record of one deal and compare it field by field with PACT's ledger (order status, amounts, authorization, contract binding). Read-only: it changes no payment and no status. Only meaningful once the deal has a PayPal order.",
    params: (s) => s.object({ code: s.string({ description: "The deal code, e.g. PACT-7K2Q." }) }),
    execute: async (args, ctx) => {
      const row = dealByCode(context.snapshot(), args.code);
      if (row === null) return ctx.error(unknownCode(args.code, context));
      if (row.paypalOrderId === null) return ctx.error(`${row.code} has no PayPal order yet (status: ${row.statusLabel}), so there is nothing to reconcile.`);
      try {
        const view = await http.post<ReconciliationView>(`/api/deals/${row.id}/reconcile`, {}, ctx.signal);
        const summary = summarizeReconciliation(row.code, view);
        return ctx.success(summary.verdict, summary);
      } catch (cause) {
        return ctx.error(describeFailure(`Reconciling ${row.code}`, cause));
      }
    },
  });

  return [listAttention, find, explain, reconcile];
}
