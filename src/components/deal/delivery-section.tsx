"use client";

import { useState } from "react";
import { Download, ImageOff, Maximize2, MessageSquareText, TriangleAlert } from "lucide-react";
import {
  Badge,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  RelativeTime,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  buttonVariants,
  cn,
} from "@/components/ui";
import type { DealView } from "@/lib/api/dto";
import {
  checkForMissingSlot,
  deliveryGrid,
  deliverySummary,
  evidenceTarget,
  notDeliveredLabel,
  selectedRound,
  submissionLabel,
  type CopyPiece,
  type CopyVariant,
  type DeliveryGrid,
  type EvidenceTarget,
  type IllustrationGroup,
  type IllustrationSlot,
} from "@/lib/client/deal-derive-delivery";
import { dealPath } from "@/lib/client/use-deal";
import { plural } from "@/lib/domain/format";
import type { CopySpec, DeliverableSpec, IllustrationArtifact, Submission, VerificationCheck, VerificationReport } from "@/lib/domain/schemas";
import { parseAspectRatio } from "@/lib/domain/verification";
import { svgToDataUri } from "@/lib/studio/data-uri";
import { evidenceRing, useEvidenceLink } from "./evidence-link";
import { Eyebrow, ModelBadge, SectionCard, WorkingNote } from "./parts";

function artifactUrl(dealId: string, artifactId: string): string {
  return `${dealPath(dealId)}/artifacts/${encodeURIComponent(artifactId)}`;
}

/* -------------------------------------------------------------------------- */
/*  Illustrations                                                              */
/* -------------------------------------------------------------------------- */

function IllustrationImage({ artifact, className }: { artifact: IllustrationArtifact; className?: string }) {
  return (
    // The deliverable is untrusted SVG. Rendering it through <img> from a data URI means it cannot
    // run scripts or fetch anything, and next/image has nothing to optimise in a vector file.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={svgToDataUri(artifact.svg)}
      alt={`${artifact.title || "Untitled"} — illustration #${artifact.index}`}
      width={artifact.width}
      height={artifact.height}
      decoding="async"
      className={className}
    />
  );
}

