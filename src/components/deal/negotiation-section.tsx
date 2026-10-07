"use client";

import { CalendarClock, Check, Handshake, Layers, RotateCcw, ShieldAlert, X } from "lucide-react";
import { Badge, Money, cn, type StatusTone } from "@/components/ui";
import type { DealView } from "@/lib/api/dto";
import { formatLatency, formatLocalDateTime } from "@/lib/client/deal-derive";
import {
  MOVE_ACTION_LABEL,
  annotateMoves,
  countDeltaLabel,
  deadlineDeltaLabel,
  guardrailCount,
  negotiationResult,
  nextNegotiator,
  priceDeltaLabel,
  type MoveView,
} from "@/lib/client/deal-derive-negotiation";
import { deliverableCountLabel, plural } from "@/lib/domain/format";
import type { DeliverableSpec, MoveAction, Party } from "@/lib/domain/schemas";
import { ModelBadge, PartyIcon, SectionCard } from "./parts";

const ACTION_TONE: Record<MoveAction, StatusTone> = {
  offer: "neutral",
  counter: "info",
  accept: "success",
  reject: "danger",
};

function partyName(party: Party, deal: DealView): { role: string; name: string } {
  return party === "seller"
    ? { role: "Seller agent", name: deal.seller?.name ?? "Seller" }
    : { role: "Buyer agent", name: deal.isOwner ? "acting for you" : "acting for the buyer" };
}

function Delta({ label, spoken }: { label: string | null; spoken: string }) {
  if (label === null) return null;
  return (
    <span className="font-mono text-[11px] leading-4 font-medium text-muted">
      <span aria-hidden="true">{label}</span>
      <span className="sr-only">{spoken}</span>
    </span>
  );
}

function TermChip({ icon, children, changed }: { icon: React.ReactNode; children: React.ReactNode; changed: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[13px] leading-5 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-faint",
        changed ? "border-hairline-strong bg-surface font-medium text-fg" : "border-hairline bg-surface/60 text-muted",
      )}
    >
      {icon}
      {children}
    </span>
  );
}

function Terms({ view, kind }: { view: MoveView; kind: DeliverableSpec["kind"] | null }) {
  const terms = view.move.terms;
  if (terms === null) return null;
  const delta = view.delta;
  const price = delta === null ? null : priceDeltaLabel(delta.priceMinor);
  const deadline = delta === null ? null : deadlineDeltaLabel(delta.deadlineMs);
  const revisions = delta === null ? null : countDeltaLabel(delta.revisionLimit);
  const count = delta === null ? null : countDeltaLabel(delta.count);
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="move-terms">
      <span className="mr-1 inline-flex items-baseline gap-1.5">
        <Money amountMinor={terms.priceMinor} className="text-lg leading-6 font-semibold text-fg" data-testid="move-price" />
        <Delta
          label={price}
          spoken={delta === null ? "" : `, ${delta.priceMinor < 0 ? "down" : "up"} from this party's previous price`}
        />
      </span>
      <TermChip icon={<CalendarClock aria-hidden="true" />} changed={deadline !== null}>
        <span>by {formatLocalDateTime(terms.deadline, { weekday: false })}</span>
        <Delta label={deadline} spoken=" compared with this party's previous deadline" />
      </TermChip>
      <TermChip icon={<RotateCcw aria-hidden="true" />} changed={revisions !== null}>
        <span>{terms.revisionLimit === 0 ? "no revisions" : plural(terms.revisionLimit, "revision")}</span>
        <Delta label={revisions} spoken=" compared with this party's previous offer" />
      </TermChip>
      <TermChip icon={<Layers aria-hidden="true" />} changed={count !== null}>
        <span>{kind === null ? plural(terms.count, "item") : deliverableCountLabel(kind, terms.count)}</span>
        <Delta label={count} spoken=" compared with this party's previous offer" />
      </TermChip>
    </div>
  );
}

function Move({ view, deal, kind }: { view: MoveView; deal: DealView; kind: DeliverableSpec["kind"] | null }) {
  const { move } = view;
  const buyer = move.actor === "buyer";
  const who = partyName(move.actor, deal);
  const latency = formatLatency(move.latencyMs);
  return (
    <li
      data-testid="negotiation-move"
      data-actor={move.actor}
      data-action={move.action}
      data-live-anchor=""
      className={cn("flex animate-rise-in scroll-mt-44 scroll-mb-10 flex-col gap-1.5 sm:max-w-[88%]", buyer ? "sm:items-end sm:self-end" : "sm:items-start sm:self-start")}
    >
      <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1", buyer && "sm:flex-row-reverse")}>
        <PartyIcon party={move.actor} />
        <p className="text-[13px] leading-5">
          <span className="font-semibold text-fg">{who.role}</span>
          <span className="text-muted"> · {who.name}</span>
        </p>
        <Badge tone={ACTION_TONE[move.action]} data-testid="move-action">
          {move.action === "accept" ? <Check aria-hidden="true" strokeWidth={3} /> : null}
          {move.action === "reject" ? <X aria-hidden="true" strokeWidth={3} /> : null}
          {MOVE_ACTION_LABEL[move.action]}
        </Badge>
      </div>
      <div
        className={cn(
          "flex w-full flex-col gap-2.5 rounded-card border px-3.5 py-3",
          buyer ? "border-info/20 bg-info-soft/60 sm:rounded-tr-sm" : "border-hairline bg-subtle/70 sm:rounded-tl-sm",
        )}
      >
        <Terms view={view} kind={kind} />
        {move.message ? <p className="text-sm leading-6 text-pretty text-fg/90">{move.message}</p> : null}
      </div>
      {move.guardrails.map((guardrail) => (
        <p
          key={`${guardrail.code}-${guardrail.detail}`}
          role="note"
          data-testid="guardrail-note"
          data-code={guardrail.code}
          className="flex w-full items-start gap-2 rounded-control border border-hold/30 bg-hold-soft px-3 py-2 text-[13px] leading-5 text-fg"
        >
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-hold" />
          <span>
            <span className="font-semibold">Guardrail: </span>
            {guardrail.detail}
          </span>
        </p>
      ))}
      <p className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted", buyer && "sm:flex-row-reverse")}>
        <ModelBadge model={move.model} source={move.source} />
        {latency ? <span className="font-mono tabular-nums">{latency}</span> : null}
      </p>
    </li>
  );
}

