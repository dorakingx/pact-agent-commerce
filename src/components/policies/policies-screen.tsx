"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { Check, CircleAlert, RotateCcw } from "lucide-react";
import { toast } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import type { PolicyResponse } from "@/lib/api/dto";
import { ApiClientError } from "@/lib/client/api";
import {
  draftFromPolicy,
  isDraftDirty,
  parseDollars,
  policiesEqual,
  policyNotes,
  reduceDraft,
  serverFieldErrors,
  spendBands,
  toFailure,
  validateDraft,
  walletNotice,
  type DraftAction,
  type Failure,
  type FieldErrors,
} from "@/lib/client/policy-derive";
import { usePolicy, type UsePolicy } from "@/lib/client/use-policy";
import { useWallet } from "@/lib/client/use-wallet";
import { DEFAULT_POLICY } from "@/lib/domain/schemas";
import { DailySpendCard } from "./daily-spend-card";
import { DecisionExplainer } from "./decision-explainer";
import { PolicyForm } from "./policy-form";
import { PolicyPreview } from "./policy-preview";
import { RequestError } from "./request-error";
import { WalletCard } from "./wallet-card";

const WALLET_SECTION_ID = "wallet";

/**
 * PayPal (or the simulator) sends the payer back to `/policies?wallet=connected|error|cancelled`.
 * Say what happened once, bring the wallet into view, and clean the address so a reload or a
 * shared link does not repeat it.
 */
