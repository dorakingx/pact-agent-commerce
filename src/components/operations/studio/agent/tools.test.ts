import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgAiToolContext, AgAiToolResult, AgStudioApi } from "ag-studio";
import type { ReconciliationView } from "@/lib/api/dto";
import { ApiClientError } from "@/lib/client/api";
import { deal } from "@/lib/client/deal-derive.fixtures";
import { ATTENTION_FOCUS, DEAL_FILTER, TOOL } from "@/lib/client/studio-agent";
import { opsRow, snapshotOf } from "@/lib/client/studio-fixtures";
import { createStudioContextHandle } from "../context";
import { createAuditorTools } from "./tools";

/*
 * The auditor's tools are thin: they read the snapshot or call PACT's own API and hand the result
 * to the pure helpers in studio-agent.ts (tested there). What is tested here is the wiring — which
 * tools exist, what they ask the model for, which endpoint each one calls, and what the model is
 * told when a call fails.
 */

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client/api")>();
  return { ...actual, api: { ...actual.api, get: http.get, post: http.post } };
});

/** The shape of an execute-style tool config, as `createAuditorTools` hands it to `defineAiTool`. */
interface ToolConfig {
  name: string;
  description: string;
  params(s: ShapeBuilder): unknown;
  execute(args: Record<string, unknown>, ctx: AgAiToolContext): Promise<AgAiToolResult> | AgAiToolResult;
}

/** Records the parameter shape a tool declares instead of building a real schema. */
const shapeBuilder = {
  object: (fields: Record<string, unknown>) => ({ type: "object", fields }),
  enum: (values: readonly string[], options?: { description?: string }) => ({ type: "enum", values, ...options }),
  string: (options?: { description?: string }) => ({ type: "string", ...options }),
};
type ShapeBuilder = typeof shapeBuilder;

/** A Studio API whose `defineAiTool` returns the config untouched, so the test can call it directly. */
const studioApi = { defineAiTool: (config: unknown) => config } as unknown as AgStudioApi;

function toolContext(): AgAiToolContext {
  return {
    signal: new AbortController().signal,
    run: { threadId: "thread", runId: "run" },
    success: (response, data) => ({ success: true, response, data }),
    error: (messages) => ({ success: false, issues: (Array.isArray(messages) ? messages : [messages]).map((message) => ({ message })) }),
  };
}

function messageOf(result: AgAiToolResult): string {
  if (result.success) throw new Error(`expected a failure, got "${result.response}"`);
  return result.issues.map((issue) => issue.message).join(" ");
}

const awaiting = opsRow("in_review", { code: "PACT-REVW" });
const settled = opsRow("completed", { code: "PACT-DONE" });
const unpaid = opsRow("negotiating", { code: "PACT-TALK" });
const snapshot = snapshotOf([awaiting, settled, unpaid]);

function tools(): Record<string, ToolConfig> {
  const { context } = createStudioContextHandle({ snapshot, onOpenDeal: () => undefined });
  const list = createAuditorTools(studioApi, context) as unknown as ToolConfig[];
  return Object.fromEntries(list.map((tool) => [tool.name, tool]));
}

beforeEach(() => {
  http.get.mockReset();
  http.post.mockReset();
});

describe("the auditor's tools", () => {
  it("are exactly the four read-only tools, in order", () => {
    const { context } = createStudioContextHandle({ snapshot, onOpenDeal: () => undefined });
    const list = createAuditorTools(studioApi, context) as unknown as ToolConfig[];
    expect(list.map((tool) => tool.name)).toEqual([TOOL.attention, TOOL.find, TOOL.explain, TOOL.reconcile]);
    for (const tool of list) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.description.toLowerCase()).toContain("read-only");
    }
  });

  it("ask the model for a closed set of values where one exists, and for a deal code otherwise", () => {
    const all = tools();
    expect(all[TOOL.attention]!.params(shapeBuilder)).toMatchObject({ fields: { focus: { type: "enum", values: ATTENTION_FOCUS } } });
    expect(all[TOOL.find]!.params(shapeBuilder)).toMatchObject({ fields: { filter: { type: "enum", values: DEAL_FILTER } } });
    expect(all[TOOL.explain]!.params(shapeBuilder)).toMatchObject({ fields: { code: { type: "string" } } });
    expect(all[TOOL.reconcile]!.params(shapeBuilder)).toMatchObject({ fields: { code: { type: "string" } } });
  });
});

