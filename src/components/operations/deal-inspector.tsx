"use client";

/**
 * Deal inspector: the drill-down from a ledger row to the contract, the policy result, the
 * payment and the evidence behind the latest verification.
 *
 * It opens instantly with what the ledger row already knows (money, status, PayPal ids, risk)
 * and loads the full deal for the parts a row cannot carry (contract terms, policy checks,
 * verification conditions). Only user-facing fields are shown: a check's evidence and
 * explanation, never a model's reasoning.
 */
import { useState } from "react";
import { ArrowUpRight, CircleCheck, CircleHelp, CircleX, FlaskConical, ShieldAlert, Sparkles, TriangleAlert } from "lucide-react";
import {
  Badge,
  Button,
  CHECK_RESULT_LABEL,
  CHECK_RESULT_TONE,
  Callout,
  ConfidenceBar,
  DealStatusPill,
  KeyValue,
  KeyValueList,
  LinkButton,
  Money,
  MonoId,
  POLICY_OUTCOME_LABEL,
  POLICY_OUTCOME_TONE,
  PaymentStatusPill,
  RelativeTime,
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Skeleton,
  StatusPill,
  TONE_CLASSES,
  VERIFICATION_DECISION_LABEL,
  VERIFICATION_DECISION_TONE,
  cn,
  formatPercent,
  type StatusTone,
} from "@/components/ui";
import type { DealView, OpsRow } from "@/lib/api/dto";
import {
  CATEGORY_LABEL,
  DEMO_FAULT_DETAIL,
  RISK_LABEL,
  approvalModeLabel,
  deadlineState,
  deliverableLine,
  demoFaultOf,
  providerLabel,
  revisionsLabel,
  sortChecksForReview,
  tallyChecks,
  tallyLabel,
} from "@/lib/client/ops-derive";
import { useOpsDeal } from "@/lib/client/use-ops";
import { formatMoney } from "@/lib/domain/money";
import type { CheckResult, PolicyCheck, VerificationCheck, VerificationReport } from "@/lib/domain/schemas";
import { OpsRequestError } from "./request-error";
import { DEADLINE_TONE, RISK_TONE } from "./tones";

const LOCAL_DATE_TIME = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function localDateTime(iso: string | null): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : LOCAL_DATE_TIME.format(date);
}

