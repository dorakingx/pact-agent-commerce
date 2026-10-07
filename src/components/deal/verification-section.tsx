"use client";

import { useId, useState } from "react";
import { ArrowUpRight, Check, ChevronDown, CircleQuestionMark, RotateCcw, ShieldCheck, Undo2, UserCheck, X } from "lucide-react";
import {
  Button,
  CHECK_RESULT_TONE,
  Callout,
  ConfidenceBar,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Label,
  Money,
  MonoId,
  Slider,
  StatusPill,
  TONE_CLASSES,
  Textarea,
  VERIFICATION_DECISION_LABEL,
  VERIFICATION_DECISION_TONE,
  cn,
} from "@/components/ui";
import type { DealView } from "@/lib/api/dto";
import { formatLocalClock, openGate } from "@/lib/client/deal-derive";
import {
  decisionBanner,
  deliveryGrid,
  evidenceTarget,
  selectedRound,
  submissionLabel,
  tallyChecks,
  type DecisionBanner,
  type EvidenceTarget,
} from "@/lib/client/deal-derive-delivery";
import type { UseDealDecision } from "@/lib/client/use-deal";
import { plural } from "@/lib/domain/format";
import { formatMoney, percentOf } from "@/lib/domain/money";
import type { CheckResult, HumanDecisionKind, VerificationCheck, VerificationReport } from "@/lib/domain/schemas";
import { EvaluatorBadge } from "./evaluator-badge";
import { useEvidenceLink } from "./evidence-link";
import { ConfirmAction, GatePanel } from "./gate-panel";
import { ModelBadge, SectionCard, WorkingNote } from "./parts";

const RESULT_TEXT: Record<CheckResult, string> = { pass: "PASS", fail: "FAIL", uncertain: "UNCERTAIN" };

function ResultPill({ result }: { result: CheckResult }) {
  const icon =
    result === "pass" ? (
      <Check aria-hidden="true" strokeWidth={3} />
    ) : result === "fail" ? (
      <X aria-hidden="true" strokeWidth={3} />
    ) : (
      <CircleQuestionMark aria-hidden="true" />
    );
  return (
    <StatusPill tone={CHECK_RESULT_TONE[result]} size="sm" icon={icon} className="font-mono text-[11px] tracking-[0.04em]" data-testid="check-result">
      {RESULT_TEXT[result]}
    </StatusPill>
  );
}

const CELL_LABEL = "mb-0.5 block font-mono text-[10px] font-medium tracking-[0.08em] text-faint uppercase sm:hidden";

