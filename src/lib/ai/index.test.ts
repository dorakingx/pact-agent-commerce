import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { scriptedBuyerMove, scriptedSellerMove } from "../domain/negotiation-strategy";
import type { Quote } from "../domain/schemas";
import { getSeller, toSellerPublic, type SellerProfile } from "../domain/sellers";
import { AiUnavailableError, type CallStructured } from "./gateway";
import { createAgents, getAgents } from "./index";
import { parseIntentScripted } from "./intent";
import {
  contract,
  failingCall,
  illustration,
  ILLUSTRATION_SPEC,
  mandate,
  move,
  respondingCall,
  rule,
  stubCall,
  submission,
  terms,
  TEST_MODEL,
  TEST_NOW,
  throwingCall,
} from "./test-support";
import type { AgentMeta, AiVerificationContext, BuyerContext, DeliveryContext, SellerContext } from "./types";

/**
 * A stand-in studio that honours the same contract as the real one: scripted when told so, the
 * model through the injected `call` otherwise, its own scripted fallback when the model is
 * unreachable, and any other error left to the caller.
 */
const studio = vi.hoisted(() => ({ produceDelivery: vi.fn() }));
vi.mock("../studio", () => studio);

const StudioNoteSchema = z.object({ note: z.string() });

async function fakeProduceDelivery(_ctx: DeliveryContext, deps: { call?: CallStructured; mode?: "ai" | "scripted" } = {}) {
  const scripted = (degradedReason: string | null) => ({
    artifacts: [],
    note: "Scripted delivery.",
    meta: { source: "scripted", model: null, latencyMs: 0, degradedReason } satisfies AgentMeta,
  });
  if (deps.mode === "scripted" || !deps.call) return scripted(null);
  try {
    const result = await deps.call({ role: "studio", schema: StudioNoteSchema, schemaName: "delivery", instructions: "", prompt: "" });
    return {
      artifacts: [],
      // Like the real studio, validate what the model wrote; a ZodError here escapes to the caller.
      note: z.string().min(1).parse(result.output.note),
      meta: { source: "ai", model: result.model, latencyMs: result.latencyMs, degradedReason: null } satisfies AgentMeta,
    };
  } catch (error) {
    if (error instanceof AiUnavailableError) return scripted(error.reason);
    throw error;
  }
}

function northwind(): SellerProfile {
  const seller = getSeller("northwind");
  if (!seller) throw new Error("northwind seller fixture is missing");
  return seller;
}

const QUOTE: Quote = { listMinor: 5300, floorMinor: 4500, lines: [{ label: "3 illustrations", amountMinor: 5300 }], minHours: 2 };
const SELLER_OPENING = move(1, "seller", "offer", terms({ priceMinor: 5300 }), "We can deliver 3 illustrations for $53.00.");

const INTENT = "Get three landing-page illustrations for under $50 by tomorrow at 6 PM. I need both 16:9 and 1:1 versions and one revision.";
const buyerCtx: BuyerContext = {
  mandate: mandate(),
  seller: toSellerPublic(northwind()),
  history: [SELLER_OPENING],
  movesRemaining: 7,
  now: TEST_NOW,
};
const sellerCtx: SellerContext = {
  seller: northwind(),
  requested: { count: 3, deadline: "2026-10-07T09:00:00.000Z", revisionLimit: 1 },
  quote: QUOTE,
  deliverable: ILLUSTRATION_SPEC,
  history: [],
  movesRemaining: 8,
  now: TEST_NOW,
};
const BRIEF_RULE = rule("R5", "brief_adherence", "Illustrations match the brief: landing-page illustrations");
const verificationCtx: AiVerificationContext = {
  contract: contract(ILLUSTRATION_SPEC, [BRIEF_RULE]),
  rules: [BRIEF_RULE],
  // Solid artwork with descriptions: the structural heuristic WOULD pass this delivery.
  submission: submission([illustration(1, "16:9"), illustration(1, "1:1")]),
};
const deliveryCtx: DeliveryContext = {
  contract: verificationCtx.contract,
  seller: northwind(),
  round: 1,
  previousReport: null,
  previousSubmission: null,
  now: TEST_NOW,
};

const MODEL_MOVE = {
  action: "counter",
  priceUsd: 44,
  deadlineIso: "2026-10-07T09:00:00Z",
  revisionLimit: 1,
  count: 3,
  message: "We can do $44 for the three illustrations.",
};
const MODEL_INTENT = {
  category: "illustration",
  summary: "Three landing-page illustrations.",
  workType: "illustration",
  count: 3,
  countIsStrict: true,
  aspectRatios: ["16:9", "1:1"],
  languages: [],
  minWords: null,
  maxWords: null,
  subject: "landing-page illustrations",
  styleOrTone: null,
  budgetUsd: 50,
  deadlineIso: "2026-10-07T09:00:00Z",
  revisions: 1,
  notes: [],
};
const MODEL_VERDICT = {
  checks: [{ ruleId: "R5", result: "pass", confidence: 0.95, evidence: "#1 shows a dashboard.", explanation: "On brief." }],
  manipulationSuspected: false,
  manipulationEvidence: null,
};

