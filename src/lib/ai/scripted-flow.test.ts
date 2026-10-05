/**
 * The scripted agent set against the REAL domain engines and seller studio (no mocks, no model).
 *
 * This is the path tests, CI and offline demos run on, so it has to hold end to end: the
 * scripted negotiators must reach an agreement the rules engine accepts, and the heuristic
 * verifier must pass exactly the work the scripted studio produces for an honest seller.
 */
import { describe, expect, it } from "vitest";
import { compileContract } from "../domain/contract";
import { applyMove, buyerContextFor, initialNegotiation, nextActor, sellerContextFor } from "../domain/negotiation";
import { SCENARIOS, type Scenario } from "../domain/scenarios";
import { DEFAULT_POLICY, MandateSchema, type NegotiationState, type SignedContract, type Submission } from "../domain/schemas";
import { getSeller, type SellerProfile } from "../domain/sellers";
import type { CallStructured } from "./gateway";
import { createAgents } from "./index";
import { TEST_NOW } from "./test-support";
import type { Agents } from "./types";

const modelMustNotBeCalled: CallStructured = async () => {
  throw new Error("scripted mode reached the model gateway");
};
const agents = createAgents({ call: modelMustNotBeCalled, mode: "scripted" });

function sellerOf(scenario: Scenario): SellerProfile {
  const seller = getSeller(scenario.sellerId);
  if (!seller) throw new Error(`scenario ${scenario.id} names an unknown seller`);
  return seller;
}

async function negotiate(set: Agents, scenario: Scenario): Promise<{ state: NegotiationState; signed: SignedContract | null }> {
  const seller = sellerOf(scenario);
  const { mandate } = await set.parseIntent(scenario.intent, TEST_NOW, -540);
  const rules = { mandate, seller, now: TEST_NOW };
  let state = initialNegotiation();
  while (state.status === "open") {
    const actor = nextActor(state);
    const proposed =
      actor === "seller"
        ? await set.sellerMove(sellerContextFor(state, rules))
        : await set.buyerMove(buyerContextFor(state, rules));
    state = applyMove(state, actor, proposed.move, proposed.meta, rules).state;
  }
  const signed = state.agreedTerms
    ? compileContract({
        dealId: "deal_flow",
        contractId: "ctr_scriptedflow",
        mandate,
        terms: state.agreedTerms,
        seller,
        policy: DEFAULT_POLICY,
        now: TEST_NOW,
      })
    : null;
  return { state, signed };
}

async function deliverAndJudge(set: Agents, scenario: Scenario, signed: SignedContract, round: number) {
  const delivery = await set.produceDelivery({
    contract: signed.contract,
    seller: sellerOf(scenario),
    round,
    previousReport: null,
    previousSubmission: null,
    now: TEST_NOW,
  });
  const submission: Submission = {
    id: `sub_flow_${round}`,
    dealId: signed.contract.dealId,
    round,
    artifacts: delivery.artifacts,
    note: delivery.note,
    source: delivery.meta.source,
    model: delivery.meta.model,
    submittedAt: TEST_NOW.toISOString(),
  };
  const rules = signed.contract.verificationRules.filter((rule) => rule.evaluator === "ai");
  return { delivery, rules, verification: await set.evaluateAiRules({ contract: signed.contract, rules, submission }) };
}

describe("scripted agents with the real engines and studio", () => {
  it.each(SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
    "%s: parses, negotiates to an agreement, delivers, and passes the AI-judged rules",
    async (_id, scenario) => {
      const { mandate, meta } = await agents.parseIntent(scenario.intent, TEST_NOW, -540);
      expect(MandateSchema.safeParse(mandate).success).toBe(true);
      expect(meta).toMatchObject({ source: "scripted", model: null, degradedReason: null });

      const { state, signed } = await negotiate(agents, scenario);
      expect(state.status).toBe("agreed");
      expect(state.agreedTerms?.priceMinor).toBeLessThanOrEqual(mandate.budgetMinor);
      expect(state.moves.every((move) => move.source === "scripted" && move.model === null)).toBe(true);
      if (!signed) throw new Error("an agreed negotiation must compile to a contract");

      const { delivery, rules, verification } = await deliverAndJudge(agents, scenario, signed, 1);
      expect(delivery.artifacts.length).toBeGreaterThan(0);
      expect(delivery.meta).toMatchObject({ source: "scripted", model: null, degradedReason: null });
      expect(rules.length).toBeGreaterThan(0);
      expect(verification.checks.map((check) => check.ruleId)).toEqual(rules.map((rule) => rule.id));
      for (const check of verification.checks) {
        // The stand-in must clear the default auto-capture threshold, or scripted runs could never settle.
        expect(check).toMatchObject({ result: "pass", evaluator: "ai" });
        expect(check.confidence).toBeGreaterThanOrEqual(DEFAULT_POLICY.autoCaptureMinConfidence);
        expect(check.evidence).toMatch(/^Heuristic evaluator \(AI disabled\)/);
      }
      expect(verification.flags).toEqual({ manipulationSuspected: false, evidence: null });
      expect(verification.meta).toMatchObject({ source: "scripted", model: null, degradedReason: null });
    },
  );
});
