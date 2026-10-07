"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bot,
  CircleDollarSign,
  FileCheck2,
  Landmark,
  ScanSearch,
  Server,
  ShieldAlert,
  ShieldCheck,
  Store,
  UserRound,
} from "lucide-react";
import { Button, Card, MonoId, TONE_CLASSES, cn } from "@/components/ui";
import type { DealView } from "@/lib/api/dto";
import { formatLocalClock, formatLocalDateTime } from "@/lib/client/deal-derive";
import { auditActorLabel, auditEventTone, auditFacts, auditHeadHash, auditTitle, type AuditFact } from "@/lib/client/deal-derive-audit";
import { plural } from "@/lib/domain/format";
import type { AuditActor, AuditEvent } from "@/lib/domain/schemas";

const ACTOR_ICON: Record<AuditActor, React.ReactNode> = {
  human: <UserRound />,
  buyer_agent: <Bot />,
  seller_agent: <Store />,
  contract_engine: <FileCheck2 />,
  policy_engine: <ShieldCheck />,
  payment_orchestrator: <Landmark />,
  paypal: <CircleDollarSign />,
  verifier: <ScanSearch />,
  system: <Server />,
};

/** Events shown before "Show all" in the stacked (narrow) layout. */
const SECTION_PREVIEW = 6;
/** How close to the bottom still counts as "following" the trail. */
const STICK_SLACK_PX = 48;
/** The rail never shrinks below this, and keeps this much air under itself. */
const RAIL_MIN_HEIGHT_PX = 260;
const RAIL_BOTTOM_GAP_PX = 24;

function FactValue({ fact }: { fact: AuditFact }) {
  if (fact.kind === "id") return <MonoId value={fact.value} label={fact.label} head={10} tail={6} className="text-xs" />;
  if (fact.kind === "time") return <span>{formatLocalDateTime(fact.value)}</span>;
  return <span className={cn("break-words", fact.kind === "money" && "font-mono tabular-nums")}>{fact.value}</span>;
}