describe(TOOL.attention, () => {
  it("answers from the snapshot with a one-line headline and the structured list", async () => {
    const result = await tools()[TOOL.attention]!.execute({ focus: "needs_human" }, toolContext());
    expect(result).toMatchObject({ success: true, response: "1 deal, 1 waiting for a human, $47.00 held." });
    expect(http.get).not.toHaveBeenCalled();
  });

  it("says so when nothing matches", async () => {
    const { context } = createStudioContextHandle({ snapshot: snapshotOf([settled]), onOpenDeal: () => undefined });
    const [attention] = createAuditorTools(studioApi, context) as unknown as ToolConfig[];
    expect(await attention!.execute({ focus: "needs_human" }, toolContext())).toMatchObject({ success: true, response: "No deals match." });
  });
});

describe(TOOL.find, () => {
  it("turns a filter into the most recent matching deal codes", async () => {
    const result = await tools()[TOOL.find]!.execute({ filter: "captured" }, toolContext());
    expect(result).toMatchObject({ success: true, response: "1 match; the first is the most recent." });
    expect(result.success && JSON.stringify(result.data)).toContain("PACT-DONE");
  });
});

describe(TOOL.explain, () => {
  it("reads the deal through PACT's own API, by id, with the run's abort signal", async () => {
    http.get.mockResolvedValue({ deal: deal({ status: "completed", id: settled.id, code: settled.code }) });
    const ctx = toolContext();
    const result = await tools()[TOOL.explain]!.execute({ code: " pact-done " }, ctx);
    expect(http.get).toHaveBeenCalledWith(`/api/deals/${settled.id}`, ctx.signal);
    expect(result.success).toBe(true);
    expect(result.success && result.data).toMatchObject({ code: settled.code });
  });

  it("refuses a code the dashboard does not hold, and lists the codes it does", async () => {
    const message = messageOf(await tools()[TOOL.explain]!.execute({ code: "PACT-NOPE" }, toolContext()));
    expect(message).toContain('No deal with the code "PACT-NOPE"');
    expect(message).toContain("PACT-REVW, PACT-DONE, PACT-TALK");
    expect(message).toContain(TOOL.find);
    expect(http.get).not.toHaveBeenCalled();
  });

  it("tells the model why a read failed, quoting the request id", async () => {
    http.get.mockRejectedValueOnce(new ApiClientError(500, "internal", "Database unavailable", "req_123", null));
    expect(messageOf(await tools()[TOOL.explain]!.execute({ code: "PACT-DONE" }, toolContext()))).toBe(
      "Reading PACT-DONE failed: Database unavailable (request req_123)",
    );
    http.get.mockRejectedValueOnce(new ApiClientError(404, "not_found", "Not found", null, null));
    expect(messageOf(await tools()[TOOL.explain]!.execute({ code: "PACT-DONE" }, toolContext()))).toBe(
      "Reading PACT-DONE failed: the deal no longer exists.",
    );
    http.get.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(messageOf(await tools()[TOOL.explain]!.execute({ code: "PACT-DONE" }, toolContext()))).toBe(
      "Reading PACT-DONE failed. Tell the user it could not be read right now.",
    );
  });
});

describe(TOOL.reconcile, () => {
  const view: ReconciliationView = {
    dealId: settled.id,
    status: "match",
    checkedAt: "2026-10-06T02:00:00.000Z",
    facts: [
      { field: "Order status", pact: "COMPLETED", paypal: "COMPLETED", match: true },
      { field: "Captured amount", pact: "47.00", paypal: "47.00", match: true },
    ],
    narrative: null,
    toolCalls: [],
    source: "deterministic",
    model: null,
    note: null,
  };

  it("posts to the reconcile endpoint and leads with the verdict", async () => {
    http.post.mockResolvedValue(view);
    const ctx = toolContext();
    const result = await tools()[TOOL.reconcile]!.execute({ code: "PACT-DONE" }, ctx);
    expect(http.post).toHaveBeenCalledWith(`/api/deals/${settled.id}/reconcile`, {}, ctx.signal);
    expect(result).toMatchObject({ success: true, response: "PACT's ledger and PayPal agree on all 2 fields." });
  });

  it("does not call PayPal for a deal that has no order yet", async () => {
    const message = messageOf(await tools()[TOOL.reconcile]!.execute({ code: "PACT-TALK" }, toolContext()));
    expect(message).toContain("PACT-TALK has no PayPal order yet");
    expect(http.post).not.toHaveBeenCalled();
  });

  it("passes a rate limit on as advice to wait", async () => {
    http.post.mockRejectedValue(new ApiClientError(429, "rate_limited", "Too many requests", "req_9", null));
    expect(messageOf(await tools()[TOOL.reconcile]!.execute({ code: "PACT-DONE" }, toolContext()))).toBe(
      "Reconciling PACT-DONE is rate limited right now. Tell the user to try again in a few minutes.",
    );
  });
});
