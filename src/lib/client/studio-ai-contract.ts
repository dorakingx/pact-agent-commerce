/**
 * The contract between the dashboard's LLM adapter (browser) and PACT's AI proxy route
 * (POST /api/ops/ai). Shared by both sides so the model list a visitor is offered and the
 * allow-list the server enforces cannot drift apart. Nothing here is secret.
 */

export const OPS_AI_ENDPOINT = "/api/ops/ai";

export interface OpsAiModel {
  /** AI Gateway model id, as sent upstream. */
  id: string;
  /** What the model picker shows. */
  label: string;
}

/**
 * The only models the proxy will ever call. A request naming anything else is answered by the
 * default model instead of being refused, so an old client keeps working after a model is retired.
 */
export const OPS_AI_MODELS = [
  { id: "openai/gpt-5-mini", label: "GPT-5 mini" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
] as const satisfies readonly OpsAiModel[];

export type OpsAiModelId = (typeof OPS_AI_MODELS)[number]["id"];

export const OPS_AI_DEFAULT_MODEL: OpsAiModelId = "openai/gpt-5-mini";

export function isOpsAiModel(id: unknown): id is OpsAiModelId {
  return OPS_AI_MODELS.some((model) => model.id === id);
}

/** Requests per session per window. Mirrored in the chat panel's wording. */
export const OPS_AI_RATE_LIMIT = { limit: 30, windowSeconds: 600 } as const;

export type OpsAiUnavailableReason = "scripted" | "no_credentials";

/** GET /api/ops/ai: whether the agents can run on this deployment, and on which models. */
export interface OpsAiStatus {
  available: boolean;
  reason: OpsAiUnavailableReason | null;
  /** One sentence for the visitor when `available` is false. */
  message: string | null;
  models: readonly OpsAiModel[];
  defaultModel: OpsAiModelId;
}

export const OPS_AI_UNAVAILABLE_MESSAGE: Record<OpsAiUnavailableReason, string> = {
  scripted: "The dashboard agents are switched off: this deployment runs scripted agents and calls no model.",
  no_credentials: "The dashboard agents are switched off: no AI Gateway credentials are configured on this deployment.",
};
