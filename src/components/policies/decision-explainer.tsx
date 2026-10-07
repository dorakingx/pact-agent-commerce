import Link from "next/link";
import { ArrowRight, ArrowUpRight, Bot, LockKeyhole, Scale } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { GITHUB_URL } from "@/components/shell/nav";

interface Step {
  kicker: string;
  title: string;
  body: React.ReactNode;
  icon: React.ReactNode;
  tone: string;
}

const STEPS: readonly Step[] = [
  {
    kicker: "Models propose",
    title: "The agent asks to commit funds",
    body: "The buyer agent negotiates a price with the seller agent. What it agrees to is a proposal, parsed against a strict schema, and nothing more.",
    icon: <Bot />,
    tone: "bg-info-soft text-info",
  },
  {
    kicker: "Code decides",
    title: "The policy engine answers",
    body: (
      <>
        <code className="font-mono text-[12px] text-fg">evaluatePolicy()</code> runs the five checks on this page with plain
        arithmetic: allow, ask a human, or block. Same input, same answer, and the result goes into the audit trail.
      </>
    ),
    icon: <Scale />,
    tone: "bg-review-soft text-review",
  },
  {
    kicker: "PayPal moves the money",
    title: "Funds are held, then captured on proof",
    body: "Only an allowed or human-approved deal reaches PayPal, as an authorization hold. Capture follows only after the delivery is verified against the contract.",
    icon: <LockKeyhole />,
    tone: "bg-hold-soft text-hold",
  },
];

const LINK =
  "inline-flex items-center gap-1 rounded-sm font-medium text-fg underline-offset-4 focus-ring hover:underline pointer-coarse:min-h-11";

/** "How decisions are made": the trust boundary in three steps, with the way to the long form. */
export function DecisionExplainer({ className }: { className?: string }) {
  return (
    <Card data-testid="policy-explainer" className={cn("overflow-hidden", className)}>
      <div className="px-5 pt-5 pb-4">
        <h2 className="text-[15px] leading-6 font-semibold tracking-[-0.01em] text-fg">How decisions are made</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-pretty text-muted">
          A spending decision is never a model&rsquo;s opinion. The agent can ask; only deterministic code can say yes, and
          only PayPal moves the money.
        </p>
      </div>
      <ol className="grid gap-px border-y border-hairline bg-hairline md:grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={step.kicker} className="flex flex-col bg-surface px-5 py-5">
            <div className="flex items-center gap-3">
              <span aria-hidden="true" className={cn("flex size-8 items-center justify-center rounded-control [&_svg]:size-4", step.tone)}>
                {step.icon}
              </span>
              <p className="font-mono text-[11px] leading-4 font-medium tracking-[0.08em] text-muted uppercase">
                <span className="text-faint tabular-nums">{String(index + 1).padStart(2, "0")}</span> {step.kicker}
              </p>
            </div>
            <h3 className="mt-3.5 text-[15px] leading-6 font-semibold text-fg">{step.title}</h3>
            <p className="mt-1 text-[13px] leading-5 text-pretty text-muted">{step.body}</p>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-3.5 text-[13px] leading-5">
        <Link href="/how-it-works" className={LINK}>
          How it works
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
        <a href={`${GITHUB_URL}/blob/main/docs/architecture.md`} target="_blank" rel="noopener noreferrer" className={cn(LINK, "text-muted hover:text-fg")}>
          Architecture
          <ArrowUpRight aria-hidden="true" className="size-3.5" />
        </a>
        <a href={`${GITHUB_URL}/blob/main/docs/security.md`} target="_blank" rel="noopener noreferrer" className={cn(LINK, "text-muted hover:text-fg")}>
          Security model
          <ArrowUpRight aria-hidden="true" className="size-3.5" />
        </a>
      </div>
    </Card>
  );
}
