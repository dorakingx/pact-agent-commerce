/**
 * Keeping a visitor's version of the dashboard between visits.
 *
 * What is saved is AG Studio's own report state (the value of `api.getState()`), wrapped with
 * the version of PACT's default report it was built on. A saved layout from an older default is
 * discarded rather than migrated: the default is the product's designed view, and silently
 * restoring a stale copy over a redesigned one would hide the redesign from the very people
 * who looked first.
 *
 * Everything is defensive on purpose. localStorage can be missing, full, or hold anything at
 * all; none of that may stop the dashboard from rendering its default.
 */
import { REPORT_VERSION } from "./studio-report";

export const REPORT_STORAGE_KEY = "pact:studio:report";

/** The least a stored value must be for Studio to be handed it. Studio validates the rest itself. */
export interface StoredReportState {
  pages: { id: string }[];
  selectedPageId: string;
}

interface StoredEnvelope {
  version: number;
  savedAt: string;
  state: StoredReportState;
}

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem" | "removeItem">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReportState(value: unknown): value is StoredReportState {
  if (!isRecord(value) || !Array.isArray(value.pages) || value.pages.length === 0) return false;
  const ids = value.pages.map((page: unknown) => (isRecord(page) && typeof page.id === "string" ? page.id : null));
  if (ids.some((id) => id === null || id.length === 0) || new Set(ids).size !== ids.length) return false;
  return typeof value.selectedPageId === "string" && ids.includes(value.selectedPageId);
}

/**
 * Selections and cross filters are how someone was looking at the report, not the report: a
 * dashboard that reopens silently filtered to one seller reads as broken. They are left out.
 */
export function withoutViewState<T extends StoredReportState>(state: T): T {
  return {
    ...state,
    pages: state.pages.map((page) => {
      const kept: Record<string, unknown> = { ...page };
      delete kept.selection;
      delete kept.crossFilter;
      return kept as T["pages"][number];
    }),
  };
}

export function serializeReport(state: StoredReportState, now: Date): string {
  const envelope: StoredEnvelope = { version: REPORT_VERSION, savedAt: now.toISOString(), state: withoutViewState(state) };
  return JSON.stringify(envelope);
}

/** The stored state, or null when there is none, it is malformed, or it predates the current default. */
export function parseStoredReport(raw: string | null): StoredReportState | null {
  if (raw === null || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== REPORT_VERSION) return null;
  return isReportState(parsed.state) ? parsed.state : null;
}

export function loadStoredReport(storage: ReadableStorage | null): StoredReportState | null {
  if (storage === null) return null;
  try {
    return parseStoredReport(storage.getItem(REPORT_STORAGE_KEY));
  } catch {
    // Storage access itself can throw (private mode, a blocked third-party context).
    return null;
  }
}

/** True when the state was written. False means "not saved", never an error to surface. */
export function saveStoredReport(storage: WritableStorage | null, state: StoredReportState, now: Date): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(REPORT_STORAGE_KEY, serializeReport(state, now));
    return true;
  } catch {
    return false;
  }
}

export function clearStoredReport(storage: WritableStorage | null): void {
  try {
    storage?.removeItem(REPORT_STORAGE_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

/** File name for an exported layout: "pact-operations-report-2026-10-06.json". */
export function exportFileName(now: Date): string {
  return `pact-operations-report-${now.toISOString().slice(0, 10)}.json`;
}
