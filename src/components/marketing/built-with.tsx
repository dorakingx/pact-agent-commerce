import { Section } from "./section";

interface StackGroup {
  area: string;
  name: string;
  parts: string;
}

/* Text only, by design: no third-party logos. */
const STACK: readonly StackGroup[] = [
  { area: "Payments", name: "PayPal Sandbox", parts: "Orders v2, Payments v2, Vault, Webhooks" },
  { area: "Agents", name: "Vercel AI SDK via AI Gateway", parts: "Gemini 2.5 Flash, GPT-5 mini" },
  { area: "Operations", name: "AG Studio", parts: "AG Grid, AG Charts" },
  { area: "Platform", name: "Next.js", parts: "Postgres" },
];

export function BuiltWith() {
  return (
    <Section
      id="built-with"
      eyebrow="Built with"
      title={
        <>
          Real payment APIs. <span className="sm:block">Two independent model families.</span>
        </>
      }
      lead="The buyer and seller agents run on different models on purpose: in agent-to-agent commerce the two sides are separate systems."
    >
      <dl className="grid gap-px overflow-hidden rounded-card border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-4">
        {STACK.map((group) => (
          <div key={group.area} className="bg-surface p-5 sm:p-6">
            <dt className="font-mono text-[11px] leading-4 font-medium tracking-[0.08em] text-muted uppercase">
              {group.area}
            </dt>
            <dd className="mt-3">
              <p className="text-[15px] leading-6 font-semibold text-fg">{group.name}</p>
              <p className="mt-1 text-sm leading-6 text-muted">{group.parts}</p>
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
