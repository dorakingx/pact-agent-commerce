/**
 * One-click demo scenarios. Each is an ordinary deal: the same agents, engines and PayPal
 * calls run as for a free-form request. A scenario only pre-fills the request text and pins
 * the seller agent, which lets a judge trigger each branch of the settlement engine on demand.
 */

export interface Scenario {
  id: "happy-path" | "revision" | "approval" | "injection";
  title: string;
  /** What this scenario demonstrates, shown on the card. */
  demonstrates: string;
  /** Outcome badge on the card. */
  outcome: string;
  /** The human's natural-language request. */
  intent: string;
  sellerId: string;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "happy-path",
    title: "Verified delivery",
    demonstrates: "Negotiate → contract → authorize → deliver → verify → capture",
    outcome: "Captured",
    intent:
      "Get three landing-page illustrations for under $50 by tomorrow at 6 PM. I need both 16:9 and 1:1 versions and one revision.",
    sellerId: "northwind",
  },
  {
    id: "revision",
    title: "Failed verification",
    demonstrates: "A 1:1 version is missing → no capture → revision → re-verify → capture",
    outcome: "Revised, then captured",
    intent:
      "I need 2 launch banner illustrations for our product update, each in 16:9 and 1:1, by tomorrow at 6 PM. Budget is $40, with one revision.",
    sellerId: "quickdraw",
  },
  {
    id: "approval",
    title: "Human approval",
    demonstrates: "Price exceeds the agent's autonomous limit → PACT pauses for a human",
    outcome: "Approved by you, then captured",
    intent:
      "Write 6 product descriptions for our new espresso machine lineup, 80 to 120 words each, in English and Japanese, within 3 days. Budget is $220, with two revisions.",
    sellerId: "lingua",
  },
  {
    id: "injection",
    title: "Hostile delivery",
    demonstrates: "A new seller hides instructions in the file → flagged → human review → void",
    outcome: "Voided, nothing captured",
    intent:
      "Two hero illustrations for a security webinar page, 16:9 only, within 48 hours. Maximum $45, one revision.",
    sellerId: "pixelharbor",
  },
] as const;

export type ScenarioId = Scenario["id"];

export function getScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
