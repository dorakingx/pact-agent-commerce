import { Card, Stepper, cn, type StepperStep } from "@/components/ui";
import type { DealView } from "@/lib/api/dto";
import { lifecyclePosition, lifecycleStages, type LifecycleStage } from "@/lib/client/deal-derive";

const SEGMENT: Record<LifecycleStage["state"], string> = {
  done: "bg-success",
  current: "bg-info",
  upcoming: "bg-subtle-strong",
  failed: "bg-danger-solid",
  skipped: "bg-hairline-strong opacity-60",
};

const TONE_SEGMENT: Record<NonNullable<LifecycleStage["tone"]>, string> = {
  success: "bg-success",
  hold: "bg-hold",
  info: "bg-info",
  review: "bg-review",
};

const TONE_TEXT: Record<NonNullable<LifecycleStage["tone"]>, string> = {
  success: "text-success",
  hold: "text-hold",
  info: "text-info",
  review: "text-review",
};

function segmentClass(stage: LifecycleStage): string {
  if ((stage.state === "done" || stage.state === "current") && stage.tone) return TONE_SEGMENT[stage.tone];
  return SEGMENT[stage.state];
}

/** The narrow layout: eight segments and the name of the stage the deal is in. */
function CompactRail({ stages }: { stages: readonly LifecycleStage[] }) {
  const { index, stage } = lifecyclePosition(stages);
  const failed = stage.state === "failed";
  return (
    <div className="lg:hidden">
      <div aria-hidden="true" className="flex gap-1">
        {stages.map((entry) => (
          <span
            key={entry.id}
            className={cn("h-1.5 flex-1 rounded-full", segmentClass(entry), entry.state === "current" && "animate-shimmer")}
          />
        ))}
      </div>
      <p className="mt-2.5 flex flex-wrap items-baseline gap-x-2 text-sm leading-5">
        <span className="font-mono text-xs text-faint tabular-nums">
          {index + 1} / {stages.length}
        </span>
        <span className={cn("font-semibold", failed ? "text-danger" : "text-fg")}>{stage.label}</span>
        {stage.description ? (
          <span className={cn("text-[13px]", failed ? "text-danger" : stage.tone ? TONE_TEXT[stage.tone] : "text-muted")}>
            {stage.description}
          </span>
        ) : null}
      </p>
      <ol className="sr-only">
        {stages.map((entry) => (
          <li key={entry.id} aria-current={entry.state === "current" ? "step" : undefined}>
            {entry.label}: {entry.state}
            {entry.description ? `, ${entry.description}` : ""}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Request → … → Settlement, derived from the deal so it can never disagree with the status pill. */
export function LifecycleRail({ deal, className }: { deal: DealView; className?: string }) {
  const stages = lifecycleStages(deal);
  const steps: StepperStep[] = stages.map((stage) => ({
    id: stage.id,
    label: stage.label,
    state: stage.state,
    tone: stage.tone,
    description: stage.description,
  }));
  return (
    <Card data-testid="lifecycle-rail" data-stage={lifecyclePosition(stages).stage.id} className={cn("px-4 py-4 sm:px-5", className)}>
      <CompactRail stages={stages} />
      <Stepper aria-label="Deal lifecycle" steps={steps} className="hidden lg:flex" />
    </Card>
  );
}
