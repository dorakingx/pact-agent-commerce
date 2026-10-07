/**
 * /api/ops/ai — the LLM proxy behind the Operations dashboard's AG Studio agents.
 *
 * Studio's agent loop runs in the browser and needs a model to talk to; the credentials for one
 * must not. This route is the only thing the browser can reach: it accepts an OpenAI
 * Responses-format request, rebuilds it from an allow-list of fields, and forwards it to the
 * Vercel AI Gateway with PACT's own credentials. The provider's answer (JSON or a server-sent
 * event stream) is passed straight back.
 *
 * What the caller cannot do through it:
 *  - choose a model outside OPS_AI_MODELS (anything else is answered by the default model);
 *  - send credentials, provider-hosted tools, stored conversations or unknown options
 *    (only the fields listed in `upstreamBody` are forwarded);
 *  - ask for more than MAX_OUTPUT_TOKENS, send more than MAX_BODY_BYTES, or wait longer than
 *    UPSTREAM_TIMEOUT_MS;
 *  - call it cross-site, or more than 30 times in ten minutes per session.
 *
 * Request bodies are prompts and dashboard data: they are never logged. The tools an agent calls
 * run in the browser against PACT's public API with the visitor's own session, so this route
 * grants no capability beyond text generation.
 */
import { getVercelOidcToken } from "@vercel/functions/oidc";
import { getAiMode } from "@/lib/config";
import {
  OPS_AI_DEFAULT_MODEL,
  OPS_AI_MODELS,
  OPS_AI_RATE_LIMIT,
  OPS_AI_UNAVAILABLE_MESSAGE,
  isOpsAiModel,
  type OpsAiStatus,
  type OpsAiUnavailableReason,
} from "@/lib/client/studio-ai-contract";
import { log } from "@/lib/observability/logger";
import { getServiceContext } from "@/lib/services/context";
import { invalid, unavailable } from "@/lib/services/errors";
import { clientKey, json, readBodyText, route } from "@/lib/services/http";
import { UNKNOWN_CLIENT, enforceRule, type RateLimitRule } from "@/lib/services/rate-limit";
import { ensureSession } from "@/lib/services/session";

/** The upstream call is capped at 55 s; the remainder covers the session, the rate limit and the handshake. */
export const maxDuration = 60;

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/responses";
const UPSTREAM_TIMEOUT_MS = 55_000;
/** A turn carries the conversation, the instructions and every tool schema: large, but bounded. */
const MAX_BODY_BYTES = 400_000;
/** Enough for a tool call with a full widget configuration or a few paragraphs of answer. */
const MAX_OUTPUT_TOKENS = 4_096;
const PROVIDER_MESSAGE_CHARS = 300;

const SESSION_LIMIT: RateLimitRule = { scope: "ops-ai", ...OPS_AI_RATE_LIMIT };
/** A session is free to obtain, a network address is not: eight sessions' worth per address per hour. */
const CLIENT_LIMIT: RateLimitRule = { scope: "ops-ai-client", limit: 240, windowSeconds: 3600 };

/** Reasoning effort the dashboard may ask for. Latency matters more than depth for these tasks. */
const EFFORTS = new Set(["minimal", "low", "medium"]);
const DEFAULT_EFFORT = "low";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* -------------------------------------------------------------------------- */
/*  Availability                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The gateway credential: an explicit API key when one is configured, otherwise the deployment's
 * OIDC token (Vercel injects it per request; locally it comes from VERCEL_OIDC_TOKEN). Null when
 * neither exists — the caller then reports the agents as unavailable instead of failing a turn.
 */
async function gatewayToken(): Promise<string | null> {
  const key = process.env.AI_GATEWAY_API_KEY?.trim();
  if (key) return key;
  try {
    const token = await getVercelOidcToken();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

async function unavailableReason(): Promise<{ reason: OpsAiUnavailableReason; token: null } | { reason: null; token: string }> {
  if (getAiMode() === "scripted") return { reason: "scripted", token: null };
  const token = await gatewayToken();
  return token === null ? { reason: "no_credentials", token: null } : { reason: null, token };
}

/** GET: can the agents run here, and on which models? Starts no session and calls no model. */
export const GET = route("ops.ai.status", async () => {
  const { reason } = await unavailableReason();
  const status: OpsAiStatus = {
    available: reason === null,
    reason,
    message: reason === null ? null : OPS_AI_UNAVAILABLE_MESSAGE[reason],
    models: OPS_AI_MODELS,
    defaultModel: OPS_AI_DEFAULT_MODEL,
  };
  return json(status);
});

/* -------------------------------------------------------------------------- */
/*  Request                                                                    */
/* -------------------------------------------------------------------------- */

/** The request as a JSON object, read with a hard cap that is enforced while reading. */
async function readCappedJson(request: Request): Promise<JsonObject> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) throw invalid("Content-Type must be application/json");
  const text = await readBodyText(request, MAX_BODY_BYTES);
  if (text === null) throw invalid("Request body is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid("Request body is not valid JSON");
  }
  if (!isObject(parsed)) throw invalid("Request body must be a JSON object");
  return parsed;
}