function useWalletReturnNotice(): void {
  useEffect(() => {
    const notice = walletNotice(new URLSearchParams(window.location.search).get("wallet"));
    if (notice === null) return;
    // Deferred one tick: the toast outlet mounts after this page, and the address is cleaned in
    // the same tick so that React's double-invoked development effect still finds it the second time.
    const timer = window.setTimeout(() => {
      toast[notice.kind](notice.title, { description: notice.description });
      window.history.replaceState(window.history.state, "", window.location.pathname);
      document.getElementById(WALLET_SECTION_ID)?.scrollIntoView({ block: "start" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
}

type SaveState = "saving" | "invalid" | "unsaved" | "default" | "saved";

const SAVE_STATE_TEXT: Record<SaveState, string> = {
  saving: "Saving…",
  invalid: "Fix the highlighted fields to save",
  unsaved: "Unsaved changes",
  default: "Using the default policy",
  saved: "All changes saved",
};

function SaveStateLabel({ state }: { state: SaveState }) {
  return (
    <p
      aria-live="polite"
      data-testid="policy-save-state"
      data-state={state}
      className={cn(
        "flex min-w-0 items-center gap-2 text-[13px] leading-5 font-medium",
        state === "invalid" ? "text-danger" : state === "unsaved" ? "text-hold" : "text-muted",
      )}
    >
      {state === "saving" ? <Spinner label={null} className="size-3.5" /> : null}
      {state === "invalid" ? <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" /> : null}
      {state === "unsaved" ? <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-hold" /> : null}
      {state === "saved" ? <Check aria-hidden="true" strokeWidth={3} className="size-3.5 shrink-0 text-success" /> : null}
      <span>{SAVE_STATE_TEXT[state]}</span>
    </p>
  );
}

interface PolicyEditorProps {
  saved: PolicyResponse;
  save: UsePolicy["save"];
}

/** The form, its live derivations and the save bar. Mounted once the saved policy is known. */
function PolicyEditor({ saved, save }: PolicyEditorProps) {
  const [draft, dispatchDraft] = useReducer(reduceDraft, saved.policy, draftFromPolicy);
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [saveFailure, setSaveFailure] = useState<Failure | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const validation = validateDraft(draft);
  const { candidate } = validation;
  const dirty = isDraftDirty(validation, saved.policy);
  const invalid = validation.policy === null;
  const atDefaults = candidate !== null && policiesEqual(candidate, DEFAULT_POLICY);
  // Read on its own, so the meter keeps working while another amount is being typed.
  const dailyLimit = parseDollars(draft.money.dailyLimitMinor);
  const dailyLimitMinor = dailyLimit.ok ? dailyLimit.minor : null;
  // What the form itself can tell wins over what the server last said about the same field.
  const errors: FieldErrors = { ...serverErrors, ...validation.errors };
  const state: SaveState = saving ? "saving" : dirty ? (invalid ? "invalid" : "unsaved") : saved.isDefault ? "default" : "saved";

  function edit(action: DraftAction) {
    // The server's objections were about the values it was sent; an edit makes them stale.
    setServerErrors({});
    setSaveFailure(null);
    dispatchDraft(action);
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !dirty) return;
    if (validation.policy === null) {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    setSaving(true);
    setSaveFailure(null);
    try {
      const response = await save(validation.policy);
      // Re-read the stored document into the fields ("100" becomes "100.00").
      dispatchDraft({ type: "replace", policy: response.policy });
      toast.success("Policy saved", { description: "It applies to the next deal this session starts." });
    } catch (cause) {
      const failure = toFailure(cause);
      if (cause instanceof ApiClientError) setServerErrors(serverFieldErrors(cause.details));
      setSaveFailure(failure);
      toast.error("The policy was not saved", { description: failure.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div id="spending-policy" className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-start xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
      <form ref={formRef} onSubmit={onSubmit} noValidate aria-label="Spending policy" data-testid="policy-form" className="flex min-w-0 flex-col gap-5">
        <PolicyForm
          draft={draft}
          dispatch={edit}
          errors={errors}
          notes={candidate === null ? {} : policyNotes(candidate)}
          bands={candidate === null ? null : spendBands(candidate)}
          disabled={saving}
        />
        <div
          data-testid="policy-save-bar"
          data-dirty={dirty}
          className={cn(
            // Two rows on a phone (state + reset, then the two decisions side by side), one row from `sm` up.
            "z-20 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2.5 rounded-card border bg-surface px-4 py-3 transition-[border-color,box-shadow] duration-200 ease-out sm:flex",
            // It follows the viewport only while there is something to save or discard.
            dirty ? "sticky bottom-3 border-hairline-strong shadow-pop" : "border-hairline",
          )}
        >
          <div className="flex min-w-0 flex-col gap-0.5 sm:mr-auto">
            <SaveStateLabel state={state} />
            {saveFailure ? (
              <p role="alert" data-testid="policy-save-error" className="text-xs leading-[18px] text-danger">
                {saveFailure.message}
                {saveFailure.requestId ? <span className="block font-mono text-[11px] text-muted">Request {saveFailure.requestId}</span> : null}
              </p>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="sm"
            data-testid="policy-reset"
            aria-label="Reset to defaults"
            disabled={saving || atDefaults}
            onClick={() => edit({ type: "replace", policy: DEFAULT_POLICY })}
            className="max-sm:-mr-2"
          >
            <RotateCcw aria-hidden="true" />
            Reset<span className="max-sm:hidden"> to defaults</span>
          </Button>
          <div className="col-span-2 grid grid-cols-2 gap-2 sm:contents">
            <Button
              variant="secondary"
              size="sm"
              data-testid="policy-discard"
              disabled={saving || !dirty}
              onClick={() => edit({ type: "replace", policy: saved.policy })}
            >
              Discard
            </Button>
            <Button type="submit" size="sm" data-testid="policy-save" loading={saving} disabled={!dirty}>
              Save changes
            </Button>
          </div>
        </div>
      </form>
      <div className="flex min-w-0 flex-col gap-5 lg:sticky lg:top-20">
        <DailySpendCard
          spentTodayMinor={saved.spentTodayMinor}
          limitMinor={dailyLimitMinor}
          unsaved={dailyLimitMinor !== null && dailyLimitMinor !== saved.policy.dailyLimitMinor}
        />
        <PolicyPreview policy={candidate} spentTodayMinor={saved.spentTodayMinor} />
      </div>
    </div>
  );
}

function PolicySkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading the spending policy"
      data-testid="policy-loading"
      className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-start xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]"
    >
      <div className="flex flex-col gap-5">
        <Card className="flex flex-col gap-5 p-5">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-4 w-80 max-w-full" />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {[0, 1, 2].map((index) => (
              <div key={index} className="flex flex-col gap-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-10 w-full rounded-control" />
                <Skeleton className="h-3 w-full" />
              </div>
            ))}
          </div>
          <Skeleton className="h-[74px] w-full rounded-control" />
        </Card>
        <Card className="flex flex-col gap-4 p-5">
          <Skeleton className="h-5 w-44" />
          <div className="grid gap-2.5 sm:grid-cols-2">
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-[62px] w-full rounded-control" />
            ))}
          </div>
        </Card>
      </div>
      <div className="flex flex-col gap-5">
        <Card className="flex flex-col gap-3 px-5 py-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-2 w-full rounded-full" />
        </Card>
        <Card className="flex flex-col gap-4 p-5">
          <Skeleton className="h-5 w-40" />
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-24 w-full rounded-control" />
          ))}
        </Card>
      </div>
    </div>
  );
}

/** Everything below the page header on /policies. */
export function PoliciesScreen() {
  const policy = usePolicy();
  const wallet = useWallet();
  useWalletReturnNotice();

  return (
    <div className="flex flex-col gap-5">
      {policy.data ? (
        <PolicyEditor saved={policy.data} save={policy.save} />
      ) : policy.error ? (
        <RequestError
          title="The spending policy could not be loaded"
          error={policy.error}
          onRetry={policy.reload}
          testId="policy-error"
        />
      ) : (
        <PolicySkeleton />
      )}
      <section id={WALLET_SECTION_ID} aria-label="Delegated agent wallet">
        <WalletCard wallet={wallet} />
      </section>
      <DecisionExplainer />
    </div>
  );
}
