"use client";

import { useState } from "react";
import { Check, CircleCheck, ExternalLink, Minus, Scale, Sparkles, TriangleAlert, Webhook, X } from "lucide-react";
import {
  Badge,
  Button,
  Callout,
  KeyValue,
  KeyValueList,
  Money,
  MonoId,
  PaymentStatusPill,
  Stepper,
  paymentRailSteps,
} from "@/components/ui";
import type { DealView, ReconciliationView } from "@/lib/api/dto";
import { formatLocalDateTime, fundsView, modelLabel, openGate, safeApproveUrl } from "@/lib/client/deal-derive";
import { useReconciliation, type UseDeal, type UseDealDecision } from "@/lib/client/use-deal";
import type { PaymentRecord } from "@/lib/payments/types";
import { FundsFigures } from "./funds";
import { ConfirmAction, GatePanel } from "./gate-panel";
import { Eyebrow, ProviderBadge, RequestError, SectionCard, WorkingNote } from "./parts";

function approvalModeLabel(payment: PaymentRecord): string {
  if (payment.mode === "delegated") return "Delegated agent wallet";
  return payment.status === "created" ? "Waiting for the payer in PayPal" : "Approved by payer in PayPal";
}

function WebhookTicks({ payment, simulated }: { payment: PaymentRecord; simulated: boolean }) {
  const confirmed = (["authorized", "captured", "voided"] as const).filter((event) => payment.webhookConfirmed[event]);
  if (confirmed.length === 0) {
    return <span className="font-normal text-muted">{simulated ? "None (the simulator sends no webhooks)" : "None received yet"}</span>;
  }
  return (
    <span className="flex flex-wrap justify-end gap-1.5" data-testid="webhook-confirmations">
      {confirmed.map((event) => (
        <Badge key={event} tone="success" data-event={event}>
          <Webhook aria-hidden="true" />
          <span className="capitalize">{event}</span>
        </Badge>
      ))}
    </span>
  );
}

function Missing() {
  return (
    <span className="font-normal text-faint">
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not yet</span>
    </span>
  );
}

function PaymentFacts({ payment, simulated }: { payment: PaymentRecord; simulated: boolean }) {
  return (
    <div className="grid gap-x-8 md:grid-cols-2">
      <KeyValueList divided dense>
        <KeyValue label="Provider">
          <ProviderBadge simulated={simulated} />
        </KeyValue>
        <KeyValue label="Approval">{approvalModeLabel(payment)}</KeyValue>
        <KeyValue label="Payer">{payment.payerEmailMasked ?? <Missing />}</KeyValue>
        <KeyValue label="Hold expires">
          {payment.authorizationExpiresAt && payment.status === "authorized" ? (
            formatLocalDateTime(payment.authorizationExpiresAt)
          ) : (
            <Missing />
          )}
        </KeyValue>
      </KeyValueList>
      <KeyValueList divided dense className="max-md:border-t max-md:border-hairline">
        <KeyValue label="PayPal order">
          {payment.orderId ? <MonoId value={payment.orderId} label="PayPal order id" head={10} tail={4} data-testid="payment-order-id" /> : <Missing />}
        </KeyValue>
        <KeyValue label="Authorization">
          {payment.authorizationId ? (
            <MonoId value={payment.authorizationId} label="PayPal authorization id" head={10} tail={4} data-testid="payment-authorization-id" />
          ) : (
            <Missing />
          )}
        </KeyValue>
        <KeyValue label="Capture">
          {payment.captureId ? <MonoId value={payment.captureId} label="PayPal capture id" head={10} tail={4} data-testid="payment-capture-id" /> : <Missing />}
        </KeyValue>
        <KeyValue label="Confirmed by PayPal webhook">
          <WebhookTicks payment={payment} simulated={simulated} />
        </KeyValue>
      </KeyValueList>
    </div>
  );
}

const RECONCILE_TONE: Record<ReconciliationView["status"], "success" | "danger" | "warning"> = {
  match: "success",
  mismatch: "danger",
  unavailable: "warning",
};

