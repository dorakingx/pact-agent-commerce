/**
 * Turns the agent harness's telemetry stream into one line a person can read: how long the last
 * request took, which tools ran and which agents were handed work.
 *
 * Studio emits boundary events for every run; a delegation starts a child run that names its
 * parent. A request is therefore a tree of runs, and this tracker folds each tree into a single
 * summary when its root finishes. It keeps only names, counts and timestamps — never prompts,
 * arguments or results.
 */
import type { AgAiTelemetryEvent } from "ag-studio";

export interface AgentRunSummary {
  status: "ok" | "error" | "cancelled";
  durationMs: number;
  /** Model turns across the lead and every delegate. */
  turns: number;
  /** Tools executed, in order, excluding the hand-off and hand-back plumbing. */
  tools: string[];
  /** Agents the lead delegated to, in order (an agent appears once per hand-off). */
  delegates: string[];
  failedTools: number;
  model: string | null;
  error: string | null;
}

interface OpenRun {
  startedAt: number;
  turns: number;
  tools: string[];
  delegates: string[];
  failedTools: number;
  model: string | null;
}

/** Tools that only move work between agents: they are the delegation, not something done with it. */
const PLUMBING = new Set(["delegate_to", "complete_task", "rename_thread"]);

export interface AgentRunTracker {
  /** Feed one telemetry event. Returns the summary when it completes a top-level request, else null. */
  observe(event: AgAiTelemetryEvent): AgentRunSummary | null;
  /** True while a top-level request is in flight. */
  running(): boolean;
}

export function createAgentRunTracker(): AgentRunTracker {
  const roots = new Map<string, OpenRun>();
  /** runId → the root run it belongs to. */
  const rootOf = new Map<string, string>();

  const rootFor = (event: AgAiTelemetryEvent): OpenRun | undefined => roots.get(rootOf.get(event.trace.runId) ?? "");

  return {
    running: () => roots.size > 0,
    observe(event) {
      const { runId, parentRunId, agentId } = event.trace;
      switch (event.type) {
        case "run_started": {
          const parentRoot = parentRunId === undefined ? undefined : rootOf.get(parentRunId);
          if (parentRoot === undefined) {
            rootOf.set(runId, runId);
            roots.set(runId, { startedAt: event.timestamp, turns: 0, tools: [], delegates: [], failedTools: 0, model: null });
          } else {
            rootOf.set(runId, parentRoot);
            roots.get(parentRoot)?.delegates.push(agentId);
          }
          return null;
        }
        case "turn_finished": {
          const root = rootFor(event);
          if (root) {
            root.turns += 1;
            root.model = event.model ?? root.model;
          }
          return null;
        }
        case "tool_execution_finished": {
          const root = rootFor(event);
          if (root && !PLUMBING.has(event.name)) {
            root.tools.push(event.name);
            if (!event.ok) root.failedTools += 1;
          }
          return null;
        }
        case "run_finished": {
          const rootId = rootOf.get(runId);
          rootOf.delete(runId);
          if (rootId !== runId) return null;
          const root = roots.get(runId);
          roots.delete(runId);
          if (!root) return null;
          return {
            status: event.status,
            durationMs: Math.max(0, event.timestamp - root.startedAt),
            turns: root.turns,
            tools: root.tools,
            delegates: root.delegates,
            failedTools: root.failedTools,
            model: root.model,
            error: event.error ?? null,
          };
        }
        default:
          return null;
      }
    },
  };
}

/** "14.2 s · 5 model turns · 3 tools · handed to PACT auditor". */
export function describeAgentRun(summary: AgentRunSummary, agentName: (id: string) => string): string {
  const seconds = (summary.durationMs / 1000).toFixed(1);
  const parts = [`${seconds} s`, `${summary.turns} model ${summary.turns === 1 ? "turn" : "turns"}`];
  if (summary.tools.length > 0) parts.push(`${summary.tools.length} ${summary.tools.length === 1 ? "tool call" : "tool calls"}`);
  const delegates = [...new Set(summary.delegates)].map(agentName);
  if (delegates.length > 0) parts.push(`handed to ${delegates.join(", ")}`);
  if (summary.status === "error") parts.push("ended with an error");
  if (summary.status === "cancelled") parts.push("stopped");
  return parts.join(" · ");
}
