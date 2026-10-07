"use client";

import { useState } from "react";
import { ArrowRightLeft, Braces, FileCheck2, FileText, Fingerprint, Link2, Scale } from "lucide-react";
import { Badge, Button, Money, MonoId, PaymentStatusPill, cn } from "@/components/ui";
import type { DealView } from "@/lib/api/dto";
import { canonicalOrder, formatLocalDateTime, settlementSentence } from "@/lib/client/deal-derive";
import { deliverableCountLabel, formatUtcTimestamp, joinList, languageName, plural } from "@/lib/domain/format";
import type { DeliverableSpec } from "@/lib/domain/schemas";
import { CopyButton } from "./copy-button";
import { EvaluatorBadge } from "./evaluator-badge";
import { Eyebrow, PartyIcon, SectionCard } from "./parts";

function deliverableLine(spec: DeliverableSpec): { headline: string; detail: string } {
  if (spec.kind === "illustration") {
    return {
      headline: deliverableCountLabel("illustration", spec.count),
      detail: `Each in ${joinList([...spec.aspectRatios])} · SVG${spec.style ? ` · ${spec.style}` : ""}`,
    };
  }
  return {
    headline: deliverableCountLabel("copy", spec.count),
    detail: `Each in ${joinList(spec.languages.map(languageName))} · ${spec.minWords}–${spec.maxWords} words${spec.tone ? ` · ${spec.tone}` : ""}`,
  };
}

function Term({ label, children, note }: { label: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt>
        <Eyebrow>{label}</Eyebrow>
      </dt>
      <dd className="mt-1 text-[15px] leading-6 font-semibold text-fg">{children}</dd>
      {note ? <dd className="text-xs leading-5 text-muted">{note}</dd> : null}
    </div>
  );
}

