import { describe, expect, it } from "vitest";
import {
  assertNever,
  deliverableCountLabel,
  formatDuration,
  formatUtcShort,
  formatUtcTimestamp,
  joinList,
  languageName,
  parseTimestamp,
  plural,
  revisionsLabel,
  singleLine,
  truncate,
} from "./format";

describe("timestamps", () => {
  it("parses ISO timestamps and rejects garbage", () => {
    expect(parseTimestamp("2026-10-07T18:00:00.000Z")).toBe(Date.UTC(2026, 9, 7, 18));
    expect(parseTimestamp("2026-10-08T03:00:00+09:00")).toBe(Date.UTC(2026, 9, 7, 18));
    expect(parseTimestamp("not a date")).toBeNull();
    expect(parseTimestamp("")).toBeNull();
  });

  it("formats in UTC regardless of the offset the value was written with", () => {
    expect(formatUtcTimestamp("2026-10-07T18:00:00.000Z")).toBe("2026-10-07 18:00 UTC");
    expect(formatUtcTimestamp("2026-10-08T03:05:00+09:00")).toBe("2026-10-07 18:05 UTC");
    expect(formatUtcShort("2026-10-07T18:00:00.000Z")).toBe("Oct 7, 18:00 UTC");
    expect(formatUtcShort("2026-01-01T00:05:00.000Z")).toBe("Jan 1, 00:05 UTC");
  });

  it("never throws on an invalid timestamp", () => {
    expect(formatUtcTimestamp("garbage")).toBe("an invalid date");
    expect(formatUtcShort("garbage")).toBe("an invalid date");
  });
});

describe("formatDuration", () => {
  const minute = 60_000;
  const hour = 60 * minute;

  it("uses the two largest units", () => {
    expect(formatDuration(0)).toBe("under a minute");
    expect(formatDuration(59_999)).toBe("under a minute");
    expect(formatDuration(45 * minute)).toBe("45m");
    expect(formatDuration(2 * hour)).toBe("2h");
    expect(formatDuration(14 * hour + 20 * minute)).toBe("14h 20m");
    expect(formatDuration(2 * hour + 5 * minute)).toBe("2h 05m");
    expect(formatDuration(24 * hour)).toBe("1d");
    expect(formatDuration(51 * hour + 30 * minute)).toBe("2d 3h");
  });

  it("describes magnitude only, so negative spans read the same", () => {
    expect(formatDuration(-(3 * hour))).toBe("3h");
  });
});

describe("text helpers", () => {
  it("joins lists the way a person would write them", () => {
    expect(joinList([])).toBe("");
    expect(joinList(["16:9"])).toBe("16:9");
    expect(joinList(["16:9", "1:1"])).toBe("16:9 and 1:1");
    expect(joinList(["a", "b", "c"])).toBe("a, b and c");
  });

  it("pluralises counts", () => {
    expect(plural(1, "illustration")).toBe("1 illustration");
    expect(plural(3, "illustration")).toBe("3 illustrations");
    expect(plural(0, "file")).toBe("0 files");
    expect(plural(2, "copy", "copies")).toBe("2 copies");
  });

  it("labels deliverables, revisions and languages", () => {
    expect(deliverableCountLabel("illustration", 3)).toBe("3 illustrations");
    expect(deliverableCountLabel("copy", 1)).toBe("1 copy piece");
    expect(revisionsLabel(0)).toBe("no revision rounds");
    expect(revisionsLabel(1)).toBe("1 revision round");
    expect(revisionsLabel(2)).toBe("2 revision rounds");
    expect(languageName("ja")).toBe("Japanese");
  });

  it("truncates with an ellipsis and never exceeds the limit", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("exactly ten", 11)).toBe("exactly ten");
    const cut = truncate("a".repeat(300), 127);
    expect(cut).toHaveLength(127);
    expect(cut.endsWith("…")).toBe(true);
    expect(truncate("hello world", 7)).toBe("hello…");
    expect(truncate("abc", 1)).toBe("a");
    expect(truncate("abc", 0)).toBe("");
  });

  it("never leaves half of a surrogate pair behind", () => {
    const text = `${"a".repeat(8)}😀😀😀`;
    for (let max = 2; max <= text.length; max += 1) {
      const cut = truncate(text, max);
      expect(cut.length).toBeLessThanOrEqual(max);
      // A lone surrogate does not survive a UTF-8 round trip.
      expect(Buffer.from(cut, "utf8").toString("utf8")).toBe(cut);
    }
  });

  it("collapses untrusted text to a single printable line", () => {
    expect(singleLine("  hello\n\tworld  ")).toBe("hello world");
    expect(singleLine("a\u0000b\u0007c")).toBe("a b c");
    expect(singleLine(`safe${String.fromCodePoint(0x202e)}evil`)).toBe("safe evil");
    expect(singleLine(`zero${String.fromCodePoint(0x200b)}width`)).toBe("zero width");
    expect(singleLine("")).toBe("");
  });

  it("assertNever throws with the unexpected value", () => {
    expect(() => assertNever("surprise" as never)).toThrow(/surprise/);
  });
});
