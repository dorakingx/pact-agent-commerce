/**
 * /workspace — where a deal starts. The page resolves the query string and the public seller
 * profiles on the server; everything that depends on the visitor's session is read in the browser.
 */
import type { Metadata } from "next";
import { AppShell } from "@/components/shell";
import type { ScenarioOption } from "@/components/workspace/scenario-picker";
import { WorkspaceScreen } from "@/components/workspace/workspace-screen";
import { parsePayPalReturn } from "@/lib/client/deal-derive";
import { SCENARIOS, getScenario } from "@/lib/domain/scenarios";
import { getSeller, toSellerPublic } from "@/lib/domain/sellers";

export const metadata: Metadata = {
  title: "Workspace",
  description: "Delegate a task to a buyer agent. PACT holds the payment and releases it only when the delivery is verified.",
};

/** Only the public half of each seller profile crosses to the browser: no rate card, no floor. */
function scenarioOptions(): ScenarioOption[] {
  return SCENARIOS.map((scenario) => {
    const seller = getSeller(scenario.sellerId);
    return {
      id: scenario.id,
      title: scenario.title,
      demonstrates: scenario.demonstrates,
      outcome: scenario.outcome,
      intent: scenario.intent,
      seller: seller ? toSellerPublic(seller) : null,
    };
  });
}

export default async function WorkspacePage({ searchParams }: PageProps<"/workspace">) {
  const query = await searchParams;
  const requested = Array.isArray(query.scenario) ? query.scenario[0] : query.scenario;
  const scenario = requested === undefined ? undefined : getScenario(requested);
  return (
    <AppShell>
      <WorkspaceScreen
        // Keyed so that following a scenario link while already on the page re-fills the composer.
        key={scenario?.id ?? "free-form"}
        scenarios={scenarioOptions()}
        initialScenarioId={scenario?.id ?? null}
        paypalReturn={parsePayPalReturn(query.paypal)}
      />
    </AppShell>
  );
}