/** 03 — the contract as a document. The exact machine-readable artifact is one toggle away. */
export function ContractSection({ deal }: { deal: DealView }) {
  const [showJson, setShowJson] = useState(false);
  const signed = deal.contract;
  if (signed === null) return null;
  const { contract, termsHash, paymentState } = signed;
  const spec = contract.deliverables[0];
  const deliverable = deliverableLine(spec);
  const orderId = deal.payment?.orderId ?? null;
  // `contract` is printed in the key order it is hashed in; the hash and the live payment state sit beside it.
  const json = JSON.stringify({ contract: canonicalOrder(contract), termsHash, paymentState }, null, 2);

  return (
    <SectionCard
      id="contract"
      number="03"
      title="Contract"
      aside={
        <Button
          variant="secondary"
          size="sm"
          aria-pressed={showJson}
          onClick={() => setShowJson((shown) => !shown)}
          data-testid="contract-json-toggle"
        >
          {showJson ? <FileText aria-hidden="true" /> : <Braces aria-hidden="true" />}
          {showJson ? "View document" : "View JSON"}
        </Button>
      }
    >
      {showJson ? (
        <div data-testid="contract-json" className="overflow-hidden rounded-card border border-hairline">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline bg-subtle px-3.5 py-2">
            <p className="font-mono text-xs text-muted">
              <span className="text-fg">contract</span> is what the terms hash covers, in canonical key order · paymentState is live
            </p>
            <CopyButton text={json} label="Copy JSON" testId="contract-json-copy" />
          </div>
          <pre tabIndex={0} className="max-h-[30rem] overflow-auto bg-surface p-4 font-mono text-xs leading-5 text-fg focus-ring">
            {json}
          </pre>
        </div>
      ) : (
        <article data-testid="contract-document" className="overflow-hidden rounded-card border border-hairline-strong bg-surface">
          <header className="border-b border-hairline bg-subtle/60 px-4 py-4 sm:px-6">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <p className="flex items-center gap-2 font-mono text-[11px] leading-4 font-medium tracking-[0.08em] text-muted uppercase">
                <FileCheck2 aria-hidden="true" className="size-4 text-accent" />
                Service contract
              </p>
              <MonoId value={contract.contractId} label="contract id" head={8} tail={4} className="text-xs text-muted" />
              <Badge tone="neutral" variant="outline" className="ml-auto">
                Machine-readable · schema v{contract.schemaVersion}
              </Badge>
            </div>
            <h3 data-testid="contract-title" className="mt-2 text-lg leading-7 font-semibold tracking-[-0.015em] text-balance text-fg">
              {contract.title}
            </h3>
          </header>

          <div className="grid items-center gap-3 border-b border-hairline px-4 py-4 sm:grid-cols-[1fr_auto_1fr] sm:px-6">
            <div className="flex min-w-0 items-center gap-2.5">
              <PartyIcon party="buyer" />
              <div className="min-w-0">
                <Eyebrow>Buyer</Eyebrow>
                <p className="truncate text-sm font-semibold text-fg">{contract.buyer.name}</p>
              </div>
            </div>
            <ArrowRightLeft aria-hidden="true" className="hidden size-4 text-faint sm:block" />
            <div className="flex min-w-0 items-center gap-2.5 sm:justify-end sm:text-right">
              <PartyIcon party="seller" className="sm:order-2" />
              <div className="min-w-0">
                <Eyebrow>Seller</Eyebrow>
                <p className="truncate text-sm font-semibold text-fg">{contract.seller.name}</p>
              </div>
            </div>
          </div>

          <dl className="grid gap-x-6 gap-y-4 border-b border-hairline px-4 py-4 sm:grid-cols-2 sm:px-6 lg:grid-cols-[auto_1fr_1fr_auto]">
            <div className="min-w-0">
              <dt>
                <Eyebrow>Price</Eyebrow>
              </dt>
              <dd className="mt-0.5 flex items-baseline gap-1.5">
                <Money
                  amountMinor={contract.price.amountMinor}
                  mutedCents
                  data-testid="contract-price"
                  className="font-sans text-[2rem] leading-10 font-semibold tracking-[-0.03em] text-fg"
                />
                <span className="text-xs font-medium text-muted">{contract.price.currency}</span>
              </dd>
            </div>
            <Term label="Deliverables" note={deliverable.detail}>
              {deliverable.headline}
            </Term>
            <Term label="Deadline" note={formatUtcTimestamp(contract.deadline)}>
              {formatLocalDateTime(contract.deadline)}
            </Term>
            <Term label="Revisions">{contract.revisionLimit === 0 ? "None" : plural(contract.revisionLimit, "round")}</Term>
          </dl>

          <div className="border-b border-hairline px-4 py-4 sm:px-6">
            <Eyebrow>Conditions for payment · {contract.verificationRules.length}</Eyebrow>
            <ul data-testid="contract-rules" className="mt-2 divide-y divide-hairline">
              {contract.verificationRules.map((rule) => (
                <li key={rule.id} data-rule-id={rule.id} className="flex items-start gap-3 py-2">
                  <span className="mt-0.5 w-7 shrink-0 font-mono text-xs font-medium text-faint">{rule.id}</span>
                  <span className="min-w-0 flex-1 text-sm leading-6 text-fg">
                    {rule.description}
                    {rule.required ? null : <span className="text-muted"> (advisory)</span>}
                  </span>
                  <EvaluatorBadge evaluator={rule.evaluator} />
                </li>
              ))}
            </ul>
          </div>

          <div className="flex items-start gap-3 border-b border-hairline px-4 py-4 sm:px-6">
            <Scale aria-hidden="true" className="mt-1 size-4 shrink-0 text-muted" />
            <div>
              <Eyebrow>Settlement</Eyebrow>
              <p data-testid="contract-settlement" className="mt-1 text-sm leading-6 text-fg">
                {settlementSentence(contract)}
              </p>
            </div>
          </div>

          <footer className="flex flex-col gap-3 bg-subtle/60 px-4 py-3.5 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-center gap-2.5">
              <Fingerprint aria-hidden="true" className="size-4 shrink-0 text-accent" />
              <div className="min-w-0">
                <Eyebrow>Terms hash · SHA-256</Eyebrow>
                <MonoId value={termsHash} label="terms hash" head={16} tail={8} data-testid="contract-hash" className="text-[13px] text-fg" />
              </div>
            </div>
            <p
              data-testid="contract-binding"
              className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5", orderId ? "text-fg" : "text-muted")}
            >
              <Link2 aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
              {orderId ? "Bound to the PayPal order as custom_id" : "Will be bound to the PayPal order as custom_id"}
              {paymentState === "none" ? null : <PaymentStatusPill status={paymentState} size="sm" />}
            </p>
          </footer>
        </article>
      )}
    </SectionCard>
  );
}