function IllustrationTile({
  slot,
  dealId,
  highlighted,
  target,
}: {
  slot: IllustrationSlot & { artifact: IllustrationArtifact };
  dealId: string;
  highlighted: boolean;
  target: EvidenceTarget | null;
}) {
  const { artifact } = slot;
  const size = `${artifact.width}×${artifact.height}`;
  return (
    <Dialog>
      <div className="flex min-w-0 flex-col gap-1.5" style={{ flex: `${artifact.width / artifact.height} 1 0%` }}>
        <DialogTrigger asChild>
          <button
            type="button"
            aria-label={`Open illustration #${slot.index}, ${slot.ratio}, ${artifact.width} by ${artifact.height} pixels`}
            data-testid="delivery-tile"
            data-artifact-id={artifact.id}
            className={cn(
              "group relative block w-full overflow-hidden rounded-control border border-hairline bg-subtle transition-shadow duration-150 focus-ring hover:border-hairline-strong",
              evidenceRing(target, highlighted),
            )}
            style={{ aspectRatio: `${artifact.width} / ${artifact.height}` }}
          >
            <IllustrationImage artifact={artifact} className="size-full object-contain" />
            <span
              aria-hidden="true"
              className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-md bg-inverse/80 text-on-inverse opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
            >
              <Maximize2 className="size-3" />
            </span>
          </button>
        </DialogTrigger>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
          <Badge tone="neutral" variant="outline" className="font-mono">
            {slot.ratio}
          </Badge>
          <span className="font-mono tabular-nums">{size}</span>
          {slot.required ? null : <Badge tone="neutral">Not in contract</Badge>}
        </p>
      </div>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{artifact.title || `Illustration #${artifact.index}`}</DialogTitle>
          <DialogDescription>
            Illustration #{artifact.index} · {slot.ratio} · {size} px · SVG
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex items-center justify-center rounded-control border border-hairline bg-subtle p-2">
            <IllustrationImage artifact={artifact} className="max-h-[58dvh] w-auto max-w-full object-contain" />
          </div>
          {artifact.description ? (
            <div className="mt-3">
              <Eyebrow>Seller&apos;s description · untrusted text</Eyebrow>
              <p className="mt-1 text-sm leading-6 break-words text-muted">{artifact.description}</p>
            </div>
          ) : null}
          <div className="mt-4 flex justify-end">
            <a
              href={artifactUrl(dealId, artifact.id)}
              download
              data-testid="artifact-download"
              className={buttonVariants({ variant: "secondary", size: "sm" })}
            >
              <Download aria-hidden="true" />
              Download SVG
            </a>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function MissingTile({
  slot,
  check,
  highlighted,
  target,
  onPoint,
  onOpen,
}: {
  slot: IllustrationSlot;
  check: VerificationCheck | null;
  highlighted: boolean;
  target: EvidenceTarget | null;
  onPoint(active: boolean): void;
  onOpen(): void;
}) {
  const ratio = parseAspectRatio(slot.ratio) ?? 1;
  const label = notDeliveredLabel(slot.ratio);
  return (
    <div className="flex min-w-0 flex-col gap-1.5" style={{ flex: `${ratio} 1 0%` }}>
      <button
        type="button"
        data-testid="delivery-missing"
        data-slot-key={slot.key}
        data-rule-id={check?.ruleId}
        aria-label={`${label}, illustration #${slot.index}. ${check ? `Fails ${check.ruleId}: ${slot.evidence}. Show the verification result.` : ""}`}
        onMouseEnter={() => onPoint(true)}
        onMouseLeave={() => onPoint(false)}
        onFocus={() => onPoint(true)}
        onBlur={() => onPoint(false)}
        onClick={onOpen}
        className={cn(
          "flex w-full flex-col items-center justify-center gap-1 rounded-control border-2 border-dashed border-danger/55 bg-danger-soft/50 px-2 text-center text-danger transition-shadow duration-150 focus-ring",
          evidenceRing(target, highlighted),
        )}
        style={{ aspectRatio: `${ratio}` }}
      >
        <ImageOff aria-hidden="true" className="size-4" />
        <span className="text-[13px] leading-4 font-semibold">{label}</span>
      </button>
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs leading-5 text-danger">
        {check ? (
          <Badge tone="danger" className="font-mono">
            {check.ruleId}
          </Badge>
        ) : null}
        <span data-testid="delivery-missing-evidence" className="font-medium">
          {slot.evidence}
        </span>
      </p>
    </div>
  );
}

function IllustrationGrid({
  groups,
  grid,
  round,
  report,
  dealId,
}: {
  groups: IllustrationGroup[];
  grid: DeliveryGrid;
  round: number;
  report: VerificationReport | null;
  dealId: string;
}) {
  const link = useEvidenceLink();
  const missingCheck = checkForMissingSlot(report);
  const missingTarget = missingCheck === null ? null : evidenceTarget(missingCheck, round, grid);
  const active = link.target !== null && link.target.round === round ? link.target : null;

  function openVerification(): void {
    if (missingTarget === null) return;
    link.pin(missingTarget);
    document.getElementById("section-verification")?.scrollIntoView({ block: "start" });
  }

  return (
    <ul className="flex flex-col gap-5">
      {groups.map((group) => (
        <li key={group.index} data-testid="delivery-group" data-index={group.index}>
          <p className="mb-2 flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-semibold text-fg">Illustration #{group.index}</span>
            {group.title ? <span className="min-w-0 truncate text-muted">{group.title}</span> : null}
            {group.missing > 0 ? (
              <span className="font-medium text-danger">· {plural(group.missing, "variant")} missing</span>
            ) : null}
          </p>
          <div className="flex items-start gap-2.5 sm:gap-3">
            {group.slots.map((slot) =>
              slot.artifact === null ? (
                <MissingTile
                  key={slot.key}
                  slot={slot}
                  check={missingCheck}
                  target={active}
                  highlighted={active !== null && active.missingKeys.includes(slot.key)}
                  onPoint={(on) => link.hover(on ? missingTarget : null)}
                  onOpen={openVerification}
                />
              ) : (
                <IllustrationTile
                  key={slot.key}
                  slot={{ ...slot, artifact: slot.artifact }}
                  dealId={dealId}
                  target={active}
                  highlighted={active !== null && active.artifactIds.includes(slot.artifact.id)}
                />
              ),
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/*  Copy                                                                       */
/* -------------------------------------------------------------------------- */

/** Texts longer than this open clamped: a contract can ask for thousands of words per piece. */
const COPY_CLAMP_CHARS = 1200;

function CopyText({ variant, spec, dealId }: { variant: CopyVariant; spec: CopySpec | null; dealId: string }) {
  const [expanded, setExpanded] = useState(false);
  const { artifact } = variant;
  if (artifact === null) {
    return (
      <p
        data-testid="delivery-missing"
        data-slot-key={variant.key}
        className="flex min-h-24 items-center justify-center rounded-control border-2 border-dashed border-danger/55 bg-danger-soft/50 px-3 text-center text-[13px] font-semibold text-danger"
      >
        {notDeliveredLabel(variant.languageLabel)}
      </p>
    );
  }
  const outOfRange = spec !== null && (variant.words < spec.minWords || variant.words > spec.maxWords);
  const long = artifact.text.length > COPY_CLAMP_CHARS;
  return (
    <div>
      <p className="text-sm leading-6 font-semibold text-fg" lang={variant.language}>
        {artifact.title}
      </p>
      <p
        lang={variant.language}
        data-testid="copy-text"
        className={cn("mt-1 text-sm leading-6 break-words whitespace-pre-wrap text-fg/90", long && !expanded && "line-clamp-[10]")}
      >
        {artifact.text}
      </p>
      {long ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((shown) => !shown)}
          className="mt-1 rounded-sm text-[13px] font-medium text-fg underline decoration-hairline-strong underline-offset-2 focus-ring hover:decoration-fg"
        >
          {expanded ? "Show less" : "Show the full text"}
        </button>
      ) : null}
      <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span className={cn("font-mono tabular-nums", outOfRange && "font-semibold text-danger")} data-testid="copy-word-count">
          {plural(variant.words, "word")}
        </span>
        {spec ? <span>· contract: {spec.minWords}–{spec.maxWords}</span> : null}
        {variant.required ? null : <Badge tone="neutral">Not in contract</Badge>}
        <a
          href={artifactUrl(dealId, artifact.id)}
          download
          data-testid="artifact-download"
          className="ml-auto inline-flex items-center gap-1 rounded-sm font-medium text-fg underline-offset-2 focus-ring hover:underline"
        >
          <Download aria-hidden="true" className="size-3.5" />
          Download .txt
        </a>
      </p>
    </div>
  );
}

function CopyCard({ piece, spec, dealId, target }: { piece: CopyPiece; spec: CopySpec | null; dealId: string; target: EvidenceTarget | null }) {
  const first = piece.variants[0];
  const [language, setLanguage] = useState(first.key);
  const highlighted =
    target !== null &&
    piece.variants.some(
      (variant) =>
        (variant.artifact !== null && target.artifactIds.includes(variant.artifact.id)) || target.missingKeys.includes(variant.key),
    );
  return (
    <li
      data-testid="delivery-copy"
      data-index={piece.index}
      className={cn("rounded-card border border-hairline bg-surface p-3.5 transition-shadow duration-150", evidenceRing(target, highlighted))}
    >
      <Tabs value={language} onValueChange={setLanguage} className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] font-semibold text-fg">
            Piece #{piece.index}
            {piece.missing > 0 ? <span className="font-medium text-danger"> · {plural(piece.missing, "language")} missing</span> : null}
          </p>
          <TabsList variant="segmented" aria-label={`Languages of piece #${piece.index}`}>
            {piece.variants.map((variant) => (
              <TabsTrigger key={variant.key} value={variant.key} className={cn(variant.artifact === null && "text-danger")}>
                {variant.languageLabel}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {piece.variants.map((variant) => (
          <TabsContent key={variant.key} value={variant.key}>
            <CopyText variant={variant} spec={spec} dealId={dealId} />
          </TabsContent>
        ))}
      </Tabs>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/*  One submission                                                             */
/* -------------------------------------------------------------------------- */

function SubmissionView({
  submission,
  spec,
  report,
  dealId,
}: {
  submission: Submission;
  spec: DeliverableSpec | null;
  report: VerificationReport | null;
  dealId: string;
}) {
  const link = useEvidenceLink();
  const grid = deliveryGrid(spec, submission);
  const active = link.target !== null && link.target.round === submission.round ? link.target : null;
  return (
    <div data-testid="delivery-submission" data-round={submission.round}>
      <p className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] text-muted">
        <span className="font-medium text-fg" data-testid="delivery-summary">
          {deliverySummary(grid)}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          submitted <RelativeTime value={submission.submittedAt} />
        </span>
        <ModelBadge model={submission.model} source={submission.source} />
        {grid.missing > 0 ? (
          <Badge tone="danger">
            <TriangleAlert aria-hidden="true" />
            Incomplete
          </Badge>
        ) : null}
      </p>

      {grid.kind === "illustration" ? (
        <IllustrationGrid groups={grid.illustrations} grid={grid} round={submission.round} report={report} dealId={dealId} />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {grid.copy.map((piece) => (
            <CopyCard key={piece.index} piece={piece} spec={spec?.kind === "copy" ? spec : null} dealId={dealId} target={active} />
          ))}
        </ul>
      )}

      {submission.note ? (
        <figure className="mt-5 flex items-start gap-2.5 rounded-control border border-hairline bg-subtle/60 px-3.5 py-3">
          <MessageSquareText aria-hidden="true" className="mt-1 size-4 shrink-0 text-muted" />
          <div className="min-w-0">
            <figcaption>
              <Eyebrow>Seller&apos;s delivery note · untrusted text</Eyebrow>
            </figcaption>
            <blockquote data-testid="delivery-note" className="mt-1 text-sm leading-6 break-words text-fg/90">
              {submission.note}
            </blockquote>
          </div>
        </figure>
      ) : null}
    </div>
  );
}

function PendingDelivery({ spec, revising }: { spec: DeliverableSpec | null; revising: boolean }) {
  const tiles = spec === null ? 2 : Math.min(spec.count, 3);
  return (
    <div data-testid="delivery-pending">
      <WorkingNote>
        {revising ? "The seller agent is revising the delivery." : "The seller agent is producing the work."} The payment stays held
        until what arrives has been verified.
      </WorkingNote>
      <div aria-hidden="true" className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: tiles }, (_, index) => (
          <Skeleton key={index} className="aspect-video rounded-control" />
        ))}
      </div>
    </div>
  );
}

export interface DeliverySectionProps {
  deal: DealView;
}

/** 06 — what the seller agent actually sent, laid out against what the contract asked for. */
export function DeliverySection({ deal }: DeliverySectionProps) {
  const link = useEvidenceLink();
  const { submissions } = deal;
  const spec = deal.contract?.contract.deliverables[0] ?? null;
  const rounds = submissions.map((submission) => submission.round);
  const current = selectedRound(rounds, link.roundPick);
  const revising = deal.status === "revision_required";

  return (
    <SectionCard
      id="delivery"
      number="06"
      title="Delivery"
      aside={
        deal.seller ? (
          <span className="text-[13px] text-muted">
            from <span className="font-medium text-fg">{deal.seller.name}</span>
          </span>
        ) : null
      }
    >
      {submissions.length === 0 || current === null ? (
        <PendingDelivery spec={spec} revising={false} />
      ) : (
        <Tabs value={String(current)} onValueChange={(value) => link.pickRound({ round: Number(value), total: rounds.length })}>
          <TabsList aria-label="Deliveries">
            {submissions.map((submission) => {
              const grid = deliveryGrid(spec, submission);
              return (
                <TabsTrigger key={submission.id} value={String(submission.round)} data-testid="delivery-tab" data-round={submission.round}>
                  {submissionLabel(submission.round)}
                  {grid.missing > 0 ? (
                    <span className="rounded-full bg-danger-soft px-1.5 py-px text-[11px] font-semibold text-danger">
                      {grid.missing} missing
                    </span>
                  ) : null}
                </TabsTrigger>
              );
            })}
          </TabsList>
          {submissions.map((submission) => (
            <TabsContent key={submission.id} value={String(submission.round)}>
              <SubmissionView
                submission={submission}
                spec={spec}
                report={deal.reports.find((report) => report.round === submission.round) ?? null}
                dealId={deal.id}
              />
            </TabsContent>
          ))}
        </Tabs>
      )}
      {revising && submissions.length > 0 ? (
        <div className="mt-5 border-t border-hairline pt-4">
          <PendingDelivery spec={spec} revising />
        </div>
      ) : null}
    </SectionCard>
  );
}
