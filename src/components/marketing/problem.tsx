import { Section } from "./section";

interface Statement {
  claim: string;
  detail: string;
}

const STATEMENTS: readonly Statement[] = [
  {
    claim: "Agents can already negotiate and do the work.",
    detail:
      "A buyer agent and a seller agent can agree on scope, price and deadline, then produce the deliverable, with no human in the loop.",
  },
  {
    claim: "Payment rails still assume a human decides when work is done.",
    detail:
      "A checkout captures at the moment of purchase. Nothing in it asks whether what was promised has been delivered.",
  },
  {
    claim: "Paying up-front, or on the agent’s say-so, is how money gets lost.",
    detail:
      "A seller agent reporting its own success is a claim, not evidence. So is a buyer agent that was told the work is fine.",
  },
];

export function Problem() {
  return (
    <Section
      id="problem"
      eyebrow="The problem"
      title={
        <>
          Agents can do the work. <span className="sm:block">Payment rails can’t tell when it’s done.</span>
        </>
      }
    >
      <ol className="grid gap-px overflow-hidden rounded-card border border-hairline bg-hairline md:grid-cols-3">
        {STATEMENTS.map((statement, index) => (
          <li key={statement.claim} className="flex flex-col bg-surface p-6 sm:p-7">
            <span aria-hidden="true" className="font-mono text-xs font-medium text-faint tabular-nums">
              {String(index + 1).padStart(2, "0")}
            </span>
            <h3 className="mt-4 text-lg leading-7 font-semibold tracking-[-0.015em] text-balance text-fg">
              {statement.claim}
            </h3>
            <p className="mt-2.5 text-[15px] leading-6 text-pretty text-muted">{statement.detail}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}
