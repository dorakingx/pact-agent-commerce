import Link from "next/link";
import { ArrowUpRight, CircleCheck, RotateCcw, ShieldAlert, UserCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { StatusPill } from "@/components/ui/status-pill";
import { TONE_CLASSES, type StatusTone } from "@/components/ui/tone";
import { SCENARIOS, type ScenarioId } from "@/lib/domain/scenarios";
import { Section } from "./section";

interface ScenarioLook {
  icon: React.ReactNode;
  /** Colour of the branch the scenario exercises. */
  branchTone: StatusTone;
  /** Colour of the final money outcome. */
  outcomeTone: StatusTone;
}

/* Keyed by ScenarioId so adding a scenario to the domain fails the build until it has a look. */
const LOOK: Record<ScenarioId, ScenarioLook> = {
  "happy-path": { icon: <CircleCheck />, branchTone: "success", outcomeTone: "success" },
  revision: { icon: <RotateCcw />, branchTone: "hold", outcomeTone: "success" },
  approval: { icon: <UserCheck />, branchTone: "review", outcomeTone: "success" },
  injection: { icon: <ShieldAlert />, branchTone: "danger", outcomeTone: "neutral" },
};

export function Scenarios() {
  return (
    <Section
      id="scenarios"
      eyebrow="See every branch"
      title="Four deals. Four different endings."
      lead="Each scenario is an ordinary deal run by the same agents, engines and PayPal calls. It only pre-fills the request and picks the seller, so you can trigger each branch on demand."
    >
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {SCENARIOS.map((scenario, index) => {
          const look = LOOK[scenario.id];
          const branch = TONE_CLASSES[look.branchTone];
          const titleId = `scenario-${scenario.id}-title`;
          const detailId = `scenario-${scenario.id}-detail`;
          return (
            <li key={scenario.id} className="flex">
              <Link
                href={`/workspace?scenario=${scenario.id}`}
                className="group flex w-full rounded-card focus-ring"
                // Name the link by its title and attach the rest as a description, so a screen
                // reader's link list stays short without losing what the scenario shows.
                aria-labelledby={titleId}
                aria-describedby={detailId}
              >
                <Card interactive className="flex w-full flex-col p-5 group-hover:border-hairline-strong">
                  <div className="flex items-start justify-between">
                    <span
                      aria-hidden="true"
                      className={cn("flex size-9 items-center justify-center rounded-control [&_svg]:size-[18px]", branch.soft, branch.text)}
                    >
                      {look.icon}
                    </span>
                    <ArrowUpRight
                      aria-hidden="true"
                      className="size-4 text-faint transition-[color,translate] duration-150 ease-out group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-fg"
                    />
                  </div>
                  <p className="mt-5 font-mono text-[11px] leading-4 font-medium tracking-[0.08em] text-faint uppercase">
                    Scenario {String(index + 1).padStart(2, "0")}
                  </p>
                  <h3 id={titleId} className="mt-1.5 text-[17px] leading-6 font-semibold tracking-[-0.01em] text-fg">
                    {scenario.title}
                  </h3>
                  <div id={detailId} className="flex flex-1 flex-col">
                    <p className="mt-2 text-sm leading-6 text-pretty text-muted">{scenario.demonstrates}</p>
                    <div className="mt-auto pt-6">
                      <span className="sr-only">Outcome: </span>
                      <StatusPill tone={look.outcomeTone} size="sm">
                        {scenario.outcome}
                      </StatusPill>
                    </div>
                  </div>
                </Card>
              </Link>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