/** The headline names the provider that was actually read: a simulated record is never called PayPal's. */
function reconcileTitle(status: ReconciliationView["status"], provider: string): string {
  switch (status) {
    case "match":
      return `PACT's ledger matches the ${provider} record`;
    case "mismatch":
      return `PACT's ledger and the ${provider} record disagree`;
    case "unavailable":
      return `The ${provider} record could not be read`;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function Reconciliation({ view, simulated }: { view: ReconciliationView; simulated: boolean }) {
  const provider = simulated ? "Simulated PayPal" : "PayPal";
  return (
    <div data-testid="reconciliation" data-status={view.status} className="mt-4 animate-rise-in">
      <Callout tone={RECONCILE_TONE[view.status]} title={reconcileTitle(view.status, provider)}>
        Checked {formatLocalDateTime(view.checkedAt)} by re-reading the order from {provider} and comparing it field by field. This
        comparison is deterministic and is the source of truth.
      </Callout>
      {view.facts.length > 0 ? (
        <table className="mt-3 w-full border-collapse text-[13px] max-sm:block">
          <caption className="sr-only">Field-by-field comparison of PACT&apos;s ledger with {provider}</caption>
          <thead className="max-sm:sr-only">
            <tr className="text-left">
              {["Field", "PACT ledger", provider, "Match"].map((heading) => (
                <th key={heading} scope="col" className="border-b border-hairline px-0 py-2 pr-3 font-mono text-[10px] font-medium tracking-[0.08em] text-faint uppercase last:pr-0 last:text-right">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="max-sm:block">
            {view.facts.map((fact) => (
              <tr key={fact.field} data-testid="reconciliation-fact" data-match={fact.match} className="border-b border-hairline max-sm:grid max-sm:grid-cols-[1fr_auto] max-sm:gap-x-3 max-sm:py-2">
                <th scope="row" className="py-2 pr-3 text-left font-medium text-fg max-sm:col-span-1 max-sm:py-0">
                  {fact.field}
                </th>
                <td className="py-2 pr-3 font-mono text-xs break-all text-fg max-sm:col-start-1 max-sm:py-0">
                  <span className="font-sans text-muted sm:hidden">PACT: </span>
                  {fact.pact ?? "—"}
                </td>
                <td className="py-2 pr-3 font-mono text-xs break-all text-fg max-sm:col-start-1 max-sm:py-0">
                  <span className="font-sans text-muted sm:hidden">{provider}: </span>
                  {fact.paypal ?? "—"}
                </td>
                <td className="py-2 text-right max-sm:col-start-2 max-sm:row-span-3 max-sm:row-start-1 max-sm:self-center max-sm:py-0">
                  {fact.match ? (
                    <span className="inline-flex items-center gap-1 font-medium text-success">
                      <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />
                      Match
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 font-medium text-danger">
                      <X aria-hidden="true" className="size-3.5" strokeWidth={3} />
                      Differs
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {view.narrative ? (
        <figure data-testid="reconciliation-narrative" className="mt-3 rounded-control border border-info/20 bg-info-soft/60 px-3.5 py-3">
          <figcaption className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium text-info">
            <Sparkles aria-hidden="true" className="size-3.5" />
            Auditor agent
            <span className="font-normal text-muted">
              · read-only PayPal Agent Toolkit: {view.toolCalls.length > 0 ? view.toolCalls.map((call) => call.tool).join(", ") : "no tool call"}
              {view.model ? ` · ${modelLabel(view.model, "ai")}` : ""}
            </span>
          </figcaption>
          <blockquote className="mt-1.5 text-sm leading-6 text-fg">{view.narrative}</blockquote>
          <p className="mt-1.5 text-xs leading-5 text-muted">The statement is a summary. The table above decides the result.</p>
        </figure>
      ) : (
        <p data-testid="reconciliation-note" className="mt-3 flex items-start gap-2 text-[13px] leading-5 text-muted">
          <Minus aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {view.note ?? "Deterministic comparison only: the auditor agent did not run."}
        </p>
      )}
    </div>
  );
}

export interface PaymentSectionProps {
  deal: DealView;
  decision: UseDealDecision;
  refresh: UseDeal["refresh"];
}

/** 05 — where the money is: held, captured or released, with PayPal's own identifiers. */
export function PaymentSection({ deal, decision, refresh }: PaymentSectionProps) {
  const reconciliation = useReconciliation(deal.id, refresh);
  const [leaving, setLeaving] = useState(false);
  const payment = deal.payment;
  const simulated = deal.flags.simulatedPayment;
  const funds = fundsView(deal);
  const sellerName = deal.seller?.name ?? "the seller";
  const gateOpen = openGate(deal) === "payment";
  const approveUrl = safeApproveUrl(payment?.approveUrl);
  const canReconcile = payment !== null && payment.orderId !== null && (payment.status === "captured" || payment.status === "voided");

  function approveInPayPal(): void {
    if (approveUrl === null) return;
    setLeaving(true);
    // A full navigation: the approval page is PayPal's (or the simulator's), not a route of this screen.
    window.location.assign(approveUrl);
  }

  return (
    <SectionCard
      id="payment"
      number="05"
      title="Payment"
      aside={
        <>
          <ProviderBadge simulated={simulated} />
          {payment ? <PaymentStatusPill status={payment.status} size="sm" data-testid="payment-status" /> : null}
        </>
      }
    >
      <FundsFigures funds={funds} sellerName={sellerName} />

      {payment === null ? (
        <div className="mt-4">
          <WorkingNote>Creating the {simulated ? "simulated " : ""}PayPal order for the exact contract price…</WorkingNote>
        </div>
      ) : (
        <>
          <div className="mt-5 rounded-card border border-hairline px-3 py-4 sm:px-5">
            <Eyebrow className="mb-3 px-1">Payment rail</Eyebrow>
            <Stepper aria-label="Payment rail" steps={paymentRailSteps(payment)} size="sm" className="sm:hidden" />
            <Stepper aria-label="Payment rail" steps={paymentRailSteps(payment)} className="hidden sm:flex" />
          </div>

          {gateOpen ? (
            <div className="mt-4">
              <GatePanel
                gate="payment"
                title="Approve the authorization hold"
                error={decision.error}
                figure={
                  <>
                    <Money amountMinor={payment.amountMinor} mutedCents className="font-sans text-[2rem] leading-10 font-semibold tracking-[-0.03em] text-fg" />
                    <p className="text-[13px] leading-5 text-fg/80">held, not captured</p>
                  </>
                }
                actions={
                  <>
                    <Button
                      size="lg"
                      loading={leaving}
                      disabled={approveUrl === null || decision.pending !== null}
                      onClick={approveInPayPal}
                      data-testid="approve-in-paypal"
                      className="max-sm:w-full"
                    >
                      <ExternalLink aria-hidden="true" />
                      Approve in PayPal
                    </Button>
                    <ConfirmAction
                      trigger={{ label: "Cancel deal", testId: "cancel-payment", disabled: decision.pending !== null || leaving }}
                      title="Cancel this deal?"
                      description="The PayPal order is abandoned and the deal ends. Nothing was authorized, so nothing needs to be released."
                      confirmLabel="Cancel deal"
                      confirmTestId="cancel-payment-confirm"
                      onConfirm={() => decision.decide({ kind: "cancel_payment" })}
                    />
                    {simulated ? (
                      <p className="flex items-center gap-1.5 text-[13px] leading-5 text-fg/75 sm:ml-auto">
                        <TriangleAlert aria-hidden="true" className="size-3.5 text-hold" />
                        Simulated: the approval page is PACT&apos;s stand-in for PayPal.
                      </p>
                    ) : null}
                  </>
                }
              >
                {approveUrl === null ? (
                  <p>The approval link is missing or not a PayPal address, so it was not opened. Cancel the deal and start again.</p>
                ) : (
                  <p>
                    The order is for the exact contract price and carries the contract&apos;s terms hash. Approving places a hold on the
                    payer&apos;s account. PACT captures it only after the delivery is verified, and releases it otherwise.
                  </p>
                )}
              </GatePanel>
            </div>
          ) : null}

          {!deal.isOwner && deal.status === "awaiting_payment" ? (
            <Callout tone="info" className="mt-4">
              Waiting for the deal&apos;s owner to approve the hold in PayPal.
            </Callout>
          ) : null}

          {payment.lastError ? (
            <Callout tone="danger" title={`PayPal reported: ${payment.lastError.issue}`} className="mt-4" data-testid="payment-error">
              <p>{payment.lastError.message}</p>
              {payment.lastError.debugId ? (
                <p className="mt-0.5 font-mono text-xs text-muted">PayPal debug id {payment.lastError.debugId}</p>
              ) : null}
            </Callout>
          ) : null}

          <div className="mt-4">
            <PaymentFacts payment={payment} simulated={simulated} />
          </div>

          {canReconcile ? (
            <div className="mt-5 border-t border-hairline pt-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-semibold text-fg">
                    <Scale aria-hidden="true" className="size-4 text-muted" />
                    Independent reconciliation
                  </p>
                  <p className="text-[13px] leading-5 text-muted">
                    Re-read the order from {simulated ? "the simulated provider" : "PayPal"} and compare it with PACT&apos;s ledger.
                  </p>
                </div>
                <Button variant="secondary" loading={reconciliation.pending} onClick={() => void reconciliation.run()} data-testid="reconcile">
                  {reconciliation.result ? <CircleCheck aria-hidden="true" /> : null}
                  {reconciliation.result ? "Reconcile again" : "Reconcile with PayPal"}
                </Button>
              </div>
              {reconciliation.error ? (
                <RequestError error={reconciliation.error} title="Reconciliation failed" className="mt-3" />
              ) : null}
              {reconciliation.result ? <Reconciliation view={reconciliation.result} simulated={simulated} /> : null}
            </div>
          ) : null}
        </>
      )}
    </SectionCard>
  );
}
