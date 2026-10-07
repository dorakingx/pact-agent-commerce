"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { EvidenceTarget } from "@/lib/client/deal-derive-delivery";

/*
 * Links a verification row to the files (and the missing slots) it is about. Hovering or
 * focusing either side lights up the other, and a row can pin its target so the link survives
 * the scroll from the report to the delivery grid.
 */

interface EvidenceLinkValue {
  /** What is highlighted right now: the hovered target, or else the pinned one. */
  target: EvidenceTarget | null;
  /** Transient highlight while the pointer or focus is on a row or tile. */
  hover(target: EvidenceTarget | null): void;
  /** Sticky highlight, set by a click. Pass null to clear it. */
  pin(target: EvidenceTarget | null): void;
  /** Which delivery round the viewer chose to look at, with the number of rounds that existed then. */
  roundPick: { round: number; total: number } | null;
  pickRound(pick: { round: number; total: number }): void;
}

const EvidenceLinkContext = createContext<EvidenceLinkValue | null>(null);

export function EvidenceLinkProvider({ children }: { children: React.ReactNode }) {
  const [hovered, setHovered] = useState<EvidenceTarget | null>(null);
  const [pinned, setPinned] = useState<EvidenceTarget | null>(null);
  const [roundPick, setRoundPick] = useState<{ round: number; total: number } | null>(null);

  const hover = useCallback((target: EvidenceTarget | null) => setHovered(target), []);
  const pin = useCallback((target: EvidenceTarget | null) => setPinned(target), []);
  const pickRound = useCallback((pick: { round: number; total: number }) => setRoundPick(pick), []);

  const value = useMemo<EvidenceLinkValue>(
    () => ({ target: hovered ?? pinned, hover, pin, roundPick, pickRound }),
    [hovered, pinned, hover, pin, roundPick, pickRound],
  );
  return <EvidenceLinkContext.Provider value={value}>{children}</EvidenceLinkContext.Provider>;
}

export function useEvidenceLink(): EvidenceLinkValue {
  const value = useContext(EvidenceLinkContext);
  if (value === null) throw new Error("useEvidenceLink must be used inside <EvidenceLinkProvider>");
  return value;
}

/** Ring classes for an element the current target points at. */
export function evidenceRing(target: EvidenceTarget | null, linked: boolean): string {
  if (target === null || !linked) return "";
  return target.result === "fail"
    ? "ring-2 ring-danger ring-offset-2 ring-offset-surface"
    : "ring-2 ring-review ring-offset-2 ring-offset-surface";
}
