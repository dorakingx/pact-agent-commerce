import type { AgAiTelemetryEvent } from "ag-studio";
import { describe, expect, it } from "vitest";
import { createAgentRunTracker, describeAgentRun, type AgentRunSummary } from "./studio-agent-telemetry";

const trace = (runId: string, agentId: string, parentRunId?: string) => ({ threadId: "t1", runId, agentId, parentRunId });

const started = (runId: string, agentId: string, timestamp: number, parentRunId?: string): AgAiTelemetryEvent => ({
  type: "run_started",
  trace: trace(runId, agentId, parentRunId),
  timestamp,
  query: "q",
  toolSchemas: [],
});
const turn = (runId: string, agentId: string, timestamp: number, model = "openai/gpt-5-mini"): AgAiTelemetryEvent => ({
  type: "turn_finished",
  trace: trace(runId, agentId),
  timestamp,
  model,
});
const tool = (runId: string, agentId: string, name: string, ok = true): AgAiTelemetryEvent => ({
  type: "tool_execution_finished",
  trace: trace(runId, agentId),
  timestamp: 0,
  toolCallId: `${runId}-${name}`,
  name,
  kind: "client",
  ok,
});
const finished = (runId: string, agentId: string, timestamp: number, status: "ok" | "error" | "cancelled" = "ok", error?: string): AgAiTelemetryEvent => ({
  type: "run_finished",
  trace: trace(runId, agentId),
  timestamp,
  status,
  error,
});

describe("createAgentRunTracker", () => {
  it("folds a lead run and its delegate into one summary", () => {
    const tracker = createAgentRunTracker();
    const events = [
      started("r1", "lead", 1_000),
      turn("r1", "lead", 3_000),
      started("r2", "auditor", 3_100, "r1"),
      turn("r2", "auditor", 5_000),
      tool("r2", "auditor", "find_deals"),
      turn("r2", "auditor", 7_000),
      tool("r2", "auditor", "explain_deal"),
      turn("r2", "auditor", 9_000),
      tool("r2", "auditor", "complete_task"),
      finished("r2", "auditor", 9_100),
      tool("r1", "lead", "delegate_to"),
      turn("r1", "lead", 13_200),
    ];
    for (const event of events) {
      expect(tracker.observe(event)).toBeNull();
      expect(tracker.running()).toBe(true);
    }
    const summary = tracker.observe(finished("r1", "lead", 13_250));
    expect(summary).toEqual({
      status: "ok",
      durationMs: 12_250,
      turns: 5,
      tools: ["find_deals", "explain_deal"],
      delegates: ["auditor"],
      failedTools: 0,
      model: "openai/gpt-5-mini",
      error: null,
    });
    expect(tracker.running()).toBe(false);
  });

  it("counts failed tools and reports how the run ended", () => {
    const tracker = createAgentRunTracker();
    tracker.observe(started("r1", "lead", 0));
    tracker.observe(tool("r1", "lead", "view_schema", false));
    const summary = tracker.observe(finished("r1", "lead", 2_000, "error", "The agents are rate limited for this session."));
    expect(summary).toMatchObject({ status: "error", failedTools: 1, tools: ["view_schema"], error: "The agents are rate limited for this session." });
  });

  it("keeps two conversations apart", () => {
    const tracker = createAgentRunTracker();
    tracker.observe(started("a", "lead", 0));
    tracker.observe(started("b", "lead", 100));
    tracker.observe(tool("a", "lead", "view_page"));
    expect(tracker.observe(finished("b", "lead", 600))).toMatchObject({ durationMs: 500, tools: [] });
    expect(tracker.running()).toBe(true);
    expect(tracker.observe(finished("a", "lead", 900))).toMatchObject({ durationMs: 900, tools: ["view_page"] });
  });

  it("ignores events of runs it never saw start", () => {
    const tracker = createAgentRunTracker();
    expect(tracker.observe(turn("ghost", "lead", 0))).toBeNull();
    expect(tracker.observe(finished("ghost", "lead", 10))).toBeNull();
    expect(tracker.running()).toBe(false);
  });
});

describe("describeAgentRun", () => {
  const summary: AgentRunSummary = {
    status: "ok",
    durationMs: 13_540,
    turns: 4,
    tools: ["list_attention_items"],
    delegates: ["auditor", "auditor"],
    failedTools: 0,
    model: null,
    error: null,
  };
  const name = (id: string): string => (id === "auditor" ? "PACT auditor" : `${id} agent`);

  it("says how long, how many turns and tools, and who was handed work", () => {
    expect(describeAgentRun(summary, name)).toBe("13.5 s · 4 model turns · 1 tool call · handed to PACT auditor");
  });

  it("omits what did not happen and flags a run that did not finish", () => {
    expect(describeAgentRun({ ...summary, turns: 1, tools: [], delegates: [] }, name)).toBe("13.5 s · 1 model turn");
    expect(describeAgentRun({ ...summary, tools: ["a", "b"], delegates: ["data"], status: "error" }, name)).toBe(
      "13.5 s · 4 model turns · 2 tool calls · handed to data agent · ended with an error",
    );
    expect(describeAgentRun({ ...summary, status: "cancelled", delegates: [] }, name)).toMatch(/· stopped$/);
  });
});
