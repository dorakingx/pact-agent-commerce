"use client";

import { useId } from "react";
import { ArrowRight, Pin, Store, X } from "lucide-react";
import { Badge, Button, Card, CardFooter, Kbd, Label, Textarea, cn, useHydrated } from "@/components/ui";
import { RequestError } from "@/components/deal/parts";
import { INTENT_MAX_CHARS, INTENT_MIN_CHARS, intentState, scenarioEdited } from "@/lib/client/deal-derive-compose";
import type { ScenarioOption } from "./scenario-picker";

/** Why the last attempt to start a deal failed, already worded for the person. */
export interface ComposerError {
  message: string;
  requestId: string | null;
  code: string;
}

export interface ComposerProps {
  text: string;
  onTextChange(text: string): void;
  /** The scenario whose seller is pinned, if one was picked. */
  scenario: ScenarioOption | null;
  onClearScenario(): void;
  /** True from the click until the deal page takes over. */
  creating: boolean;
  error: ComposerError | null;
  onSubmit(): void;
}

/** The request box: one sentence in the human's own words is the whole input of a deal. */
export function Composer({ text, onTextChange, scenario, onClearScenario, creating, error, onSubmit }: ComposerProps) {
  const fieldId = useId();
  const counterId = `${fieldId}-counter`;
  const hintId = `${fieldId}-hint`;
  const state = intentState(text);
  const edited = scenarioEdited(text, scenario ?? undefined);
  // Before hydration the button would post the form to the page itself instead of starting a deal.
  const hydrated = useHydrated();
  const canSubmit = state.valid && !creating && hydrated;

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (canSubmit) onSubmit();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (canSubmit) onSubmit();
    }
  }

  return (
    <Card>
      <form onSubmit={submit} data-testid="composer" aria-busy={creating}>
        <div className="p-4 sm:p-5">
          <Label htmlFor={fieldId} className="text-lg leading-7 font-semibold tracking-[-0.015em]">
            What do you need done?
          </Label>
          <p className="mt-0.5 text-sm leading-6 text-muted">
            Brief it the way you would brief a person: what, how many, by when, and your budget.
          </p>
          <Textarea
            id={fieldId}
            rows={4}
            value={text}
            disabled={creating}
            onChange={(event) => onTextChange(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="e.g. Get three landing-page illustrations for under $50 by tomorrow at 6 PM, in 16:9 and 1:1, with one revision."
            aria-describedby={`${counterId} ${hintId}`}
            aria-invalid={state.tooLong || undefined}
            data-testid="intent-input"
            className="mt-3 min-h-28 text-[15px] leading-6"
          />
          <div className="mt-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div id={hintId} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] leading-5 text-muted">
              {scenario ? (
                <>
                  <Badge tone="info" data-testid="composer-scenario" data-scenario-id={scenario.id}>
                    <Pin aria-hidden="true" />
                    Scenario: {scenario.title}
                  </Badge>
                  {scenario.seller ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Store aria-hidden="true" className="size-3.5" />
                      Seller pinned: <span className="font-medium text-fg">{scenario.seller.name}</span>
                    </span>
                  ) : null}
                  {edited ? (
                    <Badge tone="hold" variant="outline" data-testid="composer-edited" title="You changed the scenario's text. The seller stays pinned.">
                      edited
                    </Badge>
                  ) : null}
                  <Button variant="ghost" size="sm" onClick={onClearScenario} disabled={creating} data-testid="composer-clear-scenario" className="h-6 px-1.5 pointer-coarse:h-auto">
                    <X aria-hidden="true" />
                    Unpin
                  </Button>
                </>
              ) : (
                <span>Free-form request: PACT matches the most reliable seller agent for the kind of work.</span>
              )}
            </div>
            <p
              id={counterId}
              data-testid="intent-counter"
              data-valid={state.valid}
              className={cn("ml-auto shrink-0 font-mono text-xs leading-5 tabular-nums", state.tooLong ? "font-semibold text-danger" : "text-muted")}
            >
              <span aria-hidden="true">
                {state.length} / {INTENT_MAX_CHARS}
              </span>
              <span className="sr-only">
                {state.length} of {INTENT_MAX_CHARS} characters used; at least {INTENT_MIN_CHARS} are needed.
              </span>
              {state.hint ? <span className="ml-2 font-sans">· {state.hint}</span> : null}
            </p>
          </div>
          {error ? (
            <RequestError className="mt-3" title="The deal could not be started" error={error} />
          ) : null}
        </div>
        <CardFooter className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] leading-5 text-muted">
            Your buyer agent negotiates. PACT, not the agent, holds and releases the payment.
          </p>
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="hidden items-center gap-1 text-xs text-faint md:flex">
              <Kbd>⌘</Kbd>
              <span>/</span>
              <Kbd>Ctrl</Kbd>
              <Kbd>Enter</Kbd>
            </span>
            <Button type="submit" size="lg" loading={creating} disabled={!canSubmit} data-testid="delegate" className="max-sm:w-full">
              {creating ? "Reading your request…" : "Delegate to buyer agent"}
              {creating ? null : <ArrowRight aria-hidden="true" />}
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}
