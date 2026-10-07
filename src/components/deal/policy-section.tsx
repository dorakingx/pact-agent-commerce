"use client";

import { Ban, CircleCheck, ThumbsUp, UserCheck } from "lucide-react";
import {
  Button,
  Callout,
  Money,
  POLICY_OUTCOME_LABEL,
  POLICY_OUTCOME_TONE,
  StatusPill,
  cn,
  type StatusTone,
} from "@/components/ui";
import type { DealView } from "@/lib/api/dto";
import { formatLocalClock, openGate } from "@/lib/client/deal-derive";
import type { UseDealDecision } from "@/lib/client/use-deal";
import type { PolicyCheck } from "@/lib/domain/schemas";
import { ConfirmAction, GatePanel } from "./gate-panel";
import { SectionCard } from "./parts";

type CheckOutcome = PolicyCheck["outcome"];

const CHECK_LOOK: Record<CheckOutcome, { tone: StatusTone; label: string; icon: React.ReactNode; text: string }> = {
  pass: { tone: "success", label: "Pass", icon: <CircleCheck />, text: "text-success" },
  needs_approval: { tone: "review", label: "Needs approval", icon: <UserCheck />, text: "text-review" },
  block: { tone: "danger", label: "Block", icon: <Ban />, text: "text-danger" },
};

function CheckRow({ check }: { check: PolicyCheck }) {
  const look = CHECK_LOOK[check.outcome];
  return (
    <li data-testid="policy-check" data-check-id={check.id} data-outcome={check.outcome} className="flex items-start gap-3 py-2.5">
      <span aria-hidden="true" className={cn("mt-1 shrink-0 [&_svg]:size-4", look.text)}>
        {look.icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-6 font-medium text-fg">{check.label}</p>
        <p className="text-[13px] leading-5 text-muted">{check.detail}</p>
      </div>
      <StatusPill tone={look.tone} size="sm" className="mt-0.5">
        {look.label}
      </StatusPill>
    </li>
  );
}

/** What the human decided at the approval gate, read from the audit trail (later decisions overwrite `humanDecision`). */
function approvalRecord(deal: DealView): { approved: boolean; at: string } | null {
  const event = deal.audit.find((entry) => entry.type === "human.approved_spend" || entry.type === "human.declined_spend");
  return event === undefined ? null : { approved: event.type === "human.approved_spend", at: event.at };
}

export interface PolicySectionProps {
  deal: DealView;
  decision: UseDealDecision;
}

/** 04 — the deterministic spending policy, and the approval gate it can open. */
export function PolicySection({ deal, decision }: PolicySectionProps) {
  const policy = deal.policy;
  if (policy === null) return null;
  const gateOpen = openGate(deal) === "approval";
  const waitingElsewhere = !deal.isOwner && deal.status === "awaiting_approval";
  const flagged = policy.checks.filter((check) => check.outcome === "needs_approval");
  const blocking = policy.checks.filter((check) => check.outcome === "block");
  const price = deal.contract?.contract.price.amountMinor ?? null;
  const record = approvalRecord(deal);
  const actor = deal.isOwner ? "You" : "The deal's owner";

  return (
    <SectionCard
      id="policy"
      number="04"
      title="Spending policy"
      aside={
        <StatusPill tone={POLICY_OUTCOME_TONE[policy.outcome]} size="sm" data-testid="policy-outcome" data-outcome={policy.outcome}>
          {POLICY_OUTCOME_LABEL[policy.outcome]}
        </StatusPill>
      }
    >
      <p className="text-[13px] leading-5 text-muted">
        Checked by deterministic code before any money is committed. The agents cannot change or skip these limits.
      </p>
      <ul className="mt-2 divide-y divide-hairline">
        {policy.checks.map((check) => (
          <CheckRow key={check.id} check={check} />
        ))}
      </ul>

      {blocking.length > 0 ? (
        <Callout tone="danger" title="Blocked by the spending policy" className="mt-4" data-testid="policy-blocked">
          {blocking.map((check) => check.detail).join(" ")} No PayPal order was created.
        </Callout>
      ) : null}

      {gateOpen ? (
        <div className="mt-4">
          <GatePanel
            gate="approval"
            title="Human approval required"
            error={decision.error}
            figure={
              price === null ? null : (
                <>
                  <Money amountMinor={price} mutedCents className="font-sans text-[2rem] leading-10 font-semibold tracking-[-0.03em] text-fg" />
                  <p className="text-[13px] leading-5 text-fg/80">to {deal.seller?.name ?? "the seller"}</p>
                </>
              )
            }
            actions={
              <>
                <Button
                  size="lg"
                  loading={decision.pending === "approve_spend"}
                  disabled={decision.pending !== null}
                  onClick={() => void decision.decide({ kind: "approve_spend" })}
                  data-testid="approve-spend"
                  className="max-sm:w-full"
                >
                  <ThumbsUp aria-hidden="true" />
                  Approve spend
                </Button>
                <ConfirmAction
                  trigger={{ label: "Decline", testId: "decline-spend", disabled: decision.pending !== null }}
                  title="Decline this spend?"
                  description="The deal ends here. No PayPal order is created and nothing is authorized. This cannot be undone."
                  confirmLabel="Decline spend"
                  confirmTestId="decline-spend-confirm"
                  onConfirm={() => decision.decide({ kind: "decline_spend" })}
                />
                <p className="text-[13px] leading-5 text-fg/75 sm:ml-auto">Approving does not pay: it lets PACT place the authorization hold.</p>
              </>
            }
          >
            <ul className="list-none">
              {flagged.map((check) => (
                <li key={check.id}>{check.detail}</li>
              ))}
            </ul>
          </GatePanel>
        </div>
      ) : null}

      {waitingElsewhere ? (
        <Callout tone="info" className="mt-4">
          Waiting for the deal&apos;s owner to approve or decline this spend.
        </Callout>
      ) : null}

      {record ? (
        <p
          data-testid="approval-record"
          data-approved={record.approved}
          className={cn("mt-3 flex items-center gap-2 text-[13px] leading-5 font-medium", record.approved ? "text-review" : "text-muted")}
        >
          <UserCheck aria-hidden="true" className="size-4" />
          {record.approved ? `${actor} approved this spend` : `${actor} declined this spend`}
          <span className="font-normal text-muted">· {formatLocalClock(record.at)}</span>
        </p>
      ) : null}
    </SectionCard>
  );
}
