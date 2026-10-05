import { Ban, Bot, Check, Link2, X } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { Section } from "./section";

interface BoundaryItem {
  name: string;
  detail: string;
}

const AGENTS_DO: readonly BoundaryItem[] = [
  { name: "Negotiate", detail: "Buyer and seller agents exchange offers, inside the limits the human set." },
  { name: "Produce", detail: "The seller agent creates the deliverable and submits it for verification." },
  { name: "Assess", detail: "A verifier model judges the subjective conditions and attaches evidence and a confidence score." },
];

const AGENTS_NEVER: readonly BoundaryItem[] = [
  { name: "Move money", detail: "No model is given a tool that can authorize, capture or void. Only the payment engine calls PayPal." },
  { name: "Change limits", detail: "Spending policy is evaluated in code. An agent cannot raise its ceiling or approve its own spend." },
  { name: "Mark their own work as passed", detail: "A seller’s claim is never evidence. Capture needs a verification report bound to the contract hash." },
];

/** Three real audit event types, shown as an excerpt of the hash chain. */
const AUDIT_EXCERPT = [
  { seq: 14, actor: "verifier", type: "verification.completed", hash: "3b9e…a41c" },
  { seq: 15, actor: "payment_orchestrator", type: "payment.capture_blocked", hash: "c07d…52f0" },
  { seq: 16, actor: "seller_agent", type: "revision.requested", hash: "91aa…0e7b" },
] as const;

function BoundaryList({
  heading,
  kicker,
  items,
  allowed,
}: {
  heading: string;
  kicker: string;
  items: readonly BoundaryItem[];
  allowed: boolean;
}) {
  return (
    <div className="flex flex-col rounded-card border border-hairline bg-canvas p-6 sm:p-7">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "flex size-9 items-center justify-center rounded-control [&_svg]:size-[18px]",
            allowed ? "bg-info-soft text-info" : "bg-danger-soft text-danger",
          )}
        >
          {allowed ? <Bot /> : <Ban />}
        </span>
        <div>
          <p className="font-mono text-[11px] leading-4 font-medium tracking-[0.08em] text-muted uppercase">{kicker}</p>
          <h3 className="text-[17px] leading-6 font-semibold tracking-[-0.01em] text-fg">{heading}</h3>
        </div>
      </div>
      <ul className="mt-6 flex flex-col gap-5">
        {items.map((item) => (
          <li key={item.name} className="flex gap-3">
            <span
              aria-hidden="true"
              className={cn(
                "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full [&_svg]:size-3",
                allowed ? "bg-info-soft text-info" : "bg-danger-soft text-danger",
              )}
            >
              {allowed ? <Check strokeWidth={3} /> : <X strokeWidth={3} />}
            </span>
            <div>
              <p className="text-[15px] leading-6 font-semibold text-fg">{item.name}</p>
              <p className="mt-0.5 text-sm leading-6 text-pretty text-muted">{item.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Boundaries() {
  return (
    <Section
      id="boundaries"
      tone="band"
      eyebrow="The boundary"
      title="LLMs propose. Deterministic code decides."
      lead="Language models are useful and unreliable. PACT uses them for what they are good at and keeps them out of the money path entirely."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <BoundaryList kicker="Models propose" heading="What the agents do" items={AGENTS_DO} allowed />
        <BoundaryList kicker="Code decides" heading="What they can never do" items={AGENTS_NEVER} allowed={false} />
      </div>
      <div className="mt-4 grid items-center gap-6 rounded-card border border-hairline bg-canvas p-6 sm:p-7 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <p className="flex items-center gap-2 text-[15px] leading-6 font-semibold text-fg">
            <Link2 aria-hidden="true" className="size-4 text-accent" />
            A tamper-evident audit trail
          </p>
          <p className="mt-2 text-sm leading-6 text-pretty text-muted">
            Every proposal, decision and PayPal call is appended to a hash-chained log. Each entry includes the hash of
            the one before it, so you can replay exactly why a payment was captured, or why it was not.
          </p>
        </div>
        <ol
          aria-label="Example audit log entries"
          className="overflow-x-auto rounded-control border border-hairline bg-surface font-mono text-xs leading-5 lg:col-span-7"
        >
          {AUDIT_EXCERPT.map((entry) => (
            <li
              key={entry.seq}
              className="flex min-w-max items-center gap-4 border-b border-hairline px-4 py-2.5 last:border-b-0"
            >
              <span className="w-6 text-faint tabular-nums">#{entry.seq}</span>
              <span className="w-40 text-muted">{entry.actor}</span>
              <span className="flex-1 pr-4 font-medium text-fg">{entry.type}</span>
              <span className="text-faint">{entry.hash}</span>
            </li>
          ))}
        </ol>
      </div>
    </Section>
  );
}
