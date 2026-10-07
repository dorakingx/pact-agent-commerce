import type { AgAiEvent, AgLlmRequest } from "ag-studio";
import { describe, expect, it, vi } from "vitest";
import {
  applyResponsesEvent,
  closeOpenItems,
  createOpsLlmAdapter,
  createSseDecoder,
  createTurnState,
  describeProxyFailure,
  finishTurn,
  toResponsesBody,
} from "./studio-llm-adapter";

const TOOL = {
  name: "explain_deal",
  description: "Explain one deal.",
  parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
};

function request(overrides: Partial<AgLlmRequest> = {}): AgLlmRequest {
  return {
    input: [{ id: "m1", kind: "input", type: "message", role: "user", status: "completed", content: [{ type: "text", text: "Why did PACT-7K2Q stop?" }] }],
    instructions: "Be brief.",
    tools: [TOOL],
    responseFormat: { type: "text" },
    ...overrides,
  };
}

function sse(events: unknown[]): string {
  return events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
}

function streamOf(text: string, chunkSize = 37): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

const sseResponse = (events: unknown[]): Response => new Response(streamOf(sse(events)), { status: 200, headers: { "content-type": "text/event-stream" } });

async function drain(stream: { [Symbol.asyncIterator](): AsyncIterator<AgAiEvent> }): Promise<AgAiEvent[]> {
  const events: AgAiEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const TOOL_CALL_STREAM = [
  { type: "response.created", response: { id: "resp_1", model: "openai/gpt-5-mini", created_at: 1_791_239_082 } },
  { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1", summary: [] } },
  { type: "response.reasoning.delta", item_id: "rs_1", delta: "private thoughts" },
  { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_A", name: "explain_deal", arguments: "" } },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"code":' },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"PACT-7K2Q"}' },
  { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: '{"code":"PACT-7K2Q"}' },
  { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_A", name: "explain_deal", arguments: '{"code":"PACT-7K2Q"}' } },
  { type: "response.output_item.done", item: { type: "reasoning", id: "rs_1", summary: [], content: [{ type: "reasoning_text", text: "private thoughts" }] } },
  {
    type: "response.completed",
    response: {
      id: "resp_1",
      model: "openai/gpt-5-mini",
      created_at: 1_791_239_082,
      usage: { input_tokens: 1200, output_tokens: 40, total_tokens: 1240, output_tokens_details: { reasoning_tokens: 16 }, input_tokens_details: { cached_tokens: 900 } },
      output: [
        { type: "reasoning", id: "rs_1" },
        { type: "function_call", id: "fc_1", call_id: "call_A", name: "explain_deal", arguments: '{"code":"PACT-7K2Q"}' },
      ],
    },
  },
];

const TEXT_STREAM = [
  { type: "response.created", response: { id: "resp_2", model: "google/gemini-2.5-flash" } },
  { type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
  { type: "response.output_text.delta", item_id: "msg_1", delta: "It is waiting " },
  { type: "response.output_text.delta", item_id: "msg_1", delta: "for approval." },
  { type: "response.output_item.done", item: { type: "message", id: "msg_1", content: [{ type: "output_text", text: "It is waiting for approval." }] } },
  { type: "response.completed", response: { id: "resp_2", model: "google/gemini-2.5-flash", output: [{ type: "message", id: "msg_1", content: [{ type: "output_text", text: "It is waiting for approval." }] }] } },
];

describe("toResponsesBody", () => {
  it("translates a turn into a stateless, streamed Responses request", () => {
    const body = toResponsesBody(request(), "openai/gpt-5-mini");
    expect(body).toEqual({
      model: "openai/gpt-5-mini",
      stream: true,
      store: false,
      instructions: "Be brief.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Why did PACT-7K2Q stop?" }] }],
      tools: [{ type: "function", name: "explain_deal", description: "Explain one deal.", parameters: TOOL.parameters, strict: false }],
    });
  });

  it("replays the conversation: assistant text, tool calls by call id, their results, and never reasoning", () => {
    const body = toResponsesBody(
      request({
        input: [
          { id: "m1", kind: "input", type: "message", role: "system", status: "completed", content: [{ type: "text", text: "context" }] },
          { id: "a1", kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: "Looking.", annotations: [] }] },
          { id: "rs_1", kind: "output", type: "reasoning", summary: [{ type: "summary", text: "hidden" }] },
          { id: "fc_1", kind: "output", type: "function_call", callId: "call_A", name: "explain_deal", arguments: "", status: "completed" },
          { type: "function_call_output", callId: "call_A", output: '{"success":true}', status: "completed" },
        ],
      }),
      "openai/gpt-5-mini",
    );
    expect(body.input).toEqual([
      { type: "message", role: "system", content: [{ type: "input_text", text: "context" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Looking." }] },
      { type: "function_call", call_id: "call_A", name: "explain_deal", arguments: "{}" },
      { type: "function_call_output", call_id: "call_A", output: '{"success":true}' },
    ]);
    expect(JSON.stringify(body)).not.toContain("hidden");
    expect(JSON.stringify(body)).not.toContain("fc_1");
  });

  it("carries the chosen model, effort and tool choice, and a JSON response format", () => {
    const body = toResponsesBody(
      request({
        model: { id: "google/gemini-2.5-flash", effort: "minimal" },
        toolChoice: { name: "explain_deal" },
        responseFormat: { type: "json", name: "answer", schema: { type: "object" } },
      }),
      "openai/gpt-5-mini",
    );
    expect(body.model).toBe("google/gemini-2.5-flash");
    expect(body.reasoning).toEqual({ effort: "minimal" });
    expect(body.tool_choice).toEqual({ type: "function", name: "explain_deal" });
    expect(body.text).toEqual({ format: { type: "json_schema", name: "answer", schema: { type: "object" }, strict: false } });
    expect(toResponsesBody(request({ toolChoice: "required" }), "m").tool_choice).toBe("required");
  });

  it("sends no tool fields when the turn has no tools, and passes a provider-hosted tool through untouched", () => {
    const bare = toResponsesBody(request({ tools: [], toolChoice: "auto", instructions: undefined }), "m");
    expect(bare).not.toHaveProperty("tools");
    expect(bare).not.toHaveProperty("tool_choice");
    expect(bare).not.toHaveProperty("instructions");
    const hosted = toResponsesBody(request({ tools: [{ ...TOOL, kind: "provided", provider: { type: "web_search" } }] }), "m");
    expect(hosted.tools).toEqual([{ type: "web_search" }]);
  });
});

describe("createSseDecoder", () => {
  it("reassembles events split anywhere, including inside a multi-byte boundary of the framing", () => {
    const text = sse([{ type: "a", n: 1 }, { type: "b", text: "héllo — ✓" }]);
    for (const size of [1, 2, 5, 13, 1000]) {
      const decoder = createSseDecoder();
      const payloads: string[] = [];
      for (let offset = 0; offset < text.length; offset += size) payloads.push(...decoder.push(text.slice(offset, offset + size)));
      payloads.push(...decoder.flush());
      expect(payloads.map((payload) => JSON.parse(payload))).toEqual([
        { type: "a", n: 1 },
        { type: "b", text: "héllo — ✓" },
      ]);
    }
  });

  it("ignores comments, event names and the [DONE] sentinel, joins multi-line data, and accepts CRLF", () => {
    const decoder = createSseDecoder();
    expect(decoder.push(": keep-alive\n\nevent: x\ndata: {\"a\":\ndata: 1}\n\ndata: [DONE]\n\n")).toEqual(['{"a":\n1}']);
    expect(decoder.push('data: {"b":2}\r\n\r\n')).toEqual(['{"b":2}']);
    expect(decoder.push('data: {"c":3}')).toEqual([]);
    expect(decoder.flush()).toEqual(['{"c":3}']);
    expect(decoder.flush()).toEqual([]);
  });
});

describe("applyResponsesEvent", () => {
  it("turns a streamed tool call into start / args / end and never surfaces reasoning", () => {
    const state = createTurnState(1_000);
    const events = TOOL_CALL_STREAM.flatMap((event) => applyResponsesEvent(state, event));
    expect(events).toEqual([
      { type: "TOOL_CALL_START", toolCallId: "call_A", toolCallName: "explain_deal" },
      { type: "TOOL_CALL_ARGS", toolCallId: "call_A", delta: '{"code":' },
      { type: "TOOL_CALL_ARGS", toolCallId: "call_A", delta: '"PACT-7K2Q"}' },
      { type: "TOOL_CALL_END", toolCallId: "call_A" },
    ]);
    expect(JSON.stringify(events)).not.toContain("private thoughts");
    expect(finishTurn(state)).toEqual({
      id: "resp_1",
      createdAt: 1_791_239_082_000,
      status: "completed",
      model: "openai/gpt-5-mini",
      usage: { inputTokens: 1200, outputTokens: 40, totalTokens: 1240, reasoningTokens: 16, cachedInputTokens: 900 },
      output: [{ id: "fc_1", kind: "output", type: "function_call", callId: "call_A", name: "explain_deal", arguments: '{"code":"PACT-7K2Q"}', status: "completed" }],
    });
  });

  it("turns streamed text into a message", () => {
    const state = createTurnState(1_000);
    const events = TEXT_STREAM.flatMap((event) => applyResponsesEvent(state, event));
    expect(events).toEqual([
      { type: "TEXT_MESSAGE_START", messageId: "msg_1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "msg_1", delta: "It is waiting " },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "msg_1", delta: "for approval." },
      { type: "TEXT_MESSAGE_END", messageId: "msg_1" },
    ]);
    expect(finishTurn(state).output).toEqual([
      {
        id: "msg_1",
        kind: "output",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "text", text: "It is waiting for approval.", annotations: [] }],
      },
    ]);
  });

  it("accepts a provider that sends items whole instead of as deltas", () => {
    const state = createTurnState(1_000);
    const events = [
      { type: "response.output_item.done", item: { type: "message", id: "msg_9", content: [{ type: "output_text", text: "Done." }] } },
      { type: "response.output_item.done", item: { type: "function_call", id: "fc_9", call_id: "call_Z", name: "find_deals", arguments: '{"filter":"captured"}' } },
      { type: "response.completed", response: { id: "resp_9" } },
    ].flatMap((event) => applyResponsesEvent(state, event));
    expect(events.map((event) => event.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
    ]);
    expect(finishTurn(state).output.map((item) => item.type)).toEqual(["message", "function_call"]);
  });

  it("builds the turn from a single non-streamed response", () => {
    const state = createTurnState(1_000);
    const final = TOOL_CALL_STREAM[TOOL_CALL_STREAM.length - 1];
    const events = applyResponsesEvent(state, final);
    expect(events.map((event) => event.type)).toEqual(["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]);
    expect(finishTurn(state).output).toHaveLength(1);
  });

  it("gives items without an id one of their own, and a call without arguments an empty object", () => {
    const state = createTurnState(1_000);
    applyResponsesEvent(state, { type: "response.output_item.done", item: { type: "function_call", name: "list_attention_items" } });
    const [call] = finishTurn(state).output;
    expect(call).toMatchObject({ type: "function_call", name: "list_attention_items", arguments: "{}" });
    expect(call?.id).toBe("call-1000-1");
  });

  it("reports a failed turn through the response, not the stream", () => {
    const failed = createTurnState(1_000);
    expect(applyResponsesEvent(failed, { type: "response.failed", response: { error: { code: "server_error", message: "Upstream broke." } } })).toEqual([]);
    expect(finishTurn(failed)).toMatchObject({ status: "failed", error: { code: "server_error", message: "Upstream broke." } });

    const errored = createTurnState(1_000);
    applyResponsesEvent(errored, { type: "error", error: { type: "invalid_request_error", message: "Bad schema." } });
    expect(finishTurn(errored).error).toEqual({ code: "invalid_request_error", message: "Bad schema." });
  });

  it("keeps a truncated answer and says why it stopped", () => {
    const state = createTurnState(1_000);
    applyResponsesEvent(state, { type: "response.output_text.delta", item_id: "msg_1", delta: "Half an ans" });
    applyResponsesEvent(state, { type: "response.incomplete", response: { id: "resp_3", incomplete_details: { reason: "max_output_tokens" } } });
    expect(closeOpenItems(state)).toEqual([{ type: "TEXT_MESSAGE_END", messageId: "msg_1" }]);
    expect(finishTurn(state)).toMatchObject({ status: "incomplete", incompleteDetails: { reason: "max_output_tokens" } });
  });

  it("treats a stream that just ends as complete if it produced something, and as a failure if it did not", () => {
    const some = createTurnState(1_000);
    applyResponsesEvent(some, { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" });
    expect(finishTurn(some).status).toBe("completed");
    const none = createTurnState(1_000);
    expect(finishTurn(none)).toMatchObject({ status: "failed", error: { code: "empty_response" } });
  });

  it("ignores events it does not know and values that are not events", () => {
    const state = createTurnState(1_000);
    for (const event of [null, "text", 3, [], {}, { type: "response.brand_new_event" }, { type: "response.output_text.delta" }]) {
      expect(applyResponsesEvent(state, event)).toEqual([]);
    }
  });
});

describe("describeProxyFailure", () => {
  it("explains a rate limit with the wait the server asked for", () => {
    expect(describeProxyFailure(429, { error: { code: "rate_limited" } }, "41")).toEqual({
      code: "rate_limited",
      message: "The agents are rate limited for this session. Try again in 41 s.",
    });
    expect(describeProxyFailure(429, null, null).message).toBe("The agents are rate limited for this session. Try again shortly.");
  });

  it("passes on the server's own sentence and its request id", () => {
    expect(describeProxyFailure(503, { error: { code: "unavailable", message: "The AI provider did not answer in time. Try again.", requestId: "req-1" } }, null)).toEqual({
      code: "unavailable",
      message: "The AI provider did not answer in time. Try again. (request req-1)",
    });
    expect(describeProxyFailure(403, { error: { code: "forbidden", requestId: "req-2" } }, null).message).toBe("This request was not allowed. (request req-2)");
    expect(describeProxyFailure(500, "<html>", null)).toEqual({ code: "http_500", message: "The agent endpoint answered 500." });
  });
});

describe("createOpsLlmAdapter", () => {
  it("posts the turn to PACT's proxy and streams the answer back", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => sseResponse(TOOL_CALL_STREAM));
    const adapter = createOpsLlmAdapter({ endpoint: "/api/ops/ai", defaultModel: "openai/gpt-5-mini", fetchImpl, now: () => 1_000 });
    const controller = new AbortController();
    const handler = adapter.executeTurn(request(), { signal: controller.signal });

    // Nothing is sent until the stream is read.
    expect(fetchImpl).not.toHaveBeenCalled();
    const events = await drain(handler.stream);
    const response = await handler.complete;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/ops/ai");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", signal: controller.signal });
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "openai/gpt-5-mini", stream: true, store: false });

    expect(events.map((event) => event.type)).toEqual(["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_ARGS", "TOOL_CALL_END"]);
    expect(response.status).toBe("completed");
    expect(response.output).toEqual([expect.objectContaining({ type: "function_call", callId: "call_A", arguments: '{"code":"PACT-7K2Q"}' })]);
  });

  it("reads a non-streamed JSON answer as one finished turn", async () => {
    const final = TEXT_STREAM[TEXT_STREAM.length - 1] as { response: unknown };
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(final.response));
    const handler = createOpsLlmAdapter({ endpoint: "/api/ops/ai", defaultModel: "m", fetchImpl }).executeTurn(request());
    expect((await drain(handler.stream)).map((event) => event.type)).toEqual(["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"]);
    expect((await handler.complete).status).toBe("completed");
  });

  it("closes a message the stream left open when the connection ends early", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => sseResponse(TEXT_STREAM.slice(0, 3)));
    const handler = createOpsLlmAdapter({ endpoint: "/api/ops/ai", defaultModel: "m", fetchImpl }).executeTurn(request());
    const events = await drain(handler.stream);
    expect(events[events.length - 1]).toEqual({ type: "TEXT_MESSAGE_END", messageId: "msg_1" });
    expect(await handler.complete).toMatchObject({ status: "completed", output: [{ content: [{ text: "It is waiting " }] }] });
  });

  it("turns a refusal by the proxy into a failed turn with a readable reason", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { code: "rate_limited", message: "Too many requests.", requestId: "req-9" } }, { status: 429, headers: { "retry-after": "30" } }),
    );
    const handler = createOpsLlmAdapter({ endpoint: "/api/ops/ai", defaultModel: "m", fetchImpl }).executeTurn(request());
    expect(await drain(handler.stream)).toEqual([]);
    expect(await handler.complete).toMatchObject({
      status: "failed",
      output: [],
      error: { code: "rate_limited", message: "The agents are rate limited for this session. Try again in 30 s." },
    });
  });

  it("reports an unreachable endpoint as a failure and a cancelled run as cancelled", async () => {
    const offline = createOpsLlmAdapter({ endpoint: "/api/ops/ai", defaultModel: "m", fetchImpl: async () => Promise.reject(new TypeError("Failed to fetch")) });
    const failed = offline.executeTurn(request());
    await drain(failed.stream);
    expect(await failed.complete).toMatchObject({ status: "failed", error: { code: "network" } });

    const controller = new AbortController();
    controller.abort();
    const aborted = createOpsLlmAdapter({
      endpoint: "/api/ops/ai",
      defaultModel: "m",
      fetchImpl: async () => Promise.reject(new DOMException("Aborted", "AbortError")),
    }).executeTurn(request(), { signal: controller.signal });
    await drain(aborted.stream);
    expect((await aborted.complete).status).toBe("cancelled");
  });

  it("settles `complete` even when the reader stops early, and never sends the turn twice", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => sseResponse(TOOL_CALL_STREAM));
    const handler = createOpsLlmAdapter({ endpoint: "/api/ops/ai", defaultModel: "m", fetchImpl }).executeTurn(request());
    for await (const event of handler.stream) {
      expect(event.type).toBe("TOOL_CALL_START");
      break;
    }
    expect((await handler.complete).status).toBe("cancelled");
    expect(await drain(handler.stream)).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
