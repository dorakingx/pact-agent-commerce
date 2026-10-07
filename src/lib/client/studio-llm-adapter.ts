/**
 * The LLM adapter behind AG Studio's agents.
 *
 * Studio ships no connection to any model: an agent's loop calls `executeTurn` on an adapter the
 * application supplies. This one speaks the OpenAI Responses wire format — the same approach as
 * the adapter in AG's documentation — but never to a provider. It posts to PACT's own route
 * (POST /api/ops/ai), which holds the credentials, pins the model to an allow-list and streams
 * the provider's answer straight back. No key ever reaches the browser.
 *
 * The adapter does three things and nothing else:
 *  1. translate Studio's request (conversation, instructions, tool schemas) into a Responses body;
 *  2. translate the streamed Responses events into Studio's AG-UI events as they arrive;
 *  3. assemble the final response (messages and tool calls) the agent loop acts on.
 *
 * It never executes a tool and never surfaces model reasoning: reasoning items are dropped on
 * the way in and on the way out.
 */
import type {
  AgAiConversationItem,
  AgAiEvent,
  AgAiOutputItem,
  AgAiToolSchema,
  AgAiUsage,
  AgLlmAdapter,
  AgLlmRequest,
  AgLlmResponse,
  AgLlmResponseError,
} from "ag-studio";

/* -------------------------------------------------------------------------- */
/*  Request: Studio → Responses                                                */
/* -------------------------------------------------------------------------- */

type JsonObject = Record<string, unknown>;

export interface ResponsesBody {
  model: string;
  stream: true;
  store: false;
  input: JsonObject[];
  instructions?: string;
  tools?: unknown[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; name: string };
  reasoning?: { effort: string };
  text?: { format: JsonObject };
}

function inputItem(item: AgAiConversationItem): JsonObject | null {
  switch (item.type) {
    case "message":
      if (item.kind === "input") {
        const content = item.content.flatMap((part): JsonObject[] => {
          if (part.type === "text") return [{ type: "input_text", text: part.text }];
          if (part.type === "image" && part.imageUrl) return [{ type: "input_image", image_url: part.imageUrl, detail: part.detail }];
          return [];
        });
        return content.length === 0 ? null : { type: "message", role: item.role, content };
      }
      return {
        type: "message",
        role: "assistant",
        content: item.content.map((part) => ({ type: "output_text", text: part.type === "text" ? part.text : part.refusal })),
      };
    case "function_call":
      // The item id is deliberately not sent: a call is identified by its call id alone, and an
      // id would oblige the provider to find the (never stored) reasoning item it came with.
      return { type: "function_call", call_id: item.callId, name: item.name, arguments: item.arguments.length > 0 ? item.arguments : "{}" };
    case "function_call_output":
      return { type: "function_call_output", call_id: item.callId, output: item.output };
    case "reasoning":
      return null;
  }
}

function toolDeclaration(tool: AgAiToolSchema): unknown {
  // A provider-hosted tool carries the provider's own declaration; everything else is a function.
  if (tool.kind === "provided") return tool.provider;
  return { type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false };
}

function toolChoice(choice: AgLlmRequest["toolChoice"]): ResponsesBody["tool_choice"] {
  if (choice === undefined) return undefined;
  return typeof choice === "string" ? choice : { type: "function", name: choice.name };
}

/** The Responses request for one turn. `defaultModel` answers when the chat offers no model choice. */
export function toResponsesBody(request: AgLlmRequest, defaultModel: string): ResponsesBody {
  const body: ResponsesBody = {
    model: request.model?.id ?? defaultModel,
    stream: true,
    // Nothing about a conversation is kept at the provider: every turn carries its own history.
    store: false,
    input: request.input.map(inputItem).filter((item): item is JsonObject => item !== null),
  };
  if (request.instructions) body.instructions = request.instructions;
  const tools = (request.tools ?? []).map(toolDeclaration).filter((tool) => tool !== undefined && tool !== null);
  if (tools.length > 0) {
    body.tools = tools;
    const choice = toolChoice(request.toolChoice);
    if (choice !== undefined) body.tool_choice = choice;
  }
  if (request.model?.effort) body.reasoning = { effort: request.model.effort };
  if (request.responseFormat.type === "json") {
    body.text = {
      format: {
        type: "json_schema",
        name: request.responseFormat.name,
        schema: request.responseFormat.schema,
        strict: false,
        ...(request.responseFormat.description ? { description: request.responseFormat.description } : {}),
      },
    };
  }
  return body;
}

