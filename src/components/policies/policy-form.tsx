"use client";

import { useId } from "react";
import { CircleAlert, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/components/ui/cn";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { TONE_CLASSES } from "@/components/ui/tone";
import {
  AUTO_CAPTURE_MIN_PERCENT,
  EDITABLE_CATEGORIES,
  MONEY_FIELDS,
  confidenceRules,
  type DraftAction,
  type FieldErrors,
  type MoneyField as MoneyFieldName,
  type PolicyDraft,
  type SpendBand,
} from "@/lib/client/policy-derive";
import type { Category } from "@/lib/domain/schemas";
import { LimitBands } from "./limit-bands";
import { MoneyField } from "./money-field";

const MONEY_FIELD_COPY: Record<MoneyFieldName, { id: string; label: string; hint: string }> = {
  autonomousLimitMinor: {
    id: "policy-autonomous-limit",
    label: "Autonomous limit",
    hint: "Up to this amount the agent commits funds on its own.",
  },
  maxTransactionMinor: {
    id: "policy-max-transaction",
    label: "Per-transaction maximum",
    hint: "Anything above this is blocked outright.",
  },
  dailyLimitMinor: {
    id: "policy-daily-limit",
    label: "Daily limit",
    hint: "The most the agent may authorize in one UTC day.",
  },
};

const CATEGORY_COPY: Record<Category, { label: string; description: string }> = {
  illustration: { label: "Illustration", description: "Vector illustrations, banners and hero art." },
  copywriting: { label: "Copywriting", description: "Product descriptions and launch copy." },
  translation: { label: "Translation", description: "Localising existing text." },
  other: { label: "Other work", description: "Requests no listed category covers." },
  restricted: { label: "Restricted work", description: "Refused by the engine whatever this policy says." },
};

export interface PolicyFormProps {
  draft: PolicyDraft;
  dispatch: (action: DraftAction) => void;
  /** Errors that block saving, from the schema or from the server. */
  errors: FieldErrors;
  /** Advice about valid-but-surprising values. */
  notes: FieldErrors;
  /** The limit bands for the current values, or null while an amount cannot be read. */
  bands: readonly SpendBand[] | null;
  /** A save is in flight: the fields stay readable but cannot be changed under it. */
  disabled: boolean;
}

function FieldMessage({ id, error, note }: { id: string; error?: string; note?: string }) {
  const message = error ?? note;
  return (
    <p
      id={id}
      aria-live="polite"
      className={cn("flex gap-1.5 text-xs leading-[18px] text-pretty", error ? "font-medium text-danger" : "text-hold", !message && "hidden")}
    >
      {message ? (
        <>
          {error ? <CircleAlert aria-hidden="true" className="mt-[3px] size-3 shrink-0" /> : <Info aria-hidden="true" className="mt-[3px] size-3 shrink-0" />}
          <span>{message}</span>
        </>
      ) : null}
    </p>
  );
}

function LimitsCard({ draft, dispatch, errors, notes, bands, disabled }: PolicyFormProps) {
  return (
    <Card data-testid="policy-limits">
      <CardHeader>
        <CardTitle as="h2">Spending limits</CardTitle>
        <CardDescription>
          Checked in code before every authorization. The agent cannot raise them, and no message from a seller can.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-3">
          {MONEY_FIELDS.map((field) => (
            <MoneyField
              key={field}
              {...MONEY_FIELD_COPY[field]}
              value={draft.money[field]}
              error={errors[field]}
              note={notes[field]}
              disabled={disabled}
              onChange={(text) => dispatch({ type: "money", field, text })}
              onBlur={() => dispatch({ type: "money_blur", field })}
            />
          ))}
        </div>
        <div className="rounded-control border border-hairline bg-subtle/60 px-4 py-3.5">
          {bands === null ? (
            <p className="text-[13px] leading-5 text-muted">Enter valid amounts to see where the boundaries fall.</p>
          ) : (
            <LimitBands bands={bands} />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function CategoryOption({
  category,
  checked,
  locked,
  disabled,
  onCheckedChange,
}: {
  category: Category;
  checked: boolean;
  /** The restricted category: shown so the rule is visible, never editable. */
  locked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = `policy-category-${category}`;
  const copy = CATEGORY_COPY[category];
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-control border px-3.5 py-3 transition-colors duration-150 ease-out",
        locked ? "border-dashed border-hairline-strong bg-subtle/50" : checked ? "border-accent/40 bg-accent-soft/40" : "border-hairline",
      )}
    >
      <Checkbox
        id={id}
        data-testid={id}
        checked={checked}
        disabled={locked || disabled}
        aria-describedby={`${id}-description`}
        onCheckedChange={(state) => onCheckedChange(state === true)}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Label htmlFor={id} className={cn(locked && "text-muted")}>
            {copy.label}
          </Label>
          {locked ? (
            <Badge tone="danger" variant="outline">
              Always blocked
            </Badge>
          ) : null}
        </div>
        <p id={`${id}-description`} className="mt-0.5 text-xs leading-[18px] text-pretty text-muted">
          {copy.description}
        </p>
      </div>
    </div>
  );
}

function PurchasesCard({ draft, dispatch, errors, notes, disabled }: PolicyFormProps) {
  const newSellerId = useId();
  const messageId = useId();
  return (
    <Card data-testid="policy-purchases">
      <CardHeader>
        <CardTitle as="h2">What the agent may buy</CardTitle>
        <CardDescription>A deal in a category that is not ticked is blocked before any PayPal call.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <fieldset aria-describedby={messageId} className="flex flex-col gap-2.5">
          <legend className="mb-2.5 text-sm leading-5 font-medium text-fg">Allowed categories</legend>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {EDITABLE_CATEGORIES.map((category) => (
              <CategoryOption
                key={category}
                category={category}
                checked={draft.allowedCategories.includes(category)}
                locked={false}
                disabled={disabled}
                onCheckedChange={(allowed) => dispatch({ type: "category", category, allowed })}
              />
            ))}
            <CategoryOption category="restricted" checked={false} locked disabled={disabled} onCheckedChange={() => undefined} />
          </div>
          <FieldMessage id={messageId} error={errors.allowedCategories} note={notes.allowedCategories} />
        </fieldset>
        <Separator />
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Label htmlFor={newSellerId}>Require approval for new sellers</Label>
            <p className="mt-0.5 text-[13px] leading-5 text-pretty text-muted">
              A seller with no settled history always waits for you, even below the autonomous limit.
            </p>
          </div>
          <Switch
            id={newSellerId}
            data-testid="policy-new-seller-approval"
            checked={draft.requireApprovalForNewSellers}
            disabled={disabled}
            onCheckedChange={(required) => dispatch({ type: "new_seller_approval", required })}
            className="mt-0.5"
          />
        </div>
      </CardContent>
    </Card>
  );
}

function ThresholdSlider({
  id,
  label,
  hint,
  percent,
  min,
  error,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  percent: number;
  min: number;
  error?: string;
  disabled: boolean;
  onChange: (percent: number) => void;
}) {
  const labelId = `${id}-label`;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span id={labelId} className="text-sm leading-5 font-medium text-fg">
          {label}
        </span>
        <output data-testid={`${id}-value`} className="font-mono text-sm font-semibold text-fg tabular-nums">
          {percent}%
        </output>
      </div>
      <Slider
        data-testid={id}
        thumbLabels={[label]}
        formatValue={(value) => `${value}%`}
        min={min}
        max={100}
        step={1}
        value={[percent]}
        disabled={disabled}
        aria-labelledby={labelId}
        onValueChange={([next]) => {
          if (next !== undefined) onChange(next);
        }}
      />
      <p className="text-xs leading-[18px] text-pretty text-muted">{hint}</p>
      <FieldMessage id={`${id}-message`} error={error} />
    </div>
  );
}

function ThresholdsCard({ draft, dispatch, errors, disabled }: PolicyFormProps) {
  const rules = confidenceRules(draft.autoCapturePercent, draft.humanReviewPercent);
  return (
    <Card data-testid="policy-thresholds">
      <CardHeader>
        <CardTitle as="h2">Verification thresholds</CardTitle>
        <CardDescription>
          How sure the verifier must be before money moves without you. Each contract copies these values when it is
          signed, so a change applies to the next deal, not to one already running.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-6 sm:grid-cols-2 sm:gap-8">
          <ThresholdSlider
            id="policy-auto-capture"
            label="Auto-capture minimum confidence"
            hint={`Every required condition must pass at least this confidently. Cannot go below ${AUTO_CAPTURE_MIN_PERCENT}%.`}
            percent={draft.autoCapturePercent}
            min={AUTO_CAPTURE_MIN_PERCENT}
            error={errors.autoCaptureMinConfidence}
            disabled={disabled}
            onChange={(percent) => dispatch({ type: "auto_capture", percent })}
          />
          <ThresholdSlider
            id="policy-human-review"
            label="Human-review floor"
            hint="A failed check is an explicit failure only at or above this confidence. Never higher than the auto-capture minimum."
            percent={draft.humanReviewPercent}
            min={0}
            error={errors.humanReviewMinConfidence}
            disabled={disabled}
            onChange={(percent) => dispatch({ type: "human_review", percent })}
          />
        </div>
        <div className="rounded-control border border-hairline bg-subtle/60 px-4 py-3.5">
          <p className="font-mono text-[10px] leading-4 font-medium tracking-[0.08em] text-faint uppercase">For each required condition</p>
          <dl data-testid="policy-confidence-rules" className="mt-2 flex flex-col divide-y divide-hairline">
            {rules.map((rule) => (
              <div
                key={rule.id}
                data-rule={rule.id}
                className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
              >
                <dt className="text-[13px] leading-5 text-fg">{rule.when}</dt>
                <dd className={cn("flex items-center gap-1.5 text-[13px] leading-5 font-medium sm:shrink-0", TONE_CLASSES[rule.tone].text)}>
                  <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
                  {rule.then}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </CardContent>
    </Card>
  );
}

/** The three sections of the spending policy. State lives in the parent; this only renders and dispatches. */
export function PolicyForm(props: PolicyFormProps) {
  return (
    <div className="flex flex-col gap-5">
      <LimitsCard {...props} />
      <PurchasesCard {...props} />
      <ThresholdsCard {...props} />
    </div>
  );
}
