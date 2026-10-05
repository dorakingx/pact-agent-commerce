/**
 * The agent set handed to the deterministic core.
 *
 * `createAgents` wires each agent to its AI implementation and its deterministic stand-in and
 * decides, per call, which one answers:
 *
 *  - scripted mode (PACT_AI_MODE=scripted, or `mode: "scripted"`): no model is ever called.
 *  - ai mode: the model is tried first. If it is unavailable, or its output cannot be mapped to
 *    a valid domain object, the scripted agent answers instead and the result is labelled with
 *    `meta.degradedReason`, so the product keeps moving and the UI can say what happened.
 *
 * The verifier is the one exception to "fall back to scripted". A failed AI verification is
 * reported as "uncertain" on every AI rule (human review); the structural heuristic is never
 * allowed to pass a delivery on the model's behalf.
 */
import "server-only";
import { ZodError } from "zod";
import { getAiMode, type AiMode } from "../config";
import { scriptedBuyerMove, scriptedSellerMove } from "../domain/negotiation-strategy";
import { log } from "../observability/logger";
import { produceDelivery } from "../studio";
import { AiUnavailableError, callStructured, type CallStructured } from "./gateway";
import { parseIntentAi, parseIntentScripted } from "./intent";
import { buyerMoveAi, sellerMoveAi } from "./negotiators";
import { AgentOutputError } from "./shared";
import type { AgentMeta, Agents, AiVerificationFlags } from "./types";
import { degradedChecks, evaluateAiRulesAi, evaluateAiRulesHeuristic, type VerifierDeps } from "./verifier";

export interface AgentsDeps extends VerifierDeps {
  /** Overrides PACT_AI_MODE. Tests use it to exercise both paths without touching the environment. */
  mode?: AiMode;
}

const NO_MANIPULATION: AiVerificationFlags = { manipulationSuspected: false, evidence: null };

/** Handed to the studio in scripted mode: even a studio that ignored the mode could not reach a model. */
const disabledCall: CallStructured = async () => {
  throw new AiUnavailableError("disabled", "AI is disabled for this agent set (scripted mode)");
};

/**
 * Why an AI attempt may be replaced by the scripted agent, or null when the error is not an AI
 * failure at all (a bug, a broken invariant) and must surface instead of being papered over.
 */
function degradedReasonOf(error: unknown): string | null {
  if (error instanceof AiUnavailableError) return error.reason;
  if (error instanceof ZodError || error instanceof AgentOutputError) return "invalid_output";
  return null;
}

function scriptedMeta(started: number, degradedReason: string | null = null): AgentMeta {
  return { source: "scripted", model: null, latencyMs: Date.now() - started, degradedReason };
}

function aiMeta(result: { model: string; latencyMs: number }): AgentMeta {
  return { source: "ai", model: result.model, latencyMs: result.latencyMs, degradedReason: null };
}

/**
 * Build an agent set. `call` replaces the model gateway (tests inject a stub); `mode` overrides
 * PACT_AI_MODE. Without `mode` the environment is read on every call, never at import time.
 */
export function createAgents(deps: AgentsDeps = {}): Agents {
  const call = deps.call ?? callStructured;
  const isScripted = (): boolean => (deps.mode ?? getAiMode()) === "scripted";

  /** Shared shape of the three agents that have a scripted twin. */
  async function proposeWithFallback<T>(
    agent: string,
    viaAi: () => Promise<{ value: T; model: string; latencyMs: number }>,
    viaScript: () => T,
  ): Promise<{ value: T; meta: AgentMeta }> {
    const started = Date.now();
    if (isScripted()) return { value: viaScript(), meta: scriptedMeta(started) };
    try {
      const result = await viaAi();
      return { value: result.value, meta: aiMeta(result) };
    } catch (error) {
      const reason = degradedReasonOf(error);
      if (reason === null) throw error;
      log.warn("agent.fallback", { agent, reason });
      return { value: viaScript(), meta: scriptedMeta(started, reason) };
    }
  }

  return {
    async parseIntent(intent, now, tzOffsetMinutes) {
      const { value, meta } = await proposeWithFallback(
        "parseIntent",
        async () => {
          const result = await parseIntentAi(intent, now, tzOffsetMinutes, { call });
          return { value: result.mandate, model: result.model, latencyMs: result.latencyMs };
        },
        () => parseIntentScripted(intent, now, tzOffsetMinutes),
      );
      return { mandate: value, meta };
    },

    async buyerMove(ctx) {
      const { value, meta } = await proposeWithFallback(
        "buyerMove",
        async () => {
          const result = await buyerMoveAi(ctx, { call });
          return { value: result.move, model: result.model, latencyMs: result.latencyMs };
        },
        () => scriptedBuyerMove(ctx),
      );
      return { move: value, meta };
    },

    async sellerMove(ctx) {
      const { value, meta } = await proposeWithFallback(
        "sellerMove",
        async () => {
          const result = await sellerMoveAi(ctx, { call });
          return { value: result.move, model: result.model, latencyMs: result.latencyMs };
        },
        () => scriptedSellerMove(ctx),
      );
      return { move: value, meta };
    },

    async produceDelivery(ctx) {
      const started = Date.now();
      // The studio owns its own AI-or-scripted choice and reports it in `meta`; it is told the mode
      // explicitly so that an injected mode is honoured there too.
      if (isScripted()) return produceDelivery(ctx, { call: disabledCall, mode: "scripted" });
      try {
        return await produceDelivery(ctx, { call, mode: "ai" });
      } catch (error) {
        // The studio already absorbs an unreachable model. What can still escape is model output
        // it could not turn into valid artifacts, and that gets the same treatment as elsewhere.
        const reason = degradedReasonOf(error);
        if (reason === null) throw error;
        log.warn("agent.fallback", { agent: "produceDelivery", reason });
        const result = await produceDelivery(ctx, { call: disabledCall, mode: "scripted" });
        return { ...result, meta: scriptedMeta(started, reason) };
      }
    },

    async evaluateAiRules(ctx) {
      const started = Date.now();
      if (ctx.rules.length === 0) return { checks: [], flags: NO_MANIPULATION, meta: scriptedMeta(started) };
      if (isScripted()) return { ...evaluateAiRulesHeuristic(ctx), meta: scriptedMeta(started) };
      try {
        const result = await evaluateAiRulesAi(ctx, { call, rasterize: deps.rasterize });
        return { checks: result.checks, flags: result.flags, meta: aiMeta(result) };
      } catch (error) {
        // Unlike the other agents, ANY failure degrades here: a verification that crashes must
        // end in human review, never in a retry loop and never in a heuristic "pass".
        const reason = degradedReasonOf(error) ?? "internal_error";
        const fields = { agent: "evaluateAiRules", reason, dealId: ctx.contract.dealId, submissionId: ctx.submission.id };
        if (reason === "internal_error") log.error("agent.verifier_failed", { ...fields, error });
        else log.warn("agent.fallback", fields);
        return { checks: degradedChecks(ctx, reason), flags: NO_MANIPULATION, meta: scriptedMeta(started, reason) };
      }
    },
  };
}

let defaultAgents: Agents | undefined;

/** The process-wide agent set, backed by the real gateway and PACT_AI_MODE. */
export function getAgents(): Agents {
  defaultAgents ??= createAgents();
  return defaultAgents;
}
