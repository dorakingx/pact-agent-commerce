"use client";

import { Check, CircleCheck, RotateCcw, ShieldAlert, Store, UserCheck } from "lucide-react";
import { StatusPill, TONE_CLASSES, cn, type StatusTone } from "@/components/ui";
import { DemoFaultBadge, TrustBadge } from "@/components/deal/parts";
import type { Scenario, ScenarioId } from "@/lib/domain/scenarios";
import type { SellerPublic } from "@/lib/domain/sellers";

/**
 * A scenario with the public profile of the seller it pins. Built on the server (see the
 * workspace page), so the seller directory with its private rate cards never reaches the browser.
 */
export interface ScenarioOption extends Pick<Scenario, "id" | "title" | "demonstrates" | "outcome" | "intent"> {
  seller: SellerPublic | null;
}

interface ScenarioLook {
  icon: React.ReactNode;
  /** Colour of the branch the scenario exercises. */
  branchTone: StatusTone;
  /** Colour of the final money outcome. */
  outcomeTone: StatusTone;
}

/* Same looks as the landing page; keyed by ScenarioId so a new scenario fails the build until it has one. */
const LOOK: Record<ScenarioId, ScenarioLook> = {
  "happy-path": { icon: <CircleCheck />, branchTone: "success", outcomeTone: "success" },
  revision: { icon: <RotateCcw />, branchTone: "hold", outcomeTone: "success" },
  approval: { icon: <UserCheck />, branchTone: "review", outcomeTone: "success" },
  injection: { icon: <ShieldAlert />, branchTone: "danger", outcomeTone: "neutral" },
};

export interface ScenarioPickerProps {
  scenarios: readonly ScenarioOption[];
  selected: ScenarioId | null;
  onSelect(id: ScenarioId): void;
  disabled?: boolean;
}

/** Four one-click requests, each steering the same engine down a different branch. */
export function ScenarioPicker({ scenarios, selected, onSelect, disabled = false }: ScenarioPickerProps) {
  return (
    <section aria-labelledby="scenario-picker-title">
      <h2 id="scenario-picker-title" className="text-[15px] leading-6 font-semibold tracking-[-0.01em] text-fg">
        Or start from a scenario
      </h2>
      <p className="mt-0.5 text-sm leading-6 text-muted">
        Each one is an ordinary deal run by the same agents and engines. It only pre-fills the request and pins the seller, so a
        specific branch runs on demand.
      </p>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2">
        {scenarios.map((scenario, index) => {
          const look = LOOK[scenario.id];
          const branch = TONE_CLASSES[look.branchTone];
          const { seller } = scenario;
          const active = selected === scenario.id;
          return (
            <li key={scenario.id} className="flex">
              <button
                type="button"
                aria-pressed={active}
                disabled={disabled}
                onClick={() => onSelect(scenario.id)}
                data-testid="scenario-card"
                data-scenario-id={scenario.id}
                className={cn(
                  "group flex w-full flex-col rounded-card border bg-surface p-4 text-left transition-colors duration-150 focus-ring disabled:opacity-60",
                  active ? "border-accent shadow-[0_0_0_1px_var(--accent)]" : "border-hairline hover:border-hairline-strong",
                )}
              >
                <span className="flex w-full items-start justify-between gap-3">
                  <span aria-hidden="true" className={cn("flex size-9 items-center justify-center rounded-control [&_svg]:size-[18px]", branch.soft, branch.text)}>
                    {look.icon}
                  </span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-5 items-center justify-center rounded-full border transition-colors duration-150",
                      active ? "border-accent bg-accent text-on-accent" : "border-hairline-strong text-transparent",
                    )}
                  >
                    <Check className="size-3" strokeWidth={3} />
                  </span>
                </span>
                <span className="mt-3 font-mono text-[11px] leading-4 font-medium tracking-[0.08em] text-faint uppercase">
                  Scenario {String(index + 1).padStart(2, "0")}
                </span>
                <span className="mt-1 text-base leading-6 font-semibold tracking-[-0.01em] text-fg">{scenario.title}</span>
                <span className="mt-1 text-[13px] leading-5 text-pretty text-muted">{scenario.demonstrates}</span>
                <span className="mt-3 mb-3 flex flex-wrap items-center gap-1.5">
                  <span className="sr-only">Outcome: </span>
                  <StatusPill tone={look.outcomeTone} size="sm">
                    {scenario.outcome}
                  </StatusPill>
                </span>
                {seller ? (
                  <span className="mt-auto flex w-full flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-hairline pt-3">
                    <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-fg">
                      <Store aria-hidden="true" className="size-3.5 text-muted" />
                      {seller.name}
                    </span>
                    <TrustBadge trust={seller.trust} />
                    {seller.demoFault ? <DemoFaultBadge fault={seller.demoFault} short /> : null}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