function CheckRow({
  check,
  threshold,
  target,
  linked,
  onShow,
}: {
  check: VerificationCheck;
  threshold: number;
  /** What this row points at in the delivery, when it did not pass. */
  target: EvidenceTarget | null;
  linked: boolean;
  onShow(): void;
}) {
  const link = useEvidenceLink();
  const tone = CHECK_RESULT_TONE[check.result];
  return (
    <tr
      data-testid="verification-check"
      data-rule-id={check.ruleId}
      data-kind={check.kind}
      data-result={check.result}
      data-linked={linked}
      onMouseEnter={() => (target ? link.hover(target) : undefined)}
      onMouseLeave={() => (target ? link.hover(null) : undefined)}
      className={cn(
        "border-b border-hairline align-top transition-colors duration-150 last:border-b-0 max-sm:grid max-sm:grid-cols-[1fr_auto] max-sm:gap-x-3 max-sm:gap-y-2 max-sm:py-3",
        linked && (check.result === "fail" ? "bg-danger-soft/50" : "bg-review-soft/50"),
      )}
    >
      <th scope="row" className="py-3 pr-3 pl-1 text-left font-normal max-sm:col-start-1 max-sm:py-0">
        <span className="flex items-start gap-2">
          <span className={cn("mt-0.5 w-6 shrink-0 font-mono text-xs font-medium", check.result === "pass" ? "text-faint" : TONE_CLASSES[tone].text)}>
            {check.ruleId}
          </span>
          <span className="min-w-0 text-[13px] leading-5 font-medium text-fg">
            {check.condition}
            {check.required ? null : <span className="font-normal text-muted"> (advisory)</span>}
          </span>
        </span>
      </th>
      <td className="py-3 pr-3 max-sm:col-start-2 max-sm:row-start-1 max-sm:py-0 max-sm:text-right">
        <ResultPill result={check.result} />
      </td>
      <td className="py-3 pr-3 max-sm:col-span-2 max-sm:py-0">
        <span className={CELL_LABEL}>Evidence</span>
        <p data-testid="check-evidence" className={cn("text-[13px] leading-5 font-medium break-words", check.result === "pass" ? "text-fg" : TONE_CLASSES[tone].text)}>
          {check.evidence}
        </p>
        <p className="mt-0.5 text-xs leading-5 text-muted">{check.explanation}</p>
        {target ? (
          <button
            type="button"
            onClick={onShow}
            onFocus={() => link.hover(target)}
            onBlur={() => link.hover(null)}
            data-testid="check-show-in-delivery"
            className="mt-1 inline-flex items-center gap-1 rounded-sm text-[13px] font-medium text-fg underline decoration-hairline-strong underline-offset-2 focus-ring hover:decoration-fg"
          >
            Show in the delivery
            <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </button>
        ) : null}
      </td>
      <td className="py-3 pr-3 max-sm:col-start-1 max-sm:py-0">
        <span className={CELL_LABEL}>Confidence</span>
        {check.evaluator === "deterministic" ? (
          <span className="font-mono text-xs text-muted" title="Measured by code: there is no confidence to report.">
            <span aria-hidden="true">— </span>measured
          </span>
        ) : (
          <ConfidenceBar value={check.confidence} threshold={threshold} label={`Confidence for ${check.ruleId}`} className="sm:pt-1.5" />
        )}
      </td>
      <td className="py-3 pr-1 max-sm:col-start-2 max-sm:row-start-3 max-sm:self-end max-sm:py-0 max-sm:text-right sm:text-right">
        <EvaluatorBadge evaluator={check.evaluator} />
      </td>
    </tr>
  );
}

const BANNER_CLASS: Record<DecisionBanner["tone"], { box: string; title: string }> = {
  success: { box: "border-success/25 bg-success-soft", title: "text-success" },
  hold: { box: "border-hold/30 bg-hold-soft", title: "text-hold" },
  review: { box: "border-review/25 bg-review-soft", title: "text-review" },
  danger: { box: "border-danger/25 bg-danger-soft", title: "text-danger" },
};

function Banner({ report, revisionLimit }: { report: VerificationReport; revisionLimit: number }) {
  const banner = decisionBanner(report, revisionLimit);
  const look = BANNER_CLASS[banner.tone];
  return (
    <div
      role="status"
      data-testid="verification-banner"
      data-decision={report.decision}
      className={cn("rounded-card border px-4 py-3", look.box)}
    >
      <p className={cn("text-sm leading-6 font-semibold", look.title)}>{banner.title}</p>
      <p className="text-sm leading-6 break-words text-fg/85">{banner.detail}</p>
    </div>
  );
}

