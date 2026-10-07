import { Bot, Cpu, FlaskConical, Store, TriangleAlert } from "lucide-react";
import { Badge, Callout, Card, cn } from "@/components/ui";
import type { ApiClientError } from "@/lib/client/api";
import { modelLabel } from "@/lib/client/deal-derive";
import type { AgentSource, SellerBehavior } from "@/lib/domain/schemas";
import type { SellerPublic } from "@/lib/domain/sellers";

/** Small mono label used above groups of facts inside a section. */
export function Eyebrow({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn("font-mono text-[11px] leading-4 font-medium tracking-[0.08em] text-faint uppercase", className)}
      {...props}
    />
  );
}

export interface SectionCardProps {
  /** Stage key: becomes the element id (`section-<id>`) and the test id. */
  id: string;
  /** Two-digit position in the lifecycle, e.g. "03". */
  number: string;
  title: string;
  /** Badges and controls on the right of the header. */
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/**
 * One stage of the deal. Sections mount when the deal reaches them, so the enter animation is
 * also the cue that something new happened (it is switched off under prefers-reduced-motion).
 */
export function SectionCard({ id, number, title, aside, children, className }: SectionCardProps) {
  const titleId = `section-${id}-title`;
  return (
    <section
      id={`section-${id}`}
      data-testid={`section-${id}`}
      data-live-anchor=""
      aria-labelledby={titleId}
      className={cn("animate-rise-in scroll-mt-44 scroll-mb-10", className)}
    >
      <Card>
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline px-4 py-3 sm:px-5">
          <span aria-hidden="true" className="font-mono text-[11px] leading-5 font-medium tracking-[0.08em] text-faint">
            {number}
          </span>
          <h2 id={titleId} className="text-[15px] leading-6 font-semibold tracking-[-0.01em] text-fg">
            {title}
          </h2>
          {aside ? <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{aside}</div> : null}
        </header>
        <div className="p-4 sm:p-5">{children}</div>
      </Card>
    </section>
  );
}

/** Which model produced something, or that a scripted fallback did. */
export function ModelBadge({
  model,
  source,
  className,
}: {
  model: string | null;
  source: AgentSource;
  className?: string;
}) {
  const scripted = source === "scripted";
  return (
    <Badge
      tone={scripted ? "hold" : "neutral"}
      variant="outline"
      className={className}
      title={scripted ? "A scripted agent produced this: no model call was made." : (model ?? undefined)}
      data-source={source}
    >
      {scripted ? <TriangleAlert aria-hidden="true" /> : <Cpu aria-hidden="true" />}
      {modelLabel(model, source)}
    </Badge>
  );
}

const DEMO_FAULT_LABEL: Record<Exclude<SellerBehavior, "reliable">, string> = {
  omits_variant: "Demo fault: omits a required variant on the first delivery",
  embeds_instructions: "Demo fault: hides instructions for the verifier in its files",
};

const DEMO_FAULT_SHORT: Record<Exclude<SellerBehavior, "reliable">, string> = {
  omits_variant: "Demo fault: omits a variant",
  embeds_instructions: "Demo fault: hostile delivery",
};

/** Honest label for the two sellers whose misbehaviour is scripted on purpose. */
export function DemoFaultBadge({ fault, short = false }: { fault: Exclude<SellerBehavior, "reliable">; short?: boolean }) {
  return (
    <Badge tone="hold" variant="outline" title={DEMO_FAULT_LABEL[fault]} data-testid="demo-fault-badge">
      <FlaskConical aria-hidden="true" />
      {short ? DEMO_FAULT_SHORT[fault] : DEMO_FAULT_LABEL[fault]}
    </Badge>
  );
}

export function TrustBadge({ trust }: { trust: SellerPublic["trust"] }) {
  return trust === "established" ? (
    <Badge tone="neutral" variant="outline">
      Established seller
    </Badge>
  ) : (
    <Badge tone="review" variant="outline">
      New seller
    </Badge>
  );
}

/** Round party marker used in the transcript, the contract and the audit trail. */
export function PartyIcon({ party, className }: { party: "buyer" | "seller"; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full border [&_svg]:size-3.5",
        party === "buyer" ? "border-info/25 bg-info-soft text-info" : "border-hairline-strong bg-subtle text-fg",
        className,
      )}
    >
      {party === "buyer" ? <Bot /> : <Store />}
    </span>
  );
}

/** "Simulated" wherever a payment is shown, when no PayPal credentials are configured. */
export function ProviderBadge({ simulated }: { simulated: boolean }) {
  return simulated ? (
    <Badge tone="hold" variant="outline" data-testid="provider-badge" data-provider="simulated" title="No PayPal credentials are configured: this payment is simulated in-process.">
      Simulated
    </Badge>
  ) : (
    <Badge tone="info" variant="outline" data-testid="provider-badge" data-provider="paypal_sandbox" title="Real PayPal Sandbox API calls. No real money moves.">
      PayPal Sandbox
    </Badge>
  );
}

/** A failed request, with the server's request id so it can be found in the logs. */
export function RequestError({
  error,
  title,
  action,
  className,
}: {
  error: Pick<ApiClientError, "message" | "requestId" | "code">;
  title?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <Callout tone="danger" title={title} action={action} className={className} data-testid="request-error">
      <p>{error.message}</p>
      {error.requestId ? (
        <p className="mt-0.5 font-mono text-xs text-muted">
          Request {error.requestId}
        </p>
      ) : null}
    </Callout>
  );
}

/** Placeholder for a section whose content is being produced right now. */
export function WorkingNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2.5 text-sm leading-6 text-muted">
      <span aria-hidden="true" className="mt-[9px] size-1.5 shrink-0 animate-pulse-dot rounded-full bg-info text-info" />
      <span>{children}</span>
    </p>
  );
}
