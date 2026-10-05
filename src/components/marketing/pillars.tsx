import { FileCheck2, LockKeyhole, ScanSearch, UserCheck } from "lucide-react";
import { Section } from "./section";

interface Pillar {
  title: string;
  body: string;
  /** Short, literal specifics: the part an engineer would look for. */
  facts: readonly string[];
  icon: React.ReactNode;
}

const PILLARS: readonly Pillar[] = [
  {
    title: "Machine-readable contract",
    body: "Agreed terms compile into a contract with a deterministic hash. The PayPal order carries that hash, so a payment can only settle against the contract it was created for.",
    facts: ["SHA-256 terms hash", "Bound to the PayPal order"],
    icon: <FileCheck2 />,
  },
  {
    title: "Fulfillment-gated payment",
    body: "PACT authorizes first: funds are held, not moved. It captures only when the delivery is verified, and voids the authorization when it is not.",
    facts: ["Authorize, then capture", "Void otherwise"],
    icon: <LockKeyhole />,
  },
  {
    title: "Verification with evidence",
    body: "Deterministic checks and an AI verifier evaluate each contract condition. Every condition gets a result, the evidence behind it and a confidence score.",
    facts: ["Per-condition result", "Evidence and confidence"],
    icon: <ScanSearch />,
  },
  {
    title: "Human control",
    body: "A spending policy sets what the agent may commit alone. Above the limit a human approves, and when the verifier is unsure a human decides.",
    facts: ["Spending limits", "Review when unsure"],
    icon: <UserCheck />,
  },
];

export function Pillars() {
  return (
    <Section
      id="how-it-works"
      tone="band"
      eyebrow="How PACT works"
      title="Payment becomes a consequence of verified delivery."
      lead="Four mechanisms sit between an agent’s promise and the seller’s payout. Each one is enforced in code and recorded."
    >
      <ul className="grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
        {PILLARS.map((pillar) => (
          <li key={pillar.title} className="flex flex-col">
            <span
              aria-hidden="true"
              className="flex size-10 items-center justify-center rounded-control bg-accent-soft text-accent [&_svg]:size-5"
            >
              {pillar.icon}
            </span>
            <h3 className="mt-5 text-[17px] leading-6 font-semibold tracking-[-0.01em] text-fg">{pillar.title}</h3>
            <p className="mt-2 text-[15px] leading-6 text-pretty text-muted">{pillar.body}</p>
            <ul className="mt-auto flex flex-col gap-1.5 pt-5 font-mono text-xs leading-5 text-fg">
              {pillar.facts.map((fact) => (
                <li key={fact} className="flex items-center gap-2">
                  <span aria-hidden="true" className="h-px w-3 shrink-0 bg-accent" />
                  {fact}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Section>
  );
}
