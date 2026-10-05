/**
 * The only place PACT talks to a language model.
 *
 * Every call is a schema-constrained structured generation through the Vercel AI Gateway
 * (AI SDK). Callers get back a value that has ALREADY been validated against their Zod
 * schema, or an AiUnavailableError — never free text, never a partially valid object.
 *
 * Models can be slow or unavailable; that must never take the product down. Each call has a
 * hard timeout and a gateway-level model fallback, and callers are expected to catch
 * AiUnavailableError and degrade transparently (scripted agent / human review).
 */
import "server-only";
import { APICallError, generateText, NoObjectGeneratedError, Output, type ModelMessage } from "ai";
import type { z } from "zod";
import { getAiMode, getModelConfig } from "../config";
import { log } from "../observability/logger";

export type AgentRole = "buyer" | "seller" | "verifier" | "studio" | "ops";

export type AiFailureReason = "disabled" | "timeout" | "rate_limited" | "auth" | "invalid_output" | "provider_error";

export class AiUnavailableError extends Error {
  constructor(
    public readonly reason: AiFailureReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AiUnavailableError";
  }
}

export interface StructuredCall<T> {
  role: AgentRole;
  schema: z.ZodType<T>;
  /** Short identifier for the output object, e.g. "negotiation_move". */
  schemaName: string;
  /** System-level instructions. Untrusted text must go in `prompt`/`messages`, never here. */
  instructions: string;
  prompt?: string;
  messages?: ModelMessage[];
  /** Hard wall-clock limit for the whole call, including fallbacks. Default 25s. */
  timeoutMs?: number;
  maxOutputTokens?: number;
  /** Correlation fields for logs (dealId etc.). */
  logFields?: Record<string, unknown>;
}

export interface StructuredResult<T> {
  output: T;
  /** Gateway model id that produced the output. */
  model: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number };
}

export type CallStructured = <T>(call: StructuredCall<T>) => Promise<StructuredResult<T>>;

const DEFAULT_TIMEOUT_MS = 25_000;

function modelFor(role: AgentRole): string {
  return getModelConfig()[role];
}

/**
 * Latency matters for a live negotiation, and none of these tasks needs deep reasoning:
 * ask each provider for its cheapest thinking mode.
 */
const PROVIDER_SPEED_OPTIONS = {
  openai: { reasoningEffort: "minimal" },
  google: { thinkingConfig: { thinkingBudget: 0 } },
} as const;

function classify(error: unknown): AiFailureReason {
  if (NoObjectGeneratedError.isInstance(error)) return "invalid_output";
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "AbortError" || name === "TimeoutError" || /timed? ?out|aborted/i.test(message)) return "timeout";
  if (/RateLimit/i.test(name) || /rate limit|429/i.test(message)) return "rate_limited";
  if (/Authentication|Forbidden/i.test(name) || /401|403|unauthori[sz]ed|oidc|api key/i.test(message)) return "auth";
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 429) return "rate_limited";
    if (error.statusCode === 401 || error.statusCode === 403) return "auth";
  }
  return "provider_error";
}

/**
 * Run one schema-constrained generation. Throws AiUnavailableError on any failure.
 */
export const callStructured: CallStructured = async <T>(call: StructuredCall<T>): Promise<StructuredResult<T>> => {
  if (getAiMode() === "scripted") {
    throw new AiUnavailableError("disabled", "AI is disabled (PACT_AI_MODE=scripted)");
  }
  const primary = modelFor(call.role);
  const fallbacks = getModelConfig().fallbacks.filter((m) => m !== primary);
  const started = Date.now();
  try {
    const result = await generateText({
      model: primary,
      instructions: call.instructions,
      ...(call.messages ? { messages: call.messages } : { prompt: call.prompt ?? "" }),
      output: Output.object({ schema: call.schema, name: call.schemaName }),
      maxRetries: 1,
      timeout: { totalMs: call.timeoutMs ?? DEFAULT_TIMEOUT_MS },
      ...(call.maxOutputTokens ? { maxOutputTokens: call.maxOutputTokens } : {}),
      providerOptions: {
        gateway: { models: fallbacks },
        ...PROVIDER_SPEED_OPTIONS,
      },
    });
    const latencyMs = Date.now() - started;
    const model = result.response?.modelId ? normaliseModelId(result.response.modelId, primary) : primary;
    log.info("ai.call", {
      role: call.role,
      schema: call.schemaName,
      model,
      latencyMs,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      ...call.logFields,
    });
    return {
      output: result.output as T,
      model,
      latencyMs,
      usage: { inputTokens: result.usage?.inputTokens ?? 0, outputTokens: result.usage?.outputTokens ?? 0 },
    };
  } catch (error) {
    const reason = classify(error);
    log.warn("ai.call_failed", {
      role: call.role,
      schema: call.schemaName,
      model: primary,
      reason,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error).slice(0, 300),
      ...call.logFields,
    });
    throw new AiUnavailableError(reason, `AI call failed (${reason})`, { cause: error });
  }
};

/** The gateway reports provider-native ids ("gemini-2.5-flash"); keep the "creator/model" form for display. */
function normaliseModelId(reported: string, primary: string): string {
  if (reported.includes("/")) return reported;
  const all = [primary, ...getModelConfig().fallbacks];
  return all.find((m) => m.endsWith(`/${reported}`) || reported.startsWith(m.split("/")[1] ?? "\u0000")) ?? primary;
}