/** Function tools only: a provider-hosted tool (web search, code execution) would run at PACT's expense. */
function functionTools(tools: unknown): JsonObject[] {
  if (!Array.isArray(tools)) return [];
  return tools.filter((tool): tool is JsonObject => isObject(tool) && tool.type === "function" && typeof tool.name === "string");
}

function toolChoice(choice: unknown): unknown {
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  if (isObject(choice) && choice.type === "function" && typeof choice.name === "string") return { type: "function", name: choice.name };
  return undefined;
}

function outputTokens(requested: unknown): number {
  const wanted = typeof requested === "number" && Number.isInteger(requested) && requested > 0 ? requested : MAX_OUTPUT_TOKENS;
  return Math.min(wanted, MAX_OUTPUT_TOKENS);
}

function reasoning(requested: unknown): { effort: string } {
  const effort = isObject(requested) && typeof requested.effort === "string" && EFFORTS.has(requested.effort) ? requested.effort : DEFAULT_EFFORT;
  return { effort };
}

/**
 * The body sent upstream, built field by field from what the client sent. Anything not named
 * here — credentials, `previous_response_id`, `metadata`, provider options — is left behind.
 */
function upstreamBody(client: JsonObject): JsonObject {
  if (!Array.isArray(client.input) && typeof client.input !== "string") throw invalid("`input` is required");
  const body: JsonObject = {
    model: isOpsAiModel(client.model) ? client.model : OPS_AI_DEFAULT_MODEL,
    input: client.input,
    stream: client.stream !== false,
    // Conversations live in the browser; nothing is kept at the provider.
    store: false,
    max_output_tokens: outputTokens(client.max_output_tokens),
    reasoning: reasoning(client.reasoning),
  };
  if (typeof client.instructions === "string") body.instructions = client.instructions;
  const tools = functionTools(client.tools);
  if (tools.length > 0) {
    body.tools = tools;
    const choice = toolChoice(client.tool_choice);
    if (choice !== undefined) body.tool_choice = choice;
  }
  if (isObject(client.text) && isObject(client.text.format)) body.text = { format: client.text.format };
  return body;
}

/* -------------------------------------------------------------------------- */
/*  Upstream                                                                   */
/* -------------------------------------------------------------------------- */

/** The provider's own error sentence, shortened: useful to a developer, and it describes only our request. */
async function providerMessage(response: Response): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await response.text());
    const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : parsed;
    const message = isObject(error) && typeof error.message === "string" ? error.message : null;
    return message === null ? null : message.slice(0, PROVIDER_MESSAGE_CHARS);
  } catch {
    return null;
  }
}

export const POST = route("ops.ai", async (request, _context: unknown, { requestId }) => {
  const { reason, token } = await unavailableReason();
  if (reason !== null) throw unavailable(OPS_AI_UNAVAILABLE_MESSAGE[reason]);

  const ctx = await getServiceContext();
  // Per address first: a client that drops its cookie gets a new session, and a new session budget, every time.
  await enforceRule(ctx, CLIENT_LIMIT, clientKey(request) ?? UNKNOWN_CLIENT);
  await enforceRule(ctx, SESSION_LIMIT, await ensureSession());

  const body = upstreamBody(await readCappedJson(request));
  const streaming = body.stream === true;
  const started = Date.now();

  let upstream: Response;
  try {
    upstream = await fetch(GATEWAY_URL, {
      method: "POST",
      // Built from scratch: nothing the client sent as a header travels upstream.
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: streaming ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(body),
      // The timeout covers the whole exchange, including a stream that stalls half-way.
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
      cache: "no-store",
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    log.warn("ops.ai.upstream_unreachable", { requestId, model: body.model, timedOut, latencyMs: Date.now() - started });
    throw unavailable(timedOut ? "The AI provider did not answer in time. Try again." : "The AI provider could not be reached. Try again.");
  }

  log.info("ops.ai", { requestId, model: body.model, streaming, upstreamStatus: upstream.status, latencyMs: Date.now() - started });

  if (!upstream.ok) {
    const detail = await providerMessage(upstream);
    log.warn("ops.ai.upstream_error", { requestId, model: body.model, upstreamStatus: upstream.status, detail });
    throw unavailable(
      upstream.status === 429
        ? "The AI provider is rate limiting PACT right now. Try again in a moment."
        : `The AI provider could not answer this request (${upstream.status}).${detail === null ? "" : ` ${detail}`}`,
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? (streaming ? "text/event-stream" : "application/json"),
      "Cache-Control": "no-store, no-transform",
      // Proxies must not buffer a token stream.
      "X-Accel-Buffering": "no",
    },
  });
});