function Section({ title, aside, children, testId }: { title: string; aside?: React.ReactNode; children: React.ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} className="border-t border-hairline px-5 py-4 first:border-t-0">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h3 className="text-[13px] leading-5 font-semibold text-fg">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Figure({ label, amountMinor, tone, testId }: { label: string; amountMinor: number; tone?: StatusTone; testId: string }) {
  const emphasised = tone !== undefined && amountMinor > 0;
  return (
    <div
      data-testid={testId}
      className={cn(
        "rounded-control border px-3 py-2.5",
        emphasised ? cn(TONE_CLASSES[tone].soft, TONE_CLASSES[tone].line) : "border-hairline bg-subtle/60",
      )}
    >
      <dt className={cn("text-xs font-medium", emphasised ? TONE_CLASSES[tone].text : "text-muted")}>{label}</dt>
      <dd className="mt-0.5">
        <Money amountMinor={amountMinor} mutedCents className="font-sans text-lg leading-7 font-semibold text-fg" />
      </dd>
    </div>
  );
}

function IdValue({ value, label }: { value: string | null; label: string }) {
  return value === null ? <span className="font-normal text-faint">—</span> : <MonoId value={value} label={label} head={10} tail={6} />;
}

const RESULT_ICON: Record<CheckResult, React.ReactNode> = {
  pass: <CircleCheck />,
  fail: <CircleX />,
  uncertain: <CircleHelp />,
};

function ConditionRow({ check }: { check: VerificationCheck }) {
  const evaluator = check.evaluator === "ai" ? `AI evaluator · confidence ${formatPercent(check.confidence)}` : "Deterministic check";
  return (
    <li data-testid="inspector-condition" data-result={check.result} className="py-2.5 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-[13px] leading-5 font-medium text-fg">
          <span className="mr-1.5 font-mono text-xs font-normal text-faint">{check.ruleId}</span>
          {check.condition}
          {check.required ? null : <span className="ml-1.5 text-xs font-normal text-faint">(advisory)</span>}
        </p>
        <StatusPill tone={CHECK_RESULT_TONE[check.result]} size="sm" icon={RESULT_ICON[check.result]}>
          {CHECK_RESULT_LABEL[check.result]}
        </StatusPill>
      </div>
      <p className="mt-0.5 text-[13px] leading-5 break-words text-muted">
        <span className="font-medium text-fg/80">Evidence:</span> {check.evidence}
      </p>
      {/* A pass needs no commentary; a failure or an open question gets the verifier's user-facing explanation. */}
      {check.result !== "pass" && check.explanation && check.explanation !== check.evidence ? (
        <p className="mt-1 text-[13px] leading-5 text-fg/85">{check.explanation}</p>
      ) : null}
      <p className="mt-0.5 text-xs text-faint tabular-nums">{evaluator}</p>
    </li>
  );
}

function VerificationSection({ deal, report }: { deal: DealView; report: VerificationReport }) {
  const threshold = deal.contract?.contract.settlement.autoCaptureMinConfidence;
  const tally = tallyChecks(report.checks);
  return (
    <Section
      testId="inspector-verification"
      title={`Latest verification · round ${report.round}`}
      aside={
        <StatusPill tone={VERIFICATION_DECISION_TONE[report.decision]} size="sm" data-testid="inspector-decision">
          {VERIFICATION_DECISION_LABEL[report.decision]}
        </StatusPill>
      }
    >
      <p className="text-[13px] leading-5 text-muted">{report.summary}</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="text-xs font-medium text-fg tabular-nums">{tallyLabel(tally)}</span>
        <ConfidenceBar
          value={report.confidence}
          threshold={threshold}
          tone={VERIFICATION_DECISION_TONE[report.decision]}
          label="Weakest required check"
          className="min-w-40 flex-1"
        />
      </div>
      {threshold === undefined ? null : (
        <p className="mt-1.5 text-xs text-faint">
          Weakest required check {formatPercent(report.confidence)}. Capture is automatic at {formatPercent(threshold)} or above.
        </p>
      )}
      {report.degraded ? (
        <Callout tone="warning" className="mt-3" title="AI evaluator unavailable">
          The AI-evaluated conditions were marked uncertain, so this delivery could not be captured automatically.
        </Callout>
      ) : null}
      <ul className="mt-3 divide-y divide-hairline border-t border-hairline pt-3">
        {sortChecksForReview(report.checks).map((check) => (
          <ConditionRow key={check.ruleId} check={check} />
        ))}
      </ul>
    </Section>
  );
}

const POLICY_CHECK_TONE: Record<PolicyCheck["outcome"], StatusTone> = { pass: "success", needs_approval: "review", block: "danger" };
const POLICY_CHECK_ICON: Record<PolicyCheck["outcome"], React.ReactNode> = {
  pass: <CircleCheck />,
  needs_approval: <ShieldAlert />,
  block: <CircleX />,
};
const POLICY_CHECK_WORD: Record<PolicyCheck["outcome"], string> = { pass: "Pass", needs_approval: "Needs approval", block: "Blocked" };

function PolicySection({ deal }: { deal: DealView }) {
  const policy = deal.policy;
  if (policy === null) {
    return (
      <Section title="Spending policy" testId="inspector-policy">
        <p className="text-[13px] leading-5 text-muted">Not evaluated yet. Policy runs once the contract is compiled, before any PayPal call.</p>
      </Section>
    );
  }
  return (
    <Section
      testId="inspector-policy"
      title="Spending policy"
      aside={
        <StatusPill tone={POLICY_OUTCOME_TONE[policy.outcome]} size="sm">
          {POLICY_OUTCOME_LABEL[policy.outcome]}
        </StatusPill>
      }
    >
      <ul className="flex flex-col gap-2">
        {policy.checks.map((check) => (
          <li key={check.id} data-outcome={check.outcome} className="flex items-start gap-2.5 text-[13px] leading-5">
            <span aria-hidden="true" className={cn("mt-0.5 shrink-0 [&_svg]:size-4", TONE_CLASSES[POLICY_CHECK_TONE[check.outcome]].text)}>
              {POLICY_CHECK_ICON[check.outcome]}
            </span>
            <span className="min-w-0">
              <span className="font-medium text-fg">{check.label}</span>
              <span className="sr-only"> ({POLICY_CHECK_WORD[check.outcome]})</span>
              <span className="text-muted"> · {check.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      {deal.humanDecision ? (
        <p className="mt-2.5 text-xs text-faint">
          Last human decision: {deal.humanDecision.kind.replaceAll("_", " ")}
          {deal.humanDecision.percent === null ? "" : ` (${deal.humanDecision.percent}%)`} · <RelativeTime value={deal.humanDecision.decidedAt} />
        </p>
      ) : null}
    </Section>
  );
}

function ContractSection({ deal }: { deal: DealView }) {
  const signed = deal.contract;
  if (signed === null) {
    return (
      <Section title="Contract" testId="inspector-contract">
        <p className="text-[13px] leading-5 text-muted">
          No contract yet. {deal.negotiation.status === "failed" ? "The agents did not reach an agreement." : "The agents are still negotiating the terms."}
        </p>
      </Section>
    );
  }
  const { contract } = signed;
  const settlement = contract.settlement;
  return (
    <Section title="Contract" testId="inspector-contract">
      <KeyValueList dense divided>
        <KeyValue label="Parties">
          {contract.buyer.name} <span className="font-normal text-faint">→</span> {contract.seller.name}
        </KeyValue>
        <KeyValue label="Deliverables">{contract.deliverables.map(deliverableLine).join("; ")}</KeyValue>
        <KeyValue label="Deadline">{localDateTime(contract.deadline) ?? "—"}</KeyValue>
        <KeyValue label="Revisions used">{`${deal.revisions.used} / ${deal.revisions.limit}`}</KeyValue>
        <KeyValue label="Conditions">
          {contract.verificationRules.length} ({contract.verificationRules.filter((rule) => rule.evaluator === "ai").length} judged by AI)
        </KeyValue>
        <KeyValue label="Terms hash">
          <MonoId value={signed.termsHash} label="terms hash" head={10} tail={6} />
        </KeyValue>
      </KeyValueList>
      <p className="mt-2.5 text-xs leading-[1.125rem] text-faint">
        Captured only when every required condition is verified at {formatPercent(settlement.autoCaptureMinConfidence)} confidence or more. Below that a
        human decides; if revisions run out, the authorization is voided. The terms hash is bound to the PayPal order as its custom id.
      </p>
    </Section>
  );
}

function PaymentSection({ row, deal }: { row: OpsRow; deal: DealView | undefined }) {
  const provider = providerLabel(row.paymentProvider);
  const mode = approvalModeLabel(row.paymentMode);
  const expires = localDateTime(deal?.payment?.authorizationExpiresAt ?? null);
  const lastError = deal?.payment?.lastError ?? null;
  return (
    <Section
      testId="inspector-payment"
      title="Payment"
      aside={row.paymentStatus === "none" ? undefined : <PaymentStatusPill status={row.paymentStatus} size="sm" />}
    >
      {row.paymentStatus === "none" ? (
        <p className="text-[13px] leading-5 text-muted">No PayPal order yet. Nothing has been authorized for this deal.</p>
      ) : (
        <KeyValueList dense divided>
          <KeyValue label="Rail">
            <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
              {provider ? (
                <Badge tone={row.paymentProvider === "simulated" ? "neutral" : "info"} variant="outline" data-testid="inspector-provider">
                  {provider}
                </Badge>
              ) : null}
              {mode ? <span className="font-normal text-muted">{mode}</span> : null}
            </span>
          </KeyValue>
          <KeyValue label="PayPal order id">
            <IdValue value={row.paypalOrderId} label="PayPal order id" />
          </KeyValue>
          <KeyValue label="Authorization id">
            <IdValue value={row.paypalAuthorizationId} label="authorization id" />
          </KeyValue>
          <KeyValue label="Capture id">
            <IdValue value={row.paypalCaptureId} label="capture id" />
          </KeyValue>
          {expires && row.paymentStatus === "authorized" ? <KeyValue label="Hold expires">{expires}</KeyValue> : null}
          <KeyValue label="Webhook">
            {row.webhookConfirmed ? (
              <span className="inline-flex items-center gap-1.5 text-success">
                <CircleCheck aria-hidden="true" className="size-3.5" />
                Confirmed by PayPal
              </span>
            ) : (
              <span className="font-normal text-muted">Not confirmed by webhook</span>
            )}
          </KeyValue>
        </KeyValueList>
      )}
      {row.paymentProvider === "simulated" ? (
        <p className="mt-2.5 text-xs leading-[1.125rem] text-faint">
          Simulated payment: no PayPal credentials are configured on this server, so the order, authorization and capture are produced by PACT&apos;s
          labelled simulator.
        </p>
      ) : null}
      {lastError ? (
        <Callout tone="danger" className="mt-3" title={`Last payment error: ${lastError.issue}`}>
          {lastError.message}
          {lastError.debugId ? <span className="mt-1 block font-mono text-[11px] text-muted">PayPal debug id {lastError.debugId}</span> : null}
        </Callout>
      ) : null}
    </Section>
  );
}

function DetailSkeleton() {
  return (
    <div data-testid="inspector-loading" role="status" aria-label="Loading the deal" className="border-t border-hairline px-5 py-4">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-3 h-3.5 w-full" />
      <Skeleton className="mt-2 h-3.5 w-5/6" />
      <Skeleton className="mt-2 h-3.5 w-2/3" />
      <Skeleton className="mt-6 h-4 w-32" />
      <Skeleton className="mt-3 h-3.5 w-full" />
      <Skeleton className="mt-2 h-3.5 w-4/5" />
      <Skeleton className="mt-6 h-4 w-40" />
      <Skeleton className="mt-3 h-12 w-full" />
      <Skeleton className="mt-2 h-12 w-full" />
    </div>
  );
}

function InspectorBody({ row }: { row: OpsRow }) {
  const { deal, error, isLoading, retry } = useOpsDeal(row.id, row.updatedAt);
  const fault = demoFaultOf(row.sellerId);
  const deadline = deadlineState(row);
  const latestReport = deal?.reports[deal.reports.length - 1];
  return (
    <>
      <SheetHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <MonoId value={row.code} label="deal code" full className="text-[13px] font-medium text-muted" />
          <DealStatusPill status={row.status} size="sm" data-testid="inspector-status" />
        </div>
        <SheetTitle data-testid="inspector-title">{row.title}</SheetTitle>
        <SheetDescription className="flex flex-col gap-1 text-[13px] leading-5">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-fg">{row.seller}</span>
            {row.sellerTrust === "new" ? (
              <Badge tone="review">
                <Sparkles aria-hidden="true" />
                New seller
              </Badge>
            ) : null}
            <span>
              {row.category ? `${CATEGORY_LABEL[row.category]} · ` : ""}updated <RelativeTime value={row.updatedAt} />
            </span>
          </span>
          {fault ? (
            <span data-testid="inspector-demo-fault" className="flex items-start gap-1.5 text-xs leading-[1.125rem] font-medium text-danger">
              <FlaskConical aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              {DEMO_FAULT_DETAIL[fault]}
            </span>
          ) : null}
        </SheetDescription>
      </SheetHeader>

      <SheetBody className="p-0">
        <Section title="Money" testId="inspector-money">
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Figure testId="inspector-price" label="Price" amountMinor={row.priceMinor} />
            <Figure testId="inspector-authorized" label="Authorized" amountMinor={row.authorizedMinor} />
            <Figure testId="inspector-held" label="Held now" amountMinor={row.heldMinor} tone="hold" />
            <Figure testId="inspector-captured" label="Captured" amountMinor={row.capturedMinor} tone="success" />
          </dl>
          <p className="mt-2.5 text-xs leading-[1.125rem] text-faint">
            {row.priceMinor === 0
              ? "No contract price yet."
              : row.savedMinor > 0
                ? `Negotiated ${formatMoney(row.savedMinor)} below the seller's opening quote of ${formatMoney(row.listPriceMinor)}, in ${row.negotiationMoves} moves.`
                : `Agreed at the seller's opening quote, in ${row.negotiationMoves} moves.`}
            {row.deadline ? (
              <>
                {" "}
                Deadline {localDateTime(row.deadline)}
                {deadline.relative ? (
                  <span className={cn("font-medium", deadline.urgency === "none" ? "text-muted" : TONE_CLASSES[DEADLINE_TONE[deadline.urgency]].text)}>
                    {" "}
                    ({deadline.relative})
                  </span>
                ) : null}
                .
              </>
            ) : null}
          </p>
        </Section>

        {row.riskReasons.length > 0 ? (
          <Section
            testId="inspector-risk"
            title="Why this deal is flagged"
            aside={
              <StatusPill tone={RISK_TONE[row.risk]} size="sm">
                {RISK_LABEL[row.risk]} risk
              </StatusPill>
            }
          >
            <ul className="flex flex-col gap-1.5">
              {row.riskReasons.map((reason) => (
                <li key={reason} className="flex items-start gap-2 text-[13px] leading-5 text-fg">
                  <TriangleAlert aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", TONE_CLASSES[RISK_TONE[row.risk]].text)} />
                  {reason}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <PaymentSection row={row} deal={deal} />

        {deal ? (
          <>
            {deal.flags.aiDegraded ? (
              <div className="border-t border-hairline px-5 py-4">
                <Callout tone="warning" title="An AI step fell back">
                  A model call failed on this deal, so a scripted agent or a degraded verification was used. The deterministic checks ran as usual.
                </Callout>
              </div>
            ) : null}
            <ContractSection deal={deal} />
            <PolicySection deal={deal} />
            {latestReport ? (
              <VerificationSection deal={deal} report={latestReport} />
            ) : (
              <Section title="Latest verification" testId="inspector-verification">
                <p className="text-[13px] leading-5 text-muted">
                  Nothing has been verified yet. Revisions used: {revisionsLabel(row)}.
                </p>
              </Section>
            )}
            {deal.flags.auditChainValid ? null : (
              <div className="border-t border-hairline px-5 py-4">
                <Callout tone="danger" title="Audit chain failed verification">
                  The hash chain of this deal&apos;s audit log did not verify on read. Open the deal to inspect the trail.
                </Callout>
              </div>
            )}
          </>
        ) : error ? (
          <div className="border-t border-hairline px-5 py-4">
            <OpsRequestError
              testId="inspector-error"
              title="The contract and verification details could not be loaded"
              error={error}
              onRetry={retry}
            />
          </div>
        ) : isLoading ? (
          <DetailSkeleton />
        ) : null}
      </SheetBody>

      <SheetFooter className="justify-between">
        <SheetClose asChild>
          <Button variant="ghost">Close</Button>
        </SheetClose>
        <LinkButton href={`/deals/${row.id}`} data-testid="inspector-open-deal">
          Open deal
          <ArrowUpRight aria-hidden="true" />
        </LinkButton>
      </SheetFooter>
    </>
  );
}

export interface DealInspectorProps {
  /** The ledger row to inspect, or null when the inspector is closed. */
  row: OpsRow | null;
  onClose: () => void;
  /**
   * Where keyboard focus goes when the inspector closes: the grid cell (or dashboard control) it
   * was opened from. The sheet has no trigger button of its own to return to.
   */
  returnFocusTo?: () => HTMLElement | null;
}

export function DealInspector({ row, onClose, returnFocusTo }: DealInspectorProps) {
  // The sheet animates out after `row` turns null; keeping the last row lets it leave with its content.
  const [shown, setShown] = useState<OpsRow | null>(row);
  if (row !== null && row !== shown) setShown(row);
  return (
    <Sheet open={row !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent
        data-testid="deal-inspector"
        className="w-[min(35rem,calc(100vw-1rem))]"
        // Focus the panel itself rather than its first control (a copy button), so the content is
        // read from the top and a mouse user does not get a stray focus ring.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocusTo?.() ?? null;
          if (target === null || !target.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        {shown ? <InspectorBody row={shown} /> : <SheetTitle className="sr-only">Deal inspector</SheetTitle>}
      </SheetContent>
    </Sheet>
  );
}
