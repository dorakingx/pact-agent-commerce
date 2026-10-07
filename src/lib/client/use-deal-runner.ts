"use client";

/**
 * React binding for the deal runner (see use-deal-runner-core.ts for the rules it follows).
 *
 * The runner lives for as long as the deal screen is mounted. Mount the screen with
 * `key={dealId}` so a different deal gets a fresh runner.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { AdvanceResponse, DealResponse, DealView } from "@/lib/api/dto";
import { api } from "./api";
import { dealPath } from "./use-deal";
import { DealRunner, type RunnerSnapshot } from "./use-deal-runner-core";

/** Per tab, so a presenter who paces one deal by hand keeps that setting for the next one. */
const AUTO_RUN_KEY = "pact-auto-run";

function readAutoRun(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.sessionStorage.getItem(AUTO_RUN_KEY) !== "off";
  } catch {
    // Storage can be unavailable (private mode, blocked cookies). The default is the safe answer.
    return true;
  }
}

function writeAutoRun(autoRun: boolean): void {
  try {
    window.sessionStorage.setItem(AUTO_RUN_KEY, autoRun ? "on" : "off");
  } catch {
    // Not remembering the switch is harmless.
  }
}

export interface UseDealRunner extends RunnerSnapshot {
  setAutoRun(autoRun: boolean): void;
  /** Run exactly one step now (the "Run next step" button, enabled while auto-run is off). */
  runNext(): void;
  /** Clear the current problem and try the step again. */
  retry(): void;
}

/**
 * Drives `deal` while the viewer owns it and its next step is automatic.
 *
 * @param publish  Receives every deal the runner gets back, so the page shows it.
 */
export function useDealRunner(dealId: string, deal: DealView | undefined, publish: (deal: DealView) => void): UseDealRunner {
  const [runner] = useState(
    () =>
      new DealRunner({
        advance: (signal) => api.post<AdvanceResponse>(`${dealPath(dealId)}/advance`, {}, signal),
        refresh: async (signal) => (await api.get<DealResponse>(dealPath(dealId), signal)).deal,
        publish,
        autoRun: readAutoRun(),
      }),
  );

  const snapshot = useSyncExternalStore(runner.subscribe, runner.getSnapshot, runner.getServerSnapshot);

  // Unmounting or navigating away aborts the request in flight and ends the loop.
  useEffect(() => {
    runner.start();
    return () => runner.stop();
  }, [runner]);

  useEffect(() => {
    if (deal !== undefined) runner.sync(deal);
  }, [runner, deal]);

  const setAutoRun = useCallback(
    (autoRun: boolean): void => {
      writeAutoRun(autoRun);
      runner.setAutoRun(autoRun);
    },
    [runner],
  );
  const runNext = useCallback((): void => runner.runNext(), [runner]);
  const retry = useCallback((): void => runner.retry(), [runner]);

  return { ...snapshot, setAutoRun, runNext, retry };
}
