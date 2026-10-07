import { describe, expect, it } from "vitest";
import {
  REPORT_STORAGE_KEY,
  clearStoredReport,
  exportFileName,
  loadStoredReport,
  parseStoredReport,
  saveStoredReport,
  serializeReport,
  withoutViewState,
} from "./studio-persistence";
import { REPORT_VERSION, buildDefaultReport } from "./studio-report";

const NOW = new Date("2026-10-06T08:30:00.000Z");

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

describe("serializeReport / parseStoredReport", () => {
  it("round-trips a report under the current version", () => {
    const report = buildDefaultReport();
    const raw = serializeReport(report, NOW);
    expect(JSON.parse(raw)).toMatchObject({ version: REPORT_VERSION, savedAt: NOW.toISOString() });
    expect(parseStoredReport(raw)).toEqual(report);
  });

  it("drops selections and cross filters but keeps filters the visitor set", () => {
    const report = buildDefaultReport();
    const viewed = {
      ...report,
      pages: report.pages.map((page) => ({
        ...page,
        selection: { type: "widget", id: "rail" },
        crossFilter: { values: { rail: [] } },
        filter: { page: [{ field: { id: "deals.seller" } }] },
      })),
    };
    const stored = parseStoredReport(serializeReport(viewed, NOW)) as typeof viewed;
    for (const page of stored.pages) {
      expect(page).not.toHaveProperty("selection");
      expect(page).not.toHaveProperty("crossFilter");
      expect(page.filter).toEqual({ page: [{ field: { id: "deals.seller" } }] });
    }
    // The state handed in is left as it was.
    expect(viewed.pages[0]).toHaveProperty("selection");
    expect(withoutViewState(report).pages[0]).toEqual(report.pages[0]);
  });

  it("discards a layout saved under another version of the default report", () => {
    const stale = JSON.stringify({ version: REPORT_VERSION + 1, savedAt: NOW.toISOString(), state: buildDefaultReport() });
    expect(parseStoredReport(stale)).toBeNull();
    expect(parseStoredReport(JSON.stringify({ savedAt: NOW.toISOString(), state: buildDefaultReport() }))).toBeNull();
  });

  it("discards anything that is not a usable report", () => {
    const wrap = (state: unknown) => JSON.stringify({ version: REPORT_VERSION, savedAt: NOW.toISOString(), state });
    for (const raw of [
      null,
      "",
      "{not json",
      "[]",
      '"text"',
      wrap(null),
      wrap({ pages: [], selectedPageId: "overview" }),
      wrap({ pages: [{ id: "a" }], selectedPageId: "b" }),
      wrap({ pages: [{ id: "a" }, { id: "a" }], selectedPageId: "a" }),
      wrap({ pages: [{ id: "" }], selectedPageId: "" }),
      wrap({ pages: [{ title: "no id" }], selectedPageId: "x" }),
      wrap({ pages: "overview", selectedPageId: "overview" }),
      wrap({ pages: [{ id: "a" }] }),
    ]) {
      expect(parseStoredReport(raw), String(raw)).toBeNull();
    }
  });
});

describe("storage", () => {
  it("saves under one key and loads it back", () => {
    const storage = memoryStorage();
    const report = buildDefaultReport();
    expect(saveStoredReport(storage, report, NOW)).toBe(true);
    expect([...storage.items.keys()]).toEqual([REPORT_STORAGE_KEY]);
    expect(loadStoredReport(storage)).toEqual(report);
    clearStoredReport(storage);
    expect(loadStoredReport(storage)).toBeNull();
  });

  it("treats missing storage as nothing saved", () => {
    expect(loadStoredReport(null)).toBeNull();
    expect(saveStoredReport(null, buildDefaultReport(), NOW)).toBe(false);
    expect(() => clearStoredReport(null)).not.toThrow();
  });

  it("survives storage that throws (private mode, quota)", () => {
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(loadStoredReport(broken)).toBeNull();
    expect(saveStoredReport(broken, buildDefaultReport(), NOW)).toBe(false);
    expect(() => clearStoredReport(broken)).not.toThrow();
  });
});

describe("exportFileName", () => {
  it("dates the file", () => {
    expect(exportFileName(NOW)).toBe("pact-operations-report-2026-10-06.json");
  });
});
