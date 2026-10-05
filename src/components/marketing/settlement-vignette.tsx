import {
  ArrowRight,
  ArrowRightLeft,
  BadgeCheck,
  Check,
  CircleX,
  FileCheck2,
  LockKeyhole,
  MessageSquareText,
  PackageCheck,
  RotateCcw,
  ScanSearch,
  Undo2,
  UserCheck,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import { KeyValue, KeyValueList } from "@/components/ui/key-value";
import { Money } from "@/components/ui/money";
import { StatusPill } from "@/components/ui/status-pill";

/*
 * The hero vignette: a designed, static explanation of the product, not a screenshot.
 * Top: the settlement rail, with the fork that defines PACT (verified → capture, otherwise no
 * capture). Bottom: one concrete example, a contract next to the verification of a delivery
 * that misses one of its conditions.
 */

const EXAMPLE_PRICE_MINOR = 4700;

type RailTone = "plain" | "hold" | "success";

interface RailStep {
  id: string;
  label: string;
  caption: string;
  icon: React.ReactNode;
  tone: RailTone;
}

const RAIL: readonly RailStep[] = [
  { id: "intent", label: "Intent", caption: "A human sets the task and the budget", icon: <MessageSquareText />, tone: "plain" },
  { id: "negotiation", label: "Negotiation", caption: "Buyer and seller agents agree terms", icon: <ArrowRightLeft />, tone: "plain" },
  { id: "contract", label: "Contract", caption: "Terms compiled and hashed", icon: <FileCheck2 />, tone: "plain" },
  { id: "authorization", label: "PayPal authorization", caption: "Funds held, not captured", icon: <LockKeyhole />, tone: "hold" },
  { id: "delivery", label: "Delivery", caption: "The seller agent submits the work", icon: <PackageCheck />, tone: "plain" },
  { id: "verification", label: "AI verification", caption: "Checked against the contract", icon: <ScanSearch />, tone: "plain" },
  { id: "capture", label: "Capture", caption: "Only when the contract is satisfied", icon: <BadgeCheck />, tone: "success" },
];

const NODE_TONE: Record<RailTone, string> = {
  plain: "border-hairline-strong bg-surface text-fg",
  hold: "border-hold/40 bg-hold-soft text-hold",
  success: "border-accent bg-accent text-on-accent",
};

function Rail() {
  const lastIndex = RAIL.length - 1;
  return (
    <ol className="flex flex-col md:grid md:grid-cols-7">
      {RAIL.map((step, index) => {
        // The final connector is the "verification passes" edge of the fork.
        const passesEdge = index === lastIndex - 1;
        return (
          <li
            key={step.id}
            className="relative flex animate-rise-in gap-3.5 pb-5 last:pb-0 md:flex-col md:items-center md:gap-0 md:px-1.5 md:pb-0 md:text-center"
            style={{ animationDelay: `${index * 55}ms` }}
          >
            {index < lastIndex ? (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-10 bottom-1 left-[17.5px] w-px md:top-[17.5px] md:right-[calc(-50%+24px)] md:bottom-auto md:left-[calc(50%+24px)] md:h-px md:w-auto",
                  passesEdge ? "bg-accent" : "bg-hairline-strong",
                )}
              />
            ) : null}
            {passesEdge ? (
              <span
                aria-hidden="true"
                className="absolute top-[17.5px] left-full z-10 hidden -translate-x-1/2 -translate-y-1/2 bg-surface px-1.5 font-mono text-[10px] leading-none font-medium tracking-[0.06em] text-accent uppercase lg:block"
              >
                passes
              </span>
            ) : null}
            <span
              aria-hidden="true"
              className={cn(
                "relative z-10 flex size-9 shrink-0 items-center justify-center rounded-full border [&_svg]:size-4",
                NODE_TONE[step.tone],
                // The one live element of the vignette: the hold is the state PACT keeps open.
                step.tone === "hold" && "animate-pulse-dot",
              )}
            >
              {step.icon}
            </span>
            <span className="flex min-w-0 flex-col pt-1.5 md:mt-2.5 md:pt-0">
              <span className="text-[13px] leading-5 font-semibold text-fg">{step.label}</span>
              <span className="text-xs leading-[18px] text-muted md:hidden lg:block">{step.caption}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** What happens instead of capture when verification does not pass. */
function FailureBranch() {
  return (
    <div className="mt-6 md:mt-0 md:grid md:grid-cols-7">
      <div className="relative md:col-span-5 md:col-start-3 md:pt-10 lg:col-span-4 lg:col-start-4">
        {/* Drops from the "AI verification" column: its centre is 70% (md) / 62.5% (lg) across this block. */}
        <span aria-hidden="true" className="absolute top-2 left-[70%] hidden h-8 w-px bg-danger/50 md:block lg:left-[62.5%]" />
        <span
          aria-hidden="true"
          className="absolute top-6 left-[70%] z-10 hidden -translate-x-1/2 -translate-y-1/2 bg-surface px-1.5 py-0.5 font-mono text-[10px] leading-none font-medium tracking-[0.06em] text-danger uppercase md:block lg:left-[62.5%]"
        >
          fails
        </span>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 rounded-control border border-danger/25 bg-danger-soft/40 px-3 py-2.5 text-[13px] leading-5 md:ml-auto md:w-fit">
          <span className="inline-flex items-center gap-1.5 font-semibold text-danger">
            <CircleX aria-hidden="true" className="size-4" />
            Verification fails
          </span>
          <ArrowRight aria-hidden="true" className="size-3.5 text-faint" />
          <span className="font-semibold text-fg">No capture</span>
          <ArrowRight aria-hidden="true" className="size-3.5 text-faint" />
          <span className="flex flex-wrap items-center gap-1.5">
            <StatusPill tone="info" size="sm" icon={<RotateCcw aria-hidden="true" />}>
              Revision
            </StatusPill>
            <StatusPill tone="review" size="sm" icon={<UserCheck aria-hidden="true" />}>
              Human review
            </StatusPill>
            <StatusPill tone="neutral" size="sm" icon={<Undo2 aria-hidden="true" />}>
              Void
            </StatusPill>
          </span>
        </div>
      </div>
    </div>
  );
}

function ContractCard() {
  return (
    <div className="rounded-card border border-hairline bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-2.5">
        <p className="flex items-center gap-2 text-[13px] font-semibold text-fg">
          <FileCheck2 aria-hidden="true" className="size-4 text-muted" />
          Contract
        </p>
        <Badge tone="neutral" variant="outline">
          Machine-readable
        </Badge>
      </div>
      <KeyValueList dense className="px-4 py-2 text-[13px]">
        <KeyValue label="Price">
          <Money amountMinor={EXAMPLE_PRICE_MINOR} />
        </KeyValue>
        <KeyValue label="Deliverables">3 illustrations</KeyValue>
        <KeyValue label="Formats">16:9 + 1:1</KeyValue>
        <KeyValue label="Revisions">1</KeyValue>
        <KeyValue label="Terms hash">
          <span className="font-mono">a3f1…9c2e</span>
        </KeyValue>
      </KeyValueList>
    </div>
  );
}

interface ExampleCheck {
  condition: string;
  passed: boolean;
  evidence: string;
}

const EXAMPLE_CHECKS: readonly ExampleCheck[] = [
  { condition: "3 illustrations", passed: true, evidence: "3 supplied" },
  { condition: "1:1 format", passed: false, evidence: "missing on #2" },
];

function VerificationCard() {
  const headCell = "px-4 pt-3 pb-1 font-mono text-[10px] leading-4 font-medium tracking-[0.08em] text-faint uppercase";
  return (
    <div className="flex flex-col rounded-card border border-hairline bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-2.5">
        <p className="flex items-center gap-2 text-[13px] font-semibold text-fg">
          <ScanSearch aria-hidden="true" className="size-4 text-muted" />
          Verification
        </p>
        <StatusPill tone="hold" size="sm" icon={<LockKeyhole aria-hidden="true" />}>
          <span>
            <Money amountMinor={EXAMPLE_PRICE_MINOR} className="font-sans" /> still held
          </span>
        </StatusPill>
      </div>
      <table className="w-full border-collapse text-[13px]">
        <caption className="sr-only">Verification of the delivery against the contract</caption>
        <thead>
          <tr className="text-left">
            <th scope="col" className={headCell}>
              Condition
            </th>
            <th scope="col" className={cn(headCell, "px-0")}>
              Result
            </th>
            <th scope="col" className={cn(headCell, "text-right")}>
              Evidence
            </th>
          </tr>
        </thead>
        <tbody>
          {EXAMPLE_CHECKS.map((check) => (
            <tr key={check.condition}>
              <th scope="row" className="px-4 py-1.5 text-left font-medium text-fg">
                {check.condition}
              </th>
              <td className="py-1.5">
                <StatusPill
                  tone={check.passed ? "success" : "danger"}
                  size="sm"
                  icon={check.passed ? <Check aria-hidden="true" strokeWidth={3} /> : <X aria-hidden="true" strokeWidth={3} />}
                  className="font-mono text-[11px] tracking-[0.04em]"
                >
                  {check.passed ? "PASS" : "FAIL"}
                </StatusPill>
              </td>
              <td className="px-4 py-1.5 text-right text-muted">{check.evidence}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-auto border-t border-hairline px-4 py-2.5 text-xs leading-5 text-muted">
        <span className="font-semibold text-danger">Not captured.</span> One required condition failed, so the seller
        agent is asked to revise.
      </p>
    </div>
  );
}

export function SettlementVignette({ className }: { className?: string }) {
  return (
    <figure className={cn("overflow-hidden rounded-card border border-hairline bg-surface", className)}>
      <figcaption className="sr-only">
        How a deal settles in PACT. Intent, negotiation, contract, PayPal authorization, delivery and AI verification
        happen in order. If verification passes, the payment is captured. If it fails, nothing is captured and the
        deal goes to revision, human review or void. Example: a $47.00 contract for 3 illustrations in 16:9 and 1:1
        where the 1:1 version of the second illustration is missing, so the payment stays held.
      </figcaption>
      <div className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-2.5 sm:px-6">
        <p className="font-mono text-[11px] leading-5 font-medium tracking-[0.08em] text-muted uppercase">
          Settlement rail
        </p>
        <p className="hidden text-xs text-muted sm:block">Capture is a consequence of verification, never of a claim.</p>
      </div>
      <div className="px-4 pt-6 pb-5 sm:px-6 md:pt-7 md:pb-6">
        <Rail />
        <FailureBranch />
      </div>
      <div className="grid gap-3 border-t border-hairline bg-subtle/70 p-3 sm:gap-4 sm:p-4 md:grid-cols-2">
        <ContractCard />
        <VerificationCard />
      </div>
    </figure>
  );
}
