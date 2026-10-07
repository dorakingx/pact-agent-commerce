"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSWRConfig } from "swr";
import { PageHeader } from "@/components/shell";
import { toast } from "@/components/ui";
import type { CreateDealRequest, CreateDealResponse, DealResponse } from "@/lib/api/dto";
import { api } from "@/lib/client/api";
import { payPalReturnToast, type PayPalReturn } from "@/lib/client/deal-derive";
import { createErrorMessage } from "@/lib/client/deal-derive-compose";
import { dealPath, toApiError } from "@/lib/client/use-deal";
import { DEALS_PATH } from "@/lib/client/use-deals";
import type { ScenarioId } from "@/lib/domain/scenarios";
import { Composer, type ComposerError } from "./composer";
import { ContextStrip } from "./context-strip";
import { DealList } from "./deal-list";
import { ScenarioPicker, type ScenarioOption } from "./scenario-picker";

export interface WorkspaceScreenProps {
  scenarios: readonly ScenarioOption[];
  /** `?scenario=` from the landing page, already validated. */
  initialScenarioId: ScenarioId | null;
  /** `?paypal=error`: a PayPal redirect that could not be matched to a deal. */
  paypalReturn: PayPalReturn | null;
}

/** /workspace — say what you need, or pick a scenario, and hand it to the buyer agent. */
export function WorkspaceScreen({ scenarios, initialScenarioId, paypalReturn }: WorkspaceScreenProps) {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const initial = scenarios.find((scenario) => scenario.id === initialScenarioId) ?? null;
  const [text, setText] = useState(initial?.intent ?? "");
  const [scenarioId, setScenarioId] = useState<ScenarioId | null>(initial?.id ?? null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<ComposerError | null>(null);
  const scenario = scenarios.find((entry) => entry.id === scenarioId) ?? null;

  useEffect(() => {
    if (paypalReturn === null) return;
    const message = payPalReturnToast(paypalReturn);
    // A fixed id keeps a re-run of this effect from stacking a second copy.
    toast[message.kind](message.title, { id: "paypal-return-workspace", description: message.description });
    const url = new URL(window.location.href);
    url.searchParams.delete("paypal");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }, [paypalReturn]);

  function selectScenario(id: ScenarioId): void {
    const picked = scenarios.find((entry) => entry.id === id);
    if (picked === undefined) return;
    setScenarioId(id);
    setText(picked.intent);
    setError(null);
  }

  async function submit(): Promise<void> {
    if (creating) return;
    setCreating(true);
    setError(null);
    const body: CreateDealRequest = {
      intent: text,
      ...(scenarioId === null ? {} : { scenarioId }),
      // So "tomorrow at 6 PM" is resolved in the human's own time zone.
      tzOffsetMinutes: new Date().getTimezoneOffset(),
    };
    try {
      const { deal } = await api.post<CreateDealResponse>(DEALS_PATH, body);
      // The deal page opens on the deal it was just given instead of a skeleton.
      await mutate(dealPath(deal.id), { deal } satisfies DealResponse, { revalidate: false });
      void mutate(DEALS_PATH);
      // `creating` stays true: the button keeps its spinner until the deal page takes over.
      router.push(`/deals/${deal.id}`);
    } catch (cause) {
      const failure = toApiError(cause);
      // Worded now, while "in about 4 minutes" is still true.
      setError({ message: createErrorMessage(failure, Date.now()), requestId: failure.requestId, code: failure.code });
      setCreating(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Workspace"
        description="Delegate a task to your buyer agent. It negotiates with a seller agent, PACT places a hold for the agreed price, and the seller is paid only when the delivery is verified against the contract."
        actions={<ContextStrip />}
        className="sm:items-start lg:items-end"
      />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22.5rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <Composer
            text={text}
            onTextChange={(next) => {
              setText(next);
              setError(null);
            }}
            scenario={scenario}
            onClearScenario={() => setScenarioId(null)}
            creating={creating}
            error={error}
            onSubmit={() => void submit()}
          />
          <ScenarioPicker scenarios={scenarios} selected={scenarioId} onSelect={selectScenario} disabled={creating} />
        </div>
        <DealList />
      </div>
    </>
  );
}