/* -------------------------------------------------------------------------- */
/*  Response: Responses stream → Studio events                                 */
/* -------------------------------------------------------------------------- */

interface MessageDraft {
  kind: "message";
  id: string;
  text: string;
  open: boolean;
}

interface CallDraft {
  kind: "call";
  id: string;
  callId: string;
  name: string;
  args: string;
  open: boolean;
}

type Draft = MessageDraft | CallDraft;

/** Everything one turn accumulates while its stream is read. */
export interface TurnState {
  responseId: string | null;
  createdAt: number;
  model: string | null;
  status: AgLlmResponse["status"];
  error: AgLlmResponseError | null;
  incompleteReason: "max_output_tokens" | "content_filter" | null;
  usage: AgAiUsage | null;
  drafts: Map<string, Draft>;
  /** Draft ids in the order the provider produced them. */
  order: string[];
  /** Counter for items the provider sent without an id. */
  anonymous: number;
}

export function createTurnState(now: number): TurnState {
  return {
    responseId: null,
    createdAt: now,
    model: null,
    status: "in_progress",
    error: null,
    incompleteReason: null,
    usage: null,
    drafts: new Map(),
    order: [],
    anonymous: 0,
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** All output text of a message item's content array (refusals read as text: the user should see them). */
function messageText(item: JsonObject): string {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .map((part: unknown) => (isObject(part) ? (str(part.text) ?? str(part.refusal) ?? "") : ""))
    .join("");
}

function usageOf(value: unknown): AgAiUsage | null {
  if (!isObject(value)) return null;
  const input = num(value.input_tokens);
  const output = num(value.output_tokens);
  if (input === null || output === null) return null;
  const usage: AgAiUsage = { inputTokens: input, outputTokens: output };
  const total = num(value.total_tokens);
  if (total !== null) usage.totalTokens = total;
  const reasoning = isObject(value.output_tokens_details) ? num(value.output_tokens_details.reasoning_tokens) : null;
  if (reasoning !== null) usage.reasoningTokens = reasoning;
  const cached = isObject(value.input_tokens_details) ? num(value.input_tokens_details.cached_tokens) : null;
  if (cached !== null) usage.cachedInputTokens = cached;
  return usage;
}

function draftId(state: TurnState, item: JsonObject, prefix: string): string {
  const id = str(item.id);
  if (id !== null) return id;
  state.anonymous += 1;
  return `${prefix}-${state.createdAt}-${state.anonymous}`;
}

function openMessage(state: TurnState, id: string, events: AgAiEvent[]): MessageDraft {
  const existing = state.drafts.get(id);
  if (existing?.kind === "message") return existing;
  const draft: MessageDraft = { kind: "message", id, text: "", open: true };
  state.drafts.set(id, draft);
  state.order.push(id);
  events.push({ type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" });
  return draft;
}

function openCall(state: TurnState, id: string, item: JsonObject, events: AgAiEvent[]): CallDraft | null {
  const existing = state.drafts.get(id);
  if (existing?.kind === "call") return existing;
  const name = str(item.name);
  if (name === null) return null;
  const draft: CallDraft = { kind: "call", id, callId: str(item.call_id) ?? id, name, args: "", open: true };
  state.drafts.set(id, draft);
  state.order.push(id);
  events.push({ type: "TOOL_CALL_START", toolCallId: draft.callId, toolCallName: name });
  return draft;
}

function appendText(draft: MessageDraft, delta: string, events: AgAiEvent[]): void {
  if (delta.length === 0) return;
  draft.text += delta;
  events.push({ type: "TEXT_MESSAGE_CONTENT", messageId: draft.id, delta });
}

function appendArgs(draft: CallDraft, delta: string, events: AgAiEvent[]): void {
  if (delta.length === 0) return;
  draft.args += delta;
  events.push({ type: "TOOL_CALL_ARGS", toolCallId: draft.callId, delta });
}

/** Bring a draft up to the item's final content (providers may send it whole instead of as deltas) and close it. */
function settleItem(state: TurnState, item: JsonObject, events: AgAiEvent[]): void {
  const type = str(item.type);
  if (type === "message") {
    const draft = openMessage(state, draftId(state, item, "msg"), events);
    const full = messageText(item);
    if (full.length > draft.text.length && full.startsWith(draft.text)) appendText(draft, full.slice(draft.text.length), events);
    if (draft.open) {
      draft.open = false;
      events.push({ type: "TEXT_MESSAGE_END", messageId: draft.id });
    }
  } else if (type === "function_call") {
    const draft = openCall(state, draftId(state, item, "call"), item, events);
    if (draft === null) return;
    const full = str(item.arguments) ?? "";
    if (full.length > draft.args.length && full.startsWith(draft.args)) appendArgs(draft, full.slice(draft.args.length), events);
    if (draft.open) {
      draft.open = false;
      events.push({ type: "TOOL_CALL_END", toolCallId: draft.callId });
    }
  }
  // Reasoning items and anything unknown are ignored: neither is shown nor sent back.
}

function settleResponse(state: TurnState, response: unknown, events: AgAiEvent[]): void {
  if (!isObject(response)) return;
  state.responseId = str(response.id) ?? state.responseId;
  state.model = str(response.model) ?? state.model;
  state.usage = usageOf(response.usage) ?? state.usage;
  const created = num(response.created_at);
  if (created !== null) state.createdAt = created * 1000;
  // A non-streamed answer arrives as one finished response: its items are settled here.
  if (Array.isArray(response.output)) {
    for (const item of response.output) if (isObject(item)) settleItem(state, item, events);
  }
}

function errorOf(value: unknown, fallback: string): AgLlmResponseError {
  const source = isObject(value) ? value : {};
  return { code: str(source.code) ?? str(source.type) ?? "provider_error", message: str(source.message) ?? fallback };
}

/**
 * Apply one parsed Responses stream event to the turn and return the Studio events it produces.
 * Unknown event types are ignored, so a provider adding events cannot break a conversation.
 */
export function applyResponsesEvent(state: TurnState, event: unknown): AgAiEvent[] {
  const events: AgAiEvent[] = [];
  if (!isObject(event)) return events;
  const type = str(event.type);
  switch (type) {
    case "response.created":
    case "response.in_progress":
      if (isObject(event.response)) {
        state.responseId = str(event.response.id) ?? state.responseId;
        state.model = str(event.response.model) ?? state.model;
      }
      break;
    case "response.output_item.added":
      if (isObject(event.item)) {
        const itemType = str(event.item.type);
        if (itemType === "message") openMessage(state, draftId(state, event.item, "msg"), events);
        else if (itemType === "function_call") openCall(state, draftId(state, event.item, "call"), event.item, events);
      }
      break;
    case "response.output_text.delta":
    case "response.refusal.delta": {
      const id = str(event.item_id);
      const delta = str(event.delta);
      if (id !== null && delta !== null) appendText(openMessage(state, id, events), delta, events);
      break;
    }
    case "response.function_call_arguments.delta": {
      const draft = state.drafts.get(str(event.item_id) ?? "");
      const delta = str(event.delta);
      if (draft?.kind === "call" && delta !== null) appendArgs(draft, delta, events);
      break;
    }
    case "response.function_call_arguments.done": {
      const draft = state.drafts.get(str(event.item_id) ?? "");
      const full = str(event.arguments) ?? "";
      if (draft?.kind === "call" && full.length > draft.args.length && full.startsWith(draft.args)) {
        appendArgs(draft, full.slice(draft.args.length), events);
      }
      break;
    }
    case "response.output_item.done":
      if (isObject(event.item)) settleItem(state, event.item, events);
      break;
    case "response.completed":
      settleResponse(state, event.response, events);
      state.status = "completed";
      break;
    case "response.incomplete": {
      settleResponse(state, event.response, events);
      state.status = "incomplete";
      const details = isObject(event.response) && isObject(event.response.incomplete_details) ? event.response.incomplete_details : {};
      const reason = str(details.reason);
      state.incompleteReason = reason === "max_output_tokens" || reason === "content_filter" ? reason : null;
      break;
    }
    case "response.failed":
      state.status = "failed";
      state.error = errorOf(isObject(event.response) ? event.response.error : null, "The model could not complete this turn.");
      break;
    case "error":
      state.status = "failed";
      state.error = errorOf(isObject(event.error) ? event.error : event, "The model could not complete this turn.");
      break;
    default:
      break;
  }
  return events;
}

/** Close whatever the stream left open (a dropped connection, a provider that omits `done` events). */
export function closeOpenItems(state: TurnState): AgAiEvent[] {
  const events: AgAiEvent[] = [];
  for (const id of state.order) {
    const draft = state.drafts.get(id);
    if (!draft?.open) continue;
    draft.open = false;
    events.push(draft.kind === "message" ? { type: "TEXT_MESSAGE_END", messageId: draft.id } : { type: "TOOL_CALL_END", toolCallId: draft.callId });
  }
  return events;
}

/** The consolidated response the agent loop acts on: messages to keep, tool calls to execute. */
export function finishTurn(state: TurnState): AgLlmResponse {
  const output: AgAiOutputItem[] = [];
  for (const id of state.order) {
    const draft = state.drafts.get(id);
    if (!draft) continue;
    if (draft.kind === "message") {
      if (draft.text.length === 0) continue;
      output.push({
        id: draft.id,
        kind: "output",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "text", text: draft.text, annotations: [] }],
      });
    } else {
      output.push({
        id: draft.id,
        kind: "output",
        type: "function_call",
        callId: draft.callId,
        name: draft.name,
        arguments: draft.args.length > 0 ? draft.args : "{}",
        status: "completed",
      });
    }
  }
  // A stream that ended without a terminal event still succeeded if it produced something.
  const status = state.status === "in_progress" ? (output.length > 0 ? "completed" : "failed") : state.status;
  const response: AgLlmResponse = {
    id: state.responseId ?? `resp-${state.createdAt}`,
    createdAt: state.createdAt,
    output,
    status,
  };
  if (status === "failed") response.error = state.error ?? { code: "empty_response", message: "The model returned nothing. Try again." };
  if (state.incompleteReason !== null) response.incompleteDetails = { reason: state.incompleteReason };
  if (state.usage !== null) response.usage = state.usage;
  if (state.model !== null) response.model = state.model;
  return response;
}

/* -------------------------------------------------------------------------- */
/*  Server-sent events                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Incremental SSE decoder: feed it text as it arrives and it returns the complete `data:`
 * payloads, keeping any unfinished event for the next call. Comments, `event:` lines and the
 * `[DONE]` sentinel are dropped; an event's data may span several `data:` lines.
 */
export function createSseDecoder(): { push(chunk: string): string[]; flush(): string[] } {
  let buffer = "";
  const take = (final: boolean): string[] => {
    const payloads: string[] = [];
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = final ? "" : (blocks.pop() ?? "");
    for (const block of blocks) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data.length > 0 && data !== "[DONE]") payloads.push(data);
    }
    return payloads;
  };
  return {
    push(chunk) {
      buffer += chunk;
      return take(false);
    },
    flush: () => take(true),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Transport                                                                  */
/* -------------------------------------------------------------------------- */

/** What a failed HTTP exchange with PACT's proxy means, in words fit for the chat panel. */
export function describeProxyFailure(status: number, body: unknown, retryAfter: string | null): AgLlmResponseError {
  const error = isObject(body) && isObject(body.error) ? body.error : {};
  const code = str(error.code) ?? `http_${status}`;
  const requestId = str(error.requestId);
  const reference = requestId === null ? "" : ` (request ${requestId})`;
  if (status === 429) {
    const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    const wait = Number.isFinite(seconds) && seconds > 0 ? ` Try again in ${Math.ceil(seconds)} s.` : " Try again shortly.";
    return { code, message: `The agents are rate limited for this session.${wait}` };
  }
  if (status === 503) return { code, message: `${str(error.message) ?? "The agents are unavailable right now."}${reference}` };
  if (status === 403) return { code, message: `This request was not allowed.${reference}` };
  return { code, message: `${str(error.message) ?? `The agent endpoint answered ${status}.`}${reference}` };
}

export interface OpsLlmAdapterOptions {
  /** PACT's proxy route. */
  endpoint: string;
  /** Model used when the chat offers no model choice. The proxy has the final say. */
  defaultModel: string;
  /** Replaceable for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function failed(state: TurnState, error: AgLlmResponseError): AgLlmResponse {
  state.status = "failed";
  state.error = error;
  return finishTurn(state);
}

/**
 * Build the adapter. As in AG's documented adapter, the request is made lazily by the stream's
 * iterator, and `complete` settles once the stream has been read to its end.
 */
export function createOpsLlmAdapter(options: OpsLlmAdapterOptions): AgLlmAdapter {
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const now = options.now ?? (() => Date.now());

  return {
    executeTurn(request, turn) {
      let settle: (response: AgLlmResponse) => void = () => undefined;
      const complete = new Promise<AgLlmResponse>((resolve) => {
        settle = resolve;
      });
      const state = createTurnState(now());
      let started = false;

      async function* read(): AsyncGenerator<AgAiEvent> {
        // A second iteration must not send the turn again.
        if (started) return;
        started = true;
        let result: AgLlmResponse | null = null;
        try {
          let response: Response;
          try {
            response = await fetchImpl(options.endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
              body: JSON.stringify(toResponsesBody(request, options.defaultModel)),
              credentials: "same-origin",
              cache: "no-store",
              signal: turn?.signal,
            });
          } catch {
            result = turn?.signal?.aborted
              ? { ...finishTurn(state), status: "cancelled" }
              : failed(state, { code: "network", message: "Could not reach the agent endpoint. Check your connection and try again." });
            return;
          }

          if (!response.ok) {
            result = failed(state, describeProxyFailure(response.status, parseJson(await response.text()), response.headers.get("retry-after")));
            return;
          }

          const contentType = response.headers.get("content-type") ?? "";
          if (!contentType.includes("text/event-stream") || response.body === null) {
            // A provider that answers in one piece: the whole response is the only "event".
            yield* applyResponsesEvent(state, { type: "response.completed", response: parseJson(await response.text()) });
          } else {
            const decoder = createSseDecoder();
            const text = new TextDecoder();
            const reader = response.body.getReader();
            try {
              for (;;) {
                const { done, value } = await reader.read();
                const payloads = done ? decoder.flush() : decoder.push(text.decode(value, { stream: true }));
                for (const payload of payloads) yield* applyResponsesEvent(state, parseJson(payload));
                if (done) break;
              }
            } finally {
              reader.releaseLock();
            }
          }
          yield* closeOpenItems(state);
          result = finishTurn(state);
        } catch {
          // The stream broke mid-turn (connection lost, or the run was cancelled).
          result = turn?.signal?.aborted
            ? { ...finishTurn(state), status: "cancelled" }
            : failed(state, { code: "stream_interrupted", message: "The connection to the agent was interrupted. Try again." });
        } finally {
          // Also reached when the consumer stops reading early: `complete` must never hang.
          settle(result ?? { ...finishTurn(state), status: "cancelled" });
        }
      }

      return { stream: { [Symbol.asyncIterator]: () => read() }, complete };
    },
  };
}
