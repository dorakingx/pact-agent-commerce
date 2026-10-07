import { describe, expect, it } from "vitest";
import { OPS_AI_DEFAULT_MODEL, OPS_AI_ENDPOINT, OPS_AI_MODELS, OPS_AI_RATE_LIMIT, OPS_AI_UNAVAILABLE_MESSAGE, isOpsAiModel } from "./studio-ai-contract";

describe("the dashboard's AI contract", () => {
  it("allows exactly the listed models, and the default is one of them", () => {
    expect(OPS_AI_MODELS.map((model) => model.id)).toEqual(["openai/gpt-5-mini", "google/gemini-2.5-flash"]);
    expect(isOpsAiModel(OPS_AI_DEFAULT_MODEL)).toBe(true);
    for (const id of ["openai/gpt-5", "gpt-5-mini", "", null, undefined, 5, { id: "openai/gpt-5-mini" }]) expect(isOpsAiModel(id)).toBe(false);
  });

  it("labels every model for the picker", () => {
    for (const model of OPS_AI_MODELS) expect(model.label.length).toBeGreaterThan(3);
    expect(new Set(OPS_AI_MODELS.map((model) => model.label)).size).toBe(OPS_AI_MODELS.length);
  });

  it("is rate limited to thirty requests per ten minutes, on PACT's own route", () => {
    expect(OPS_AI_RATE_LIMIT).toEqual({ limit: 30, windowSeconds: 600 });
    expect(OPS_AI_ENDPOINT).toBe("/api/ops/ai");
  });

  it("explains each reason the agents can be off without naming a secret", () => {
    for (const message of Object.values(OPS_AI_UNAVAILABLE_MESSAGE)) {
      expect(message).toMatch(/^The dashboard agents are switched off: /);
      expect(message).not.toMatch(/AI_GATEWAY_API_KEY|OIDC|token/i);
    }
  });
});
