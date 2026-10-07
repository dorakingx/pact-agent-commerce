"use client";

import { useId, useState } from "react";
import { Ban, Check, CircleCheck, UserCheck, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import { POLICY_OUTCOME_LABEL, POLICY_OUTCOME_TONE } from "@/components/ui/status";
import { StatusPill } from "@/components/ui/status-pill";
import { Switch } from "@/components/ui/switch";
import { TONE_CLASSES, type StatusTone } from "@/components/ui/tone";
import { EXAMPLE_DEALS, POLICY_OUTCOME_CONSEQUENCE, previewExamples, type ExampleDeal, type ExamplePreview } from "@/lib/client/policy-derive";
import type { Category, Policy, PolicyCheck, PolicyOutcome } from "@/lib/domain/schemas";

/** The preview never shows `evaluatedAt`, so a fixed instant keeps rendering free of clock reads. */
const PREVIEW_INSTANT = new Date(0);

const CATEGORY_LABEL: Record<Category, string> = {
  illustration: "Illustration",
  copywriting: "Copywriting",
  translation: "Translation",
  other: "Other work",
  restricted: "Restricted work",
};

const OUTCOME_ICON: Record<PolicyOutcome, React.ReactNode> = {
  allow: <CircleCheck aria-hidden="true" />,
  needs_approval: <UserCheck aria-hidden="true" />,
  block: <Ban aria-hidden="true" />,
};

const CHECK_TONE: Record<PolicyCheck["outcome"], StatusTone> = {
  pass: "success",
  needs_approval: "review",
  block: "danger",
};

const CHECK_ICON: Record<PolicyCheck["outcome"], React.ReactNode> = {
  pass: <Check strokeWidth={3} />,
  needs_approval: <UserCheck strokeWidth={2.5} />,
  block: <X strokeWidth={3} />,
};

/** Spoken with the label, so the result is never carried by the glyph or its colour alone. */
const CHECK_TEXT: Record<PolicyCheck["outcome"], string> = {
  pass: "passes",
  needs_approval: "needs your approval",
  block: "blocks the deal",
};

function ExampleHeading({ example, pill }: { example: ExampleDeal; pill: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <Money amountMinor={example.amountMinor} className="text-[15px] leading-6 font-semibold text-fg" />
        {/* Only the outcome is a live region: a changed verdict is announced, the reasoning under it is not read out on every keystroke. */}
        <span aria-live="polite" className="inline-flex">
          {pill}
        </span>
      </div>
      <h3 className="mt-1 text-[13px] leading-5 font-medium text-fg">{example.title}</h3>
      <p className="text-xs leading-[18px] text-muted">
        {example.seller.name} · {example.seller.trust === "new" ? "new seller" : "established seller"} ·{" "}
        {CATEGORY_LABEL[example.category].toLowerCase()}
      </p>
    </div>
  );
}

function CheckItem({ check, explain }: { check: PolicyCheck; explain: boolean }) {
  const tone = TONE_CLASSES[CHECK_TONE[check.outcome]];
  const showDetail = explain || check.outcome !== "pass";
  return (
    <li data-check={check.id} data-outcome={check.outcome} className={cn("flex gap-1.5", showDetail && "basis-full")}>
      <span
        aria-hidden="true"
        className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full [&_svg]:size-2.5", tone.soft, tone.text)}
      >
        {CHECK_ICON[check.outcome]}
      </span>
      <span className="min-w-0 text-[13px] leading-5">
        <span className={cn("font-medium", check.outcome === "pass" ? "text-fg" : tone.text)}>{check.label}</span>
        <span className="sr-only"> {CHECK_TEXT[check.outcome]}.</span>
        {showDetail ? <span className="block text-xs leading-[18px] text-pretty text-muted">{check.detail}</span> : null}
      </span>
    </li>
  );
}

function ExampleResult({ preview, explain }: { preview: ExamplePreview; explain: boolean }) {
  const { example, evaluation } = preview;
  return (
    <li data-testid={`policy-preview-${example.id}`} data-outcome={evaluation.outcome} className="px-5 py-4">
      <ExampleHeading
        example={example}
        pill={
          <StatusPill
            // Remounting on a change replays the entrance, which is what draws the eye to a flipped outcome.
            key={evaluation.outcome}
            tone={POLICY_OUTCOME_TONE[evaluation.outcome]}
            size="sm"
            icon={OUTCOME_ICON[evaluation.outcome]}
            data-testid={`policy-preview-${example.id}-outcome`}
            className="animate-pop-in"
          >
            {POLICY_OUTCOME_LABEL[evaluation.outcome]}
          </StatusPill>
        }
      />
      <ul aria-label="Policy checks" className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
        {evaluation.checks.map((check) => (
          <CheckItem key={check.id} check={check} explain={explain} />
        ))}
      </ul>
      <p className="mt-2.5 border-t border-dashed border-hairline pt-2 text-xs leading-[18px] text-muted">
        <span className={cn("font-medium", TONE_CLASSES[POLICY_OUTCOME_TONE[evaluation.outcome]].text)}>Result:</span>{" "}
        {POLICY_OUTCOME_CONSEQUENCE[evaluation.outcome]}
      </p>
    </li>
  );
}

function ExamplePlaceholder({ example }: { example: ExampleDeal }) {
  return (
    <li data-testid={`policy-preview-${example.id}`} data-outcome="unknown" className="px-5 py-4">
      <ExampleHeading
        example={example}
        pill={
          <StatusPill tone="neutral" size="sm">
            Waiting for valid limits
          </StatusPill>
        }
      />
    </li>
  );
}

export interface PolicyPreviewProps {
  /** The form's current values as a policy, or null while an amount cannot be read. */
  policy: Policy | null;
  spentTodayMinor: number;
  className?: string;
}

/**
 * "What would happen": three example deals run through the real policy engine with the values
 * currently in the form. It re-evaluates on every keystroke — there is no request, no model
 * and no debounce, because the engine is a pure function.
 */
export function PolicyPreview({ policy, spentTodayMinor, className }: PolicyPreviewProps) {
  const [explain, setExplain] = useState(false);
  const explainId = useId();
  const previews = policy === null ? null : previewExamples(policy, spentTodayMinor, PREVIEW_INSTANT);
  return (
    <Card data-testid="policy-preview" className={className}>
      <div className="border-b border-hairline px-5 pt-4 pb-3.5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[15px] leading-6 font-semibold tracking-[-0.01em] text-fg">What would happen</h2>
          <Badge tone="info" variant="soft">
            <span aria-hidden="true" className="size-1.5 animate-pulse-dot rounded-full bg-current" />
            Live preview
          </Badge>
        </div>
        <p className="mt-1 text-[13px] leading-5 text-pretty text-muted">
          Three example deals run through <code className="font-mono text-xs text-fg">evaluatePolicy()</code>, the engine
          the server uses, with the values in the form right now. Plain arithmetic. No model is asked.
        </p>
      </div>
      <ul aria-label="Example deals" className="divide-y divide-hairline">
        {previews === null
          ? EXAMPLE_DEALS.map((example) => <ExamplePlaceholder key={example.id} example={example} />)
          : previews.map((preview) => <ExampleResult key={preview.example.id} preview={preview} explain={explain} />)}
      </ul>
      <div className="flex items-center justify-between gap-4 border-t border-hairline px-5 py-3">
        <Label htmlFor={explainId} className="text-[13px] font-normal text-muted">
          Explain every check
        </Label>
        <Switch id={explainId} checked={explain} onCheckedChange={setExplain} data-testid="policy-preview-explain" />
      </div>
    </Card>
  );
}
