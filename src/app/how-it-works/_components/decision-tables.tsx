import Link from "next/link";
import { ArrowRight, Ban, CircleCheck, LockKeyhole, Undo2, UserCheck } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { VERIFICATION_DECISION_LABEL, VERIFICATION_DECISION_TONE } from "@/components/ui/status";
import { StatusPill } from "@/components/ui/status-pill";
import { TONE_CLASSES, type StatusTone } from "@/components/ui/tone";
import type { VerificationDecision } from "@/lib/domain/schemas";
import { VERIFICATION_ROWS, spendingControls, type SpendingControl } from "../content";

const HEAD = "px-5 pt-3 pb-2 text-left font-mono text-[10px] leading-4 font-medium tracking-[0.08em] text-faint uppercase";

/** What each decision does to the money, in the product's own colours: emerald captured, amber held, slate released. */
const MONEY: Record<VerificationDecision, { tone: StatusTone; icon: React.ReactNode }> = {
  capture_eligible: { tone: "success", icon: <CircleCheck /> },
  revision_required: { tone: "hold", icon: <LockKeyhole /> },
  reject: { tone: "neutral", icon: <Undo2 /> },
  human_review: { tone: "hold", icon: <LockKeyhole /> },
};

function Panel({
  title,
  lead,
  footer,
  children,
  testId,
}: {
  title: string;
  lead: string;
  footer: React.ReactNode;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <div data-testid={testId} className="flex flex-col overflow-hidden rounded-card border border-hairline bg-canvas">
      <div className="px-5 pt-5 pb-4">
        <h3 className="text-[17px] leading-6 font-semibold tracking-[-0.01em] text-fg">{title}</h3>
        <p className="mt-1.5 text-sm leading-6 text-pretty text-muted">{lead}</p>
      </div>
      <div className="border-t border-hairline">{children}</div>
      <div className="mt-auto border-t border-hairline bg-surface px-5 py-3.5 text-[13px] leading-5 text-pretty text-muted">{footer}</div>
    </div>
  );
}

function VerificationTable() {
  return (
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">Verification decisions and what happens to the authorized funds</caption>
      <thead>
        <tr>
          <th scope="col" className={cn(HEAD, "sm:w-[46%]")}>
            When<span className="sm:hidden">, decision and the money</span>
          </th>
          <th scope="col" className={cn(HEAD, "max-sm:hidden")}>
            Decision
          </th>
          <th scope="col" className={cn(HEAD, "max-sm:hidden")}>
            The money
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-hairline border-t border-hairline">
        {VERIFICATION_ROWS.map((row) => {
          const money = MONEY[row.decision];
          const pill = (
            <StatusPill tone={VERIFICATION_DECISION_TONE[row.decision]} size="sm">
              {VERIFICATION_DECISION_LABEL[row.decision]}
            </StatusPill>
          );
          const outcome = (
            <span className={cn("flex items-start gap-1.5 text-[13px] leading-5 font-medium", TONE_CLASSES[money.tone].text)}>
              <span aria-hidden="true" className="mt-[3px] shrink-0 [&_svg]:size-3.5">
                {money.icon}
              </span>
              {row.money}
            </span>
          );
          return (
            <tr key={row.decision} data-decision={row.decision} className="align-top">
              <td className="px-5 py-3.5 text-[13px] leading-5 text-pretty text-fg">
                {row.situation}
                {/* On a phone the decision and its consequence sit under the situation instead of in two more columns. */}
                <span className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 sm:hidden">
                  {pill}
                  {outcome}
                </span>
              </td>
              <td className="px-5 py-3.5 max-sm:hidden">{pill}</td>
              <td className="px-5 py-3.5 whitespace-nowrap max-sm:hidden">{outcome}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const EFFECT: Record<SpendingControl["effect"], { label: string; tone: StatusTone; icon: React.ReactNode }> = {
  block: { label: "Blocks the deal", tone: "danger", icon: <Ban aria-hidden="true" /> },
  needs_approval: { label: "Asks a human", tone: "review", icon: <UserCheck aria-hidden="true" /> },
};

function ControlsList() {
  return (
    <ol>
      {spendingControls().map((control, index) => {
        const effect = EFFECT[control.effect];
        return (
          <li key={control.id} data-control={control.id} className="flex gap-3.5 border-b border-hairline px-5 py-3.5 last:border-b-0">
            <span aria-hidden="true" className="mt-0.5 font-mono text-xs leading-5 font-medium text-faint tabular-nums">
              {String(index + 1).padStart(2, "0")}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <p className="text-sm leading-6 font-semibold text-fg">{control.label}</p>
                <StatusPill tone={effect.tone} size="sm" icon={effect.icon}>
                  {effect.label}
                </StatusPill>
              </div>
              <p className="mt-0.5 text-[13px] leading-5 text-pretty text-muted">{control.rule}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** The two decisions that gate money, side by side: may the agent spend, and has the work earned the capture. */
export function DecisionTables() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel
        testId="spending-controls"
        title="Before the hold: spending controls"
        lead="Five checks run on every contract, before any PayPal call. All five are always evaluated and reported, not just the first one that objects."
        footer={
          <Link href="/policies" className="inline-flex items-center gap-1 rounded-sm font-medium text-fg underline-offset-4 focus-ring hover:underline pointer-coarse:min-h-11">
            Set your limits and watch the outcome change
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        }
      >
        <ControlsList />
      </Panel>
      <Panel
        testId="verification-decisions"
        title="Before the capture: the verification decision"
        lead="Every contract condition gets a result, its evidence and a confidence. The decision is computed from those checks. It is never generated."
        footer="A model outage cannot release funds: a condition the AI could not answer counts as uncertain, and uncertain goes to a human."
      >
        <VerificationTable />
      </Panel>
    </div>
  );
}