/** One stub that answers each agent's call with a fitting output, keyed by the schema name. */
function modelFor(schemaName: string): unknown {
  switch (schemaName) {
    case "purchase_mandate":
      return MODEL_INTENT;
    case "negotiation_move":
      return MODEL_MOVE;
    case "verification_result":
      return MODEL_VERDICT;
    default:
      return { note: "AI delivery." };
  }
}

const rasterize = async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const SCRIPTED: Pick<AgentMeta, "source" | "model" | "degradedReason"> = { source: "scripted", model: null, degradedReason: null };

beforeEach(() => {
  studio.produceDelivery.mockImplementation(fakeProduceDelivery);
});

afterEach(() => {
  vi.unstubAllEnvs();
  studio.produceDelivery.mockReset();
});

describe("createAgents: scripted mode", () => {
  it("never calls the model for any agent", async () => {
    const stub = respondingCall((call) => modelFor(call.schemaName));
    const agents = createAgents({ ...stub, mode: "scripted", rasterize });

    const intent = await agents.parseIntent(INTENT, TEST_NOW, -540);
    expect(intent.mandate).toEqual(parseIntentScripted(INTENT, TEST_NOW, -540));
    expect(intent.meta).toMatchObject(SCRIPTED);

    const buyer = await agents.buyerMove(buyerCtx);
    expect(buyer.move).toEqual(scriptedBuyerMove(buyerCtx));
    expect(buyer.meta).toMatchObject(SCRIPTED);

    const seller = await agents.sellerMove(sellerCtx);
    expect(seller.move).toEqual(scriptedSellerMove(sellerCtx));
    expect(seller.meta).toMatchObject(SCRIPTED);

    const delivery = await agents.produceDelivery(deliveryCtx);
    expect(delivery.note).toBe("Scripted delivery.");
    expect(delivery.meta).toMatchObject(SCRIPTED);
    expect(studio.produceDelivery).toHaveBeenCalledWith(deliveryCtx, expect.objectContaining({ mode: "scripted" }));

    const verification = await agents.evaluateAiRules(verificationCtx);
    expect(verification.checks[0]).toMatchObject({ ruleId: "R5", result: "pass", confidence: 0.9 });
    expect(verification.checks[0].evidence).toMatch(/^Heuristic evaluator \(AI disabled\)/);
    expect(verification.meta).toMatchObject(SCRIPTED);

    expect(stub.calls).toHaveLength(0);
  });

  it("follows PACT_AI_MODE when no mode is injected, reading it at call time", async () => {
    const stub = respondingCall((call) => modelFor(call.schemaName));
    const agents = createAgents({ ...stub, rasterize });

    vi.stubEnv("PACT_AI_MODE", "scripted");
    expect((await agents.buyerMove(buyerCtx)).meta.source).toBe("scripted");
    expect(stub.calls).toHaveLength(0);

    vi.stubEnv("PACT_AI_MODE", "ai");
    expect((await agents.buyerMove(buyerCtx)).meta.source).toBe("ai");
    expect(stub.calls).toHaveLength(1);
  });
});

