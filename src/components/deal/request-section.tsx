"use client";

import { CalendarClock, Cpu, Layers, LockKeyhole, RotateCcw, TriangleAlert, Wallet } from "lucide-react";
import { Badge, Money, RelativeTime } from "@/components/ui";
import type { DealView } from "@/lib/api/dto";
import { formatLocalDateTime, mandateSource, modelLabel } from "@/lib/client/deal-derive";
import { deliverableCountLabel, joinList, languageName, plural } from "@/lib/domain/format";
import type { Mandate } from "@/lib/domain/schemas";
import { getScenario } from "@/lib/domain/scenarios";
import { Eyebrow, SectionCard } from "./parts";

function Fact({
  label,
  icon,
  children,
  note,
  testId,
}: {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  note?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-col rounded-control border border-hairline bg-subtle/50 px-3.5 py-3">
      <dt className="flex items-center gap-1.5 text-xs leading-5 font-medium text-muted [&_svg]:size-3.5 [&_svg]:shrink-0">
        {icon}
        {label}
      </dt>
      <dd className="mt-1 min-w-0 text-[15px] leading-6 font-semibold text-fg">{children}</dd>
      {note ? <dd className="mt-0.5 text-xs leading-5 text-muted">{note}</dd> : null}
    </div>
  );
}

function deliverableFacts(mandate: Mandate): { headline: string; detail: string } {
  // A request nobody can serve still carries a placeholder spec; describing it would mislead.
  if (mandate.category === "restricted") return { headline: "Restricted category", detail: "Never purchasable by an agent." };
  if (mandate.category === "other") return { headline: "Not offered on this network", detail: "No seller agent sells this kind of work." };
  const spec = mandate.deliverable;
  const headline = deliverableCountLabel(spec.kind, spec.count);
  if (spec.kind === "illustration") {
    return { headline, detail: `${joinList([...spec.aspectRatios])} · ${spec.subject}` };
  }
  return {
    headline,
    detail: `${joinList(spec.languages.map(languageName))} · ${spec.minWords}–${spec.maxWords} words · ${spec.subject}`,
  };
}

function SourceBadge({ deal }: { deal: DealView }) {
  const source = mandateSource(deal);
  if (source === null) return null;
  return source.source === "scripted" ? (
    <Badge tone="hold" variant="outline" title="The request was parsed by a scripted parser: no model call was made." data-testid="mandate-source" data-source="scripted">
      <TriangleAlert aria-hidden="true" />
      Scripted parser
    </Badge>
  ) : (
    <Badge tone="neutral" variant="outline" title={source.model ?? undefined} data-testid="mandate-source" data-source="ai">
      <Cpu aria-hidden="true" />
      {modelLabel(source.model, "ai")}
    </Badge>
  );
}

/** 01 — the human's words, and what the buyer agent turned them into. */
export function RequestSection({ deal }: { deal: DealView }) {
  const mandate = deal.mandate;
  const scenario = deal.scenarioId === null ? undefined : getScenario(deal.scenarioId);
  const deliverable = mandate === null ? null : deliverableFacts(mandate);

  return (
    <SectionCard id="request" number="01" title="Request" aside={<SourceBadge deal={deal} />}>
      <figure>
        <blockquote
          data-testid="request-intent"
          className="border-l-2 border-accent pl-4 text-[17px] leading-7 font-medium tracking-[-0.01em] text-pretty text-fg"
        >
          “{deal.intent}”
        </blockquote>
        <figcaption className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 pl-4 text-[13px] text-muted">
          <span>{deal.isOwner ? "You" : "The deal's owner"}</span>
          <span aria-hidden="true">·</span>
          <RelativeTime value={deal.createdAt} />
          {scenario ? (
            <Badge tone="neutral" variant="outline">
              Scenario: {scenario.title}
            </Badge>
          ) : null}
        </figcaption>
      </figure>

      <div className="mt-5 border-t border-hairline pt-4">
        <Eyebrow>What the buyer agent understood</Eyebrow>
        {mandate === null || deliverable === null ? (
          <p className="mt-2 text-sm leading-6 text-muted">
            The buyer agent&apos;s mandate holds a private budget ceiling, so it is shown only to the session that owns this deal.
          </p>
        ) : (
          <>
            <p data-testid="mandate-summary" className="mt-2 text-sm leading-6 text-fg">
              {mandate.summary}
            </p>
            <dl className="mt-3 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
              <Fact
                testId="mandate-budget"
                label="Budget ceiling"
                icon={<Wallet aria-hidden="true" />}
                note={
                  <span className="inline-flex items-center gap-1">
                    <LockKeyhole aria-hidden="true" className="size-3" />
                    {deal.isOwner ? "Private to your agent" : "Private to the buyer agent"}
                  </span>
                }
              >
                <Money amountMinor={mandate.budgetMinor} />
              </Fact>
              <Fact label="Deadline" icon={<CalendarClock aria-hidden="true" />} note={<RelativeTime value={mandate.deadline} />}>
                {formatLocalDateTime(mandate.deadline)}
              </Fact>
              <Fact label="Deliverable" icon={<Layers aria-hidden="true" />} note={deliverable.detail}>
                {deliverable.headline}
              </Fact>
              <Fact
                label="Revisions"
                icon={<RotateCcw aria-hidden="true" />}
                note={mandate.minRevisions === mandate.revisionsWanted ? "Required" : `At least ${mandate.minRevisions}`}
              >
                {mandate.revisionsWanted === 0 ? "None" : plural(mandate.revisionsWanted, "round")}
              </Fact>
            </dl>
            {mandate.notes.length > 0 ? (
              <div className="mt-3">
                <p className="text-xs font-medium text-muted">Notes carried into the brief</p>
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {mandate.notes.map((note) => (
                    <li key={note} className="rounded-md border border-hairline bg-surface px-2 py-1 text-[13px] leading-5 text-fg">
                      {note}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </div>
    </SectionCard>
  );
}