function ReportBody({ report, deal }: { report: VerificationReport; deal: DealView }) {
  const link = useEvidenceLink();
  const threshold = deal.contract?.contract.settlement.autoCaptureMinConfidence ?? 0.85;
  const submission = deal.submissions.find((entry) => entry.round === report.round) ?? null;
  const spec = deal.contract?.contract.deliverables[0] ?? null;
  const grid = submission === null ? null : deliveryGrid(spec, submission);
  const active = link.target !== null && link.target.round === report.round ? link.target : null;

  function show(target: EvidenceTarget): void {
    link.pin(target);
    link.pickRound({ round: report.round, total: deal.submissions.length });
    document.getElementById("section-delivery")?.scrollIntoView({ block: "start" });
  }

  return (
    <div className="flex flex-col gap-3 px-1 pt-1 pb-1">
      <Banner report={report} revisionLimit={deal.revisions.limit} />
      {report.degraded ? (
        <Callout tone="warning" title="The AI verifier was unavailable" data-testid="verification-degraded">
          The conditions it judges were not evaluated and are marked uncertain. A condition nobody evaluated can never pass, so a
          human decides.
        </Callout>
      ) : null}
      <table className="w-full border-collapse max-sm:block sm:table-fixed" data-testid="verification-checks">
        <caption className="sr-only">
          {submissionLabel(report.round)} checked against the contract: condition, result, evidence, confidence and who judged it
        </caption>
        <colgroup className="max-sm:hidden">
          <col className="w-[22%]" />
          <col className="w-[5.5rem]" />
          <col />
          <col className="w-[6.75rem]" />
          <col className="w-[7.5rem]" />
        </colgroup>
        <thead className="max-sm:sr-only">
          <tr className="border-b border-hairline text-left">
            {["Condition", "Result", "Evidence", "Confidence", "Judged by"].map((heading, index) => (
              <th
                key={heading}
                scope="col"
                className={cn(
                  "py-2 pr-3 font-mono text-[10px] font-medium tracking-[0.08em] text-faint uppercase",
                  index === 0 && "pl-1",
                  index === 4 && "pr-1 text-right",
                )}
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="max-sm:block">
          {report.checks.map((check) => {
            const target = evidenceTarget(check, report.round, grid);
            return (
              <CheckRow
                key={check.ruleId}
                check={check}
                threshold={threshold}
                target={target}
                linked={active !== null && active.ruleId === check.ruleId}
                onShow={() => (target ? show(target) : undefined)}
              />
            );
          })}
        </tbody>
      </table>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-hairline pt-3 text-xs text-muted">
        <ShieldCheck aria-hidden="true" className="size-3.5" />
        Checked against contract
        <MonoId value={report.contractHash} label="contract hash" head={8} tail={4} copyable={false} />
        <span aria-hidden="true">·</span>
        <span>
          auto-capture needs every required condition to pass at ≥ {Math.round(threshold * 100)}% confidence
        </span>
        {report.model ? <ModelBadge model={report.model} source="ai" className="ml-auto" /> : null}
      </p>
    </div>
  );
}

function ReportItem({
  report,
  deal,
  expanded,
  onToggle,
}: {
  report: VerificationReport;
  deal: DealView;
  expanded: boolean;
  onToggle(): void;
}) {
  const panelId = useId();
  const tally = tallyChecks(report.checks);
  return (
    <li data-testid="verification-report" data-round={report.round} data-decision={report.decision} data-expanded={expanded} className="rounded-card border border-hairline">
      <h3>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggle}
          data-testid="verification-report-toggle"
          className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 rounded-card px-3.5 py-3 text-left focus-ring hover:bg-subtle/60"
        >
          <span className="text-sm font-semibold text-fg">
            Round {report.round} · {submissionLabel(report.round)}
          </span>
          <StatusPill tone={VERIFICATION_DECISION_TONE[report.decision]} size="sm">
            {VERIFICATION_DECISION_LABEL[report.decision]}
          </StatusPill>
          <span className="font-mono text-xs text-muted tabular-nums">
            {tally.passed} pass{tally.failed > 0 ? ` · ${tally.failed} fail` : ""}
            {tally.uncertain > 0 ? ` · ${tally.uncertain} uncertain` : ""}
          </span>
          <span className="ml-auto flex items-center gap-2 text-xs text-muted">
            {formatLocalClock(report.createdAt)}
            <ChevronDown aria-hidden="true" className={cn("size-4 transition-transform duration-150", expanded && "rotate-180")} />
          </span>
        </button>
      </h3>
      {expanded ? (
        <div id={panelId} className="border-t border-hairline px-2.5 py-3 sm:px-3.5">
          <ReportBody report={report} deal={deal} />
        </div>
      ) : (
        <p id={panelId} className="border-t border-hairline px-3.5 py-2 text-[13px] leading-5 break-words text-muted">
          {report.summary}
        </p>
      )}
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/*  Review gate                                                                */
/* -------------------------------------------------------------------------- */

const PARTIAL_MIN = 5;
const PARTIAL_MAX = 95;
const PARTIAL_STEP = 5;
const REASON_MAX = 300;

function PartialRelease({ priceMinor, sellerName, decision }: { priceMinor: number; sellerName: string; decision: UseDealDecision }) {
  const [open, setOpen] = useState(false);
  const [percent, setPercent] = useState(50);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const captured = percentOf(priceMinor, percent);
  const busy = decision.pending === "release_partial";

  async function submit(): Promise<void> {
    const trimmed = reason.trim();
    await decision.decide({ kind: "release_partial", percent, reason: trimmed === "" ? undefined : trimmed });
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : setOpen(next))}>
      <DialogTrigger asChild>
        <Button variant="secondary" disabled={decision.pending !== null} data-testid="release-partial" className="max-sm:w-full">
          Release part…
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Release part of the payment</DialogTitle>
          <DialogDescription>
            PACT captures the share you choose for {sellerName} and releases the rest of the hold back to the payer. This is final.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-muted">Captured for the seller</p>
              <Money
                amountMinor={captured}
                mutedCents
                data-testid="release-partial-amount"
                className="font-sans text-[2rem] leading-10 font-semibold tracking-[-0.03em] text-fg"
              />
            </div>
            <p className="pb-1.5 text-right text-[13px] leading-5 text-muted">
              <span className="font-mono font-semibold text-fg tabular-nums" data-testid="release-partial-percent">
                {percent}%
              </span>{" "}
              of {formatMoney(priceMinor)}
              <br />
              {formatMoney(priceMinor - captured)} released to the payer
            </p>
          </div>
          <Slider
            className="mt-3"
            min={PARTIAL_MIN}
            max={PARTIAL_MAX}
            step={PARTIAL_STEP}
            value={[percent]}
            onValueChange={([next]) => setPercent(next ?? percent)}
            thumbLabels={["Share of the contract price to capture"]}
            formatValue={(value) => `${value}%, ${formatMoney(percentOf(priceMinor, value))}`}
            data-testid="release-partial-slider"
          />
          <div className="mt-1 flex justify-between font-mono text-[11px] text-faint" aria-hidden="true">
            <span>{PARTIAL_MIN}%</span>
            <span>{PARTIAL_MAX}%</span>
          </div>
          <div className="mt-4 flex flex-col gap-1.5">
            <Label htmlFor={reasonId}>
              Reason <span className="font-normal text-muted">(optional, recorded in the audit trail)</span>
            </Label>
            <Textarea
              id={reasonId}
              rows={2}
              maxLength={REASON_MAX}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. One of the two illustrations is usable."
              data-testid="release-partial-reason"
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" disabled={busy}>
              Back
            </Button>
          </DialogClose>
          <Button loading={busy} onClick={() => void submit()} data-testid="release-partial-confirm">
            Capture {formatMoney(captured)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReviewGate({ deal, report, decision }: { deal: DealView; report: VerificationReport | null; decision: UseDealDecision }) {
  const options: readonly HumanDecisionKind[] = deal.next.kind === "human" ? deal.next.options : [];
  const price = deal.contract?.contract.price.amountMinor ?? deal.payment?.amountMinor ?? 0;
  const sellerName = deal.seller?.name ?? "the seller";
  const failed = report?.failedRuleIds.length ?? 0;
  const locked = decision.pending !== null;

  return (
    <GatePanel
      gate="review"
      title="Human review required"
      error={decision.error}
      figure={
        <>
          <Money amountMinor={price} mutedCents className="font-sans text-[2rem] leading-10 font-semibold tracking-[-0.03em] text-fg" />
          <p className="text-[13px] leading-5 text-fg/80">held for {sellerName}</p>
        </>
      }
      actions={
        <>
          {options.includes("release_payment") ? (
            failed > 0 ? (
              <ConfirmAction
                trigger={{ label: "Release payment", variant: "primary", testId: "release-payment", disabled: locked }}
                title={`Release despite ${plural(failed, "failed condition")}?`}
                description={`The verifier did not clear this delivery. Releasing captures ${formatMoney(price)} for ${sellerName}. A capture cannot be undone from here.`}
                confirmLabel={`Capture ${formatMoney(price)}`}
                confirmTestId="release-payment-confirm"
                onConfirm={() => decision.decide({ kind: "release_payment" })}
              />
            ) : (
              <Button
                loading={decision.pending === "release_payment"}
                disabled={locked}
                onClick={() => void decision.decide({ kind: "release_payment" })}
                data-testid="release-payment"
                className="max-sm:w-full"
              >
                Release payment
              </Button>
            )
          ) : null}
          {options.includes("release_partial") ? <PartialRelease priceMinor={price} sellerName={sellerName} decision={decision} /> : null}
          {options.includes("request_revision") ? (
            <Button
              variant="secondary"
              loading={decision.pending === "request_revision"}
              disabled={locked}
              onClick={() => void decision.decide({ kind: "request_revision" })}
              data-testid="request-revision"
              className="max-sm:w-full"
            >
              <RotateCcw aria-hidden="true" />
              Request revision
            </Button>
          ) : null}
          {options.includes("reject_delivery") ? (
            <ConfirmAction
              trigger={{ label: "Reject and void", testId: "reject-delivery", icon: <Undo2 aria-hidden="true" />, disabled: locked }}
              title="Reject the delivery and void the hold?"
              description={`Nothing is captured. The ${formatMoney(price)} authorization is voided and the funds go back to the payer. This ends the deal.`}
              confirmLabel="Reject and void"
              confirmTestId="reject-delivery-confirm"
              onConfirm={() => decision.decide({ kind: "reject_delivery" })}
            />
          ) : null}
        </>
      }
    >
      <p className="line-clamp-3 break-words">{report?.summary ?? "The verifier could not decide automatically."}</p>
      <p className="mt-1">The funds stay held until you choose. Nothing is captured automatically from here.</p>
    </GatePanel>
  );
}

const REVIEW_EVENT_TEXT: Record<string, string> = {
  "human.released_payment": "released the payment",
  "human.requested_revision": "asked the seller for a revision",
  "human.rejected_delivery": "rejected the delivery",
};

function ReviewRecords({ deal }: { deal: DealView }) {
  const records = deal.audit.filter((entry) => entry.type in REVIEW_EVENT_TEXT);
  if (records.length === 0) return null;
  const actor = deal.isOwner ? "You" : "The deal's owner";
  return (
    <ul className="mt-3 flex flex-col gap-1.5">
      {records.map((entry) => (
        <li key={entry.id} data-testid="review-record" data-type={entry.type} className="flex flex-wrap items-center gap-x-2 text-[13px] leading-5 font-medium text-review">
          <UserCheck aria-hidden="true" className="size-4" />
          {actor} {REVIEW_EVENT_TEXT[entry.type]}
          <span className="font-normal text-muted">
            · {formatLocalClock(entry.at)}
            {entry.detail ? ` · “${entry.detail}”` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

export interface VerificationSectionProps {
  deal: DealView;
  decision: UseDealDecision;
}

/** 07 — the evidence: every contract condition, what was observed, how sure, and who judged. */
export function VerificationSection({ deal, decision }: VerificationSectionProps) {
  const [pick, setPick] = useState<{ round: number; total: number } | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const { reports } = deal;
  const rounds = reports.map((report) => report.round);
  const current = selectedRound(rounds, pick);
  const latest = reports[reports.length - 1] ?? null;
  const verifying = deal.status === "submitted";
  const gateOpen = openGate(deal) === "review";
  // A round collapsed by hand stays collapsed only until the next report arrives.
  const expandedRound = collapsed && pick !== null && pick.total === rounds.length ? null : current;

  function toggle(round: number): void {
    const isOpen = expandedRound === round;
    setPick({ round, total: rounds.length });
    setCollapsed(isOpen);
  }

  return (
    <SectionCard
      id="verification"
      number="07"
      title="Verification"
      aside={
        latest ? (
          <StatusPill tone={VERIFICATION_DECISION_TONE[latest.decision]} size="sm" data-testid="verification-decision" data-decision={latest.decision}>
            {VERIFICATION_DECISION_LABEL[latest.decision]}
          </StatusPill>
        ) : null
      }
    >
      {reports.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {reports.map((report) => (
            <ReportItem key={report.id} report={report} deal={deal} expanded={expandedRound === report.round} onToggle={() => toggle(report.round)} />
          ))}
        </ul>
      ) : null}

      {verifying ? (
        <div className={cn(reports.length > 0 && "mt-4")} data-testid="verification-pending">
          <WorkingNote>
            Checking the delivery against each contract condition. Code measures what can be measured; the AI verifier reads the rest
            and can only propose.
          </WorkingNote>
        </div>
      ) : null}

      {gateOpen ? (
        <div className="mt-4">
          <ReviewGate deal={deal} report={latest} decision={decision} />
        </div>
      ) : null}

      {!deal.isOwner && deal.status === "in_review" ? (
        <Callout tone="info" className="mt-4">
          Waiting for the deal&apos;s owner to review this delivery. The funds stay held.
        </Callout>
      ) : null}

      <ReviewRecords deal={deal} />
    </SectionCard>
  );
}
