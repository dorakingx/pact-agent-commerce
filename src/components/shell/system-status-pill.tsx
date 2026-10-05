import { StatusPill } from "@/components/ui/status-pill";
import type { StatusTone } from "@/components/ui/tone";

export interface SystemStatusPillProps {
  /** Active payment provider. `unknown` until the health endpoint has answered. */
  provider: "paypal_sandbox" | "simulated" | "unknown";
  /** Whether agents call live models or the scripted fallback. */
  ai: "ai" | "scripted" | "unknown";
  className?: string;
}

type Provider = SystemStatusPillProps["provider"];
type AiMode = SystemStatusPillProps["ai"];

const PROVIDER: Record<Provider, { tone: StatusTone; label: string; detail: string }> = {
  paypal_sandbox: {
    tone: "success",
    label: "PayPal Sandbox · live",
    detail: "Payments are real PayPal Sandbox API calls. No real money moves.",
  },
  simulated: {
    tone: "hold",
    label: "Simulated payments",
    detail: "No PayPal credentials are configured, so payments are simulated in-process.",
  },
  unknown: {
    tone: "neutral",
    label: "Sandbox demo",
    detail: "Payment provider status has not been loaded.",
  },
};

const AI_DETAIL: Record<AiMode, string> = {
  ai: "Agents run on live models.",
  scripted: "Agents are scripted: no model calls are made.",
  unknown: "",
};

/**
 * Honest, always-visible statement of what is real in this deployment. Presentational only:
 * the caller supplies the values (from `/api/health`).
 */
export function SystemStatusPill({ provider, ai, className }: SystemStatusPillProps) {
  const p = PROVIDER[provider];
  return (
    <StatusPill tone={p.tone} size="sm" pulse={provider === "paypal_sandbox"} data-provider={provider} data-ai={ai} className={className}>
      <span>
        {p.label}
        {/* Scripted agents are a material caveat, so it is shown, not just announced. */}
        {ai === "scripted" ? " · scripted agents" : null}
      </span>
      <span className="sr-only">
        {" "}
        {p.detail} {AI_DETAIL[ai]}
      </span>
    </StatusPill>
  );
}