function Typing({ party, deal }: { party: Party; deal: DealView }) {
  const buyer = party === "buyer";
  const who = partyName(party, deal);
  return (
    <li
      // The activity line in the sticky bar already announces who is writing; twice would be noise.
      aria-hidden="true"
      data-testid="negotiation-typing"
      data-actor={party}
      data-live-anchor=""
      className={cn("flex animate-fade-in scroll-mt-44 scroll-mb-10 flex-col gap-1.5 sm:max-w-[88%]", buyer ? "sm:items-end sm:self-end" : "sm:items-start sm:self-start")}
    >
      <div className={cn("flex items-center gap-2", buyer && "sm:flex-row-reverse")}>
        <PartyIcon party={party} />
        <p className="text-[13px] leading-5 text-muted">
          <span className="font-semibold text-fg">{who.role}</span> is {buyer ? "responding" : "preparing its offer"}…
        </p>
      </div>
      <div
        className={cn(
          "flex h-10 w-16 items-center justify-center gap-1 rounded-card border",
          buyer ? "border-info/20 bg-info-soft/60 sm:rounded-tr-sm" : "border-hairline bg-subtle/70 sm:rounded-tl-sm",
        )}
      >
        {[0, 1, 2].map((dot) => (
          <span key={dot} className="size-1.5 animate-shimmer rounded-full bg-muted" style={{ animationDelay: `${dot * 180}ms` }} />
        ))}
      </div>
    </li>
  );
}

export interface NegotiationSectionProps {
  deal: DealView;
  /** True while the next move is being generated (by this page's runner, or in the owner's session). */
  thinking: boolean;
}

/** 02 — the transcript of two independent agents bargaining, seller on the left, buyer on the right. */
export function NegotiationSection({ deal, thinking }: NegotiationSectionProps) {
  const { negotiation } = deal;
  const views = annotateMoves(negotiation.moves);
  const result = negotiationResult(negotiation);
  const guardrails = guardrailCount(negotiation.moves);
  const kind = deal.contract?.contract.deliverables[0]?.kind ?? deal.mandate?.deliverable.kind ?? null;
  const open = deal.status === "negotiating";

  return (
    <SectionCard
      id="negotiation"
      number="02"
      title="Negotiation"
      aside={
        <>
          {guardrails > 0 ? (
            <Badge tone="hold" variant="outline" data-testid="guardrail-count">
              <ShieldAlert aria-hidden="true" />
              {plural(guardrails, "guardrail intervention")}
            </Badge>
          ) : null}
          <span
            data-testid="negotiation-move-count"
            className="font-mono text-xs font-medium text-muted tabular-nums"
            aria-label={`${negotiation.moves.length} of at most ${negotiation.maxMoves} moves`}
          >
            {negotiation.moves.length} / {negotiation.maxMoves}
          </span>
        </>
      }
    >
      {views.length === 0 && !open ? (
        <p className="text-sm leading-6 text-muted">No offers were exchanged.</p>
      ) : (
        <>
          <div aria-hidden="true" className="mb-3 hidden justify-between font-mono text-[10px] font-medium tracking-[0.08em] text-faint uppercase sm:flex">
            <span>Seller side</span>
            <span>Buyer side</span>
          </div>
          <ol aria-live="polite" aria-relevant="additions" aria-label="Negotiation transcript" className="flex flex-col gap-4">
            {views.map((view) => (
              <Move key={view.move.seq} view={view} deal={deal} kind={kind} />
            ))}
            {open && thinking ? <Typing party={nextNegotiator(negotiation.moves)} deal={deal} /> : null}
          </ol>
        </>
      )}

      {result ? (
        <p
          data-testid="negotiation-result"
          data-status={negotiation.status}
          className={cn(
            "mt-5 flex items-start gap-2.5 rounded-control border px-3.5 py-2.5 text-sm leading-6 font-medium",
            result.tone === "success" ? "border-success/25 bg-success-soft text-fg" : "border-hairline bg-subtle text-fg",
          )}
        >
          {result.tone === "success" ? (
            <Handshake aria-hidden="true" className="mt-1 size-4 shrink-0 text-success" />
          ) : (
            <X aria-hidden="true" className="mt-1 size-4 shrink-0 text-muted" />
          )}
          {result.text}
        </p>
      ) : null}
    </SectionCard>
  );
}