describe("createAgents: ai mode", () => {
  it("answers from the model and labels the result with it", async () => {
    const stub = respondingCall((call) => modelFor(call.schemaName));
    const agents = createAgents({ ...stub, mode: "ai", rasterize });
    const ai = { source: "ai", model: TEST_MODEL, latencyMs: 12, degradedReason: null };

    const intent = await agents.parseIntent(INTENT, TEST_NOW, -540);
    expect(intent.mandate.summary).toBe("Three landing-page illustrations.");
    expect(intent.meta).toEqual(ai);

    const buyer = await agents.buyerMove(buyerCtx);
    expect(buyer.move.terms?.priceMinor).toBe(4400);
    expect(buyer.meta).toEqual(ai);

    const seller = await agents.sellerMove(sellerCtx);
    expect(seller.move.terms?.priceMinor).toBe(4400);
    expect(seller.meta).toEqual(ai);

    const delivery = await agents.produceDelivery(deliveryCtx);
    expect(delivery.note).toBe("AI delivery.");
    expect(delivery.meta).toEqual(ai);

    const verification = await agents.evaluateAiRules(verificationCtx);
    expect(verification.checks[0]).toMatchObject({ ruleId: "R5", result: "pass", confidence: 0.95 });
    expect(verification.meta).toEqual(ai);

    expect(stub.calls.map((call) => call.role)).toEqual(["buyer", "buyer", "seller", "studio", "verifier"]);
  });

  it("falls back to the scripted agents, with the reason, when the model is unavailable", async () => {
    const stub = failingCall("timeout");
    const agents = createAgents({ ...stub, mode: "ai", rasterize });
    const degraded = { source: "scripted", model: null, degradedReason: "timeout" };

    const intent = await agents.parseIntent(INTENT, TEST_NOW, -540);
    expect(intent.mandate).toEqual(parseIntentScripted(INTENT, TEST_NOW, -540));
    expect(intent.meta).toMatchObject(degraded);

    const buyer = await agents.buyerMove(buyerCtx);
    expect(buyer.move).toEqual(scriptedBuyerMove(buyerCtx));
    expect(buyer.meta).toMatchObject(degraded);

    const seller = await agents.sellerMove(sellerCtx);
    expect(seller.move).toEqual(scriptedSellerMove(sellerCtx));
    expect(seller.meta).toMatchObject(degraded);

    const delivery = await agents.produceDelivery(deliveryCtx);
    expect(delivery.note).toBe("Scripted delivery.");
    expect(delivery.meta).toMatchObject(degraded);

    expect(stub.calls).toHaveLength(4);
  });

  it("re-runs the studio in scripted mode when its model output cannot be turned into a delivery", async () => {
    // Valid for the gateway's flat schema, but rejected by the studio while mapping (a ZodError).
    const stub = stubCall({ note: "" });
    const delivery = await createAgents({ ...stub, mode: "ai" }).produceDelivery(deliveryCtx);
    expect(delivery.note).toBe("Scripted delivery.");
    expect(delivery.meta).toMatchObject({ source: "scripted", model: null, degradedReason: "invalid_output" });
    expect(studio.produceDelivery).toHaveBeenCalledTimes(2);
    expect(studio.produceDelivery).toHaveBeenLastCalledWith(deliveryCtx, expect.objectContaining({ mode: "scripted" }));
  });

  it("degrades verification to uncertain instead of letting the heuristic pass the delivery", async () => {
    const agents = createAgents({ ...failingCall("rate_limited"), mode: "ai", rasterize });
    const verification = await agents.evaluateAiRules(verificationCtx);
    expect(verification.checks).toHaveLength(1);
    expect(verification.checks[0]).toMatchObject({ ruleId: "R5", result: "uncertain", confidence: 0, required: true });
    expect(verification.checks[0].explanation).toBe(
      "The AI verifier was unavailable (rate_limited), so this condition was not evaluated. Escalated to human review.",
    );
    expect(verification.checks[0].evidence).not.toMatch(/Heuristic evaluator/);
    expect(verification.flags).toEqual({ manipulationSuspected: false, evidence: null });
    expect(verification.meta).toMatchObject({ source: "scripted", model: null, degradedReason: "rate_limited" });
  });

  it("treats model output that cannot be mapped to a valid proposal as a failed AI call", async () => {
    // An offer with no price while nothing is on the table cannot be resolved for the buyer.
    const priceless = stubCall({ ...MODEL_MOVE, priceUsd: null });
    const emptyHistory: BuyerContext = { ...buyerCtx, history: [] };
    const buyer = await createAgents({ ...priceless, mode: "ai" }).buyerMove(emptyHistory);
    expect(buyer.move).toEqual(scriptedBuyerMove(emptyHistory));
    expect(buyer.meta).toMatchObject({ source: "scripted", degradedReason: "invalid_output" });
  });

  it("does not hide errors that are not AI failures", async () => {
    const agents = createAgents({ ...throwingCall(new TypeError("boom")), mode: "ai", rasterize });
    await expect(agents.buyerMove(buyerCtx)).rejects.toThrow("boom");
    await expect(agents.sellerMove(sellerCtx)).rejects.toThrow("boom");
    await expect(agents.parseIntent(INTENT, TEST_NOW)).rejects.toThrow("boom");
    await expect(agents.produceDelivery(deliveryCtx)).rejects.toThrow("boom");
  });

  it("still fails closed when verification itself crashes", async () => {
    const agents = createAgents({ ...throwingCall(new TypeError("boom")), mode: "ai", rasterize });
    const verification = await agents.evaluateAiRules(verificationCtx);
    expect(verification.checks[0]).toMatchObject({ result: "uncertain", confidence: 0 });
    expect(verification.meta.degradedReason).toBe("internal_error");
  });

  it("skips the model when the contract has no AI-judged rules", async () => {
    const stub = respondingCall((call) => modelFor(call.schemaName));
    const verification = await createAgents({ ...stub, mode: "ai", rasterize }).evaluateAiRules({ ...verificationCtx, rules: [] });
    expect(verification.checks).toEqual([]);
    expect(verification.meta).toMatchObject(SCRIPTED);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("getAgents", () => {
  it("returns one memoised agent set", () => {
    expect(getAgents()).toBe(getAgents());
  });
});