function Entry({ event, deal, last }: { event: AuditEvent; deal: DealView; last: boolean }) {
  const facts = auditFacts(event.data);
  const tone = TONE_CLASSES[auditEventTone(event)];
  const actor = auditActorLabel(event.actor, { isOwner: deal.isOwner, simulatedPayment: deal.flags.simulatedPayment });
  return (
    <li data-testid="audit-event" data-type={event.type} data-seq={event.seq} className="relative flex animate-rise-in gap-3 pb-4 last:pb-0">
      {last ? null : <span aria-hidden="true" className="absolute top-7 bottom-0 left-[13px] w-px bg-hairline" />}
      <span aria-hidden="true" className={cn("relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border [&_svg]:size-3.5", tone.soft, tone.text, tone.line)}>
        {ACTOR_ICON[event.actor]}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="flex items-baseline justify-between gap-2 text-xs leading-5">
          <span className="font-semibold text-fg">{actor}</span>
          <time dateTime={event.at} className="shrink-0 font-mono text-[11px] text-faint tabular-nums">
            {formatLocalClock(event.at)}
          </time>
        </p>
        <p className="text-[13px] leading-5 break-words text-fg">{auditTitle(event, deal)}</p>
        {event.detail ? <p className="mt-0.5 line-clamp-3 text-xs leading-5 break-words text-muted">{event.detail}</p> : null}
        <details className="group mt-1">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-[11px] font-medium text-faint focus-ring hover:text-fg [&::-webkit-details-marker]:hidden">
            <span className="font-mono">#{event.seq}</span>
            <span aria-hidden="true">·</span>
            <span className="group-open:hidden">{facts.length > 0 ? plural(facts.length, "fact") : "hash"}</span>
            <span className="hidden group-open:inline">hide</span>
          </summary>
          <dl className="mt-1.5 flex flex-col gap-1 rounded-control border border-hairline bg-subtle/60 px-2.5 py-2 text-xs leading-5">
            {facts.map((fact) => (
              <div key={fact.key} className="flex items-baseline justify-between gap-3">
                <dt className="shrink-0 text-muted">{fact.label}</dt>
                <dd className="min-w-0 text-right font-medium text-fg">
                  <FactValue fact={fact} />
                </dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-3">
              <dt className="shrink-0 text-muted">Entry hash</dt>
              <dd className="min-w-0 text-right font-medium text-fg">
                <MonoId value={event.hash} label="entry hash" head={8} tail={6} className="text-xs" />
              </dd>
            </div>
          </dl>
        </details>
      </div>
    </li>
  );
}

function ChainStatus({ deal }: { deal: DealView }) {
  const head = auditHeadHash(deal.audit);
  const valid = deal.flags.auditChainValid;
  return (
    <div data-testid="audit-chain" data-valid={valid} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5">
      {valid ? (
        <span className="inline-flex items-center gap-1.5 font-medium text-success">
          <ShieldCheck aria-hidden="true" className="size-3.5" />
          Hash-chained · verified
        </span>
      ) : (
        <span role="alert" className="inline-flex items-center gap-1.5 font-semibold text-danger">
          <ShieldAlert aria-hidden="true" className="size-3.5" />
          Hash chain broken — this trail was altered
        </span>
      )}
      {head ? <MonoId value={head} label="head hash of the audit chain" head={8} tail={6} className="text-xs text-muted" /> : null}
    </div>
  );
}

export interface AuditTrailProps {
  deal: DealView;
  /** `rail`: sticky column with its own scroll. `section`: stacked at the end of the page. */
  variant: "rail" | "section";
}

/**
 * The append-only record of everything that happened to the deal, oldest first. In the rail it
 * keeps the newest entry in view for as long as the viewer has not scrolled away from it.
 */
export function AuditTrail({ deal, variant }: AuditTrailProps) {
  const card = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const [showAll, setShowAll] = useState(false);
  const count = deal.audit.length;
  const rail = variant === "rail";

  useEffect(() => {
    const element = scroller.current;
    if (element === null || !rail || !stick.current) return;
    element.scrollTop = element.scrollHeight;
  }, [count, rail]);

  // The rail is sticky, but until the page has scrolled it starts lower than its sticky position.
  // Sizing it to the space that is really left keeps its newest entry on screen at every scroll offset.
  useEffect(() => {
    const element = card.current;
    if (element === null || !rail) return;
    let frame = 0;
    const fit = (): void => {
      frame = 0;
      const available = window.innerHeight - element.getBoundingClientRect().top - RAIL_BOTTOM_GAP_PX;
      element.style.maxHeight = `${Math.max(RAIL_MIN_HEIGHT_PX, available)}px`;
      const list = scroller.current;
      if (list !== null && stick.current) list.scrollTop = list.scrollHeight;
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(fit);
    };
    fit();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      element.style.maxHeight = "";
    };
  }, [rail]);

  const events = rail || showAll ? deal.audit : deal.audit.slice(-SECTION_PREVIEW);
  const hidden = count - events.length;

  return (
    <Card
      ref={card}
      data-testid="audit-trail"
      data-variant={variant}
      // The class is the fallback before the first measurement; the effect above refines it.
      className={cn("flex min-h-0 flex-col", rail && "max-h-[calc(100dvh-10.5rem)]")}
    >
      <header className="border-b border-hairline px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[15px] leading-6 font-semibold tracking-[-0.01em] text-fg">Audit trail</h2>
          <span data-testid="audit-count" className="font-mono text-xs text-muted tabular-nums">
            {plural(count, "event")}
          </span>
        </div>
        <ChainStatus deal={deal} />
      </header>
      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_SLACK_PX;
        }}
        // The scroll area has no focusable child of its own until an entry is opened, so make it reachable.
        tabIndex={rail ? 0 : undefined}
        role={rail ? "region" : undefined}
        aria-label={rail ? "Audit trail entries" : undefined}
        className={cn("px-4 py-4", rail && "min-h-0 flex-1 overflow-y-auto overscroll-contain focus-ring")}
      >
        {hidden > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setShowAll(true)} className="mb-3 -ml-2" data-testid="audit-show-all">
            Show {plural(hidden, "earlier event")}
          </Button>
        ) : null}
        <ol aria-label="Audit trail, oldest first">
          {events.map((event, index) => (
            <Entry key={event.id} event={event} deal={deal} last={index === events.length - 1} />
          ))}
        </ol>
      </div>
    </Card>
  );
}
