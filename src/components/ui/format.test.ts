import { describe, expect, it } from "vitest";
import {
  clamp01,
  formatPercent,
  formatRelativeTime,
  formatUtcDateTime,
  splitMoney,
  toEpochMs,
  truncateMiddle,
} from "./format";

describe("truncateMiddle", () => {
  it("keeps the head and tail around an ellipsis", () => {
    expect(truncateMiddle("a3f1b2c4d5e6f7089c2e", 4, 4)).toBe("a3f1…9c2e");
  });

  it("returns short values unchanged, including values the ellipsis would not shorten", () => {
    expect(truncateMiddle("PACT-7F3K")).toBe("PACT-7F3K");
    // 11 characters with head 6 + tail 4: "abcdef…hijk" would be no shorter than the original.
    expect(truncateMiddle("abcdefghijk", 6, 4)).toBe("abcdefghijk");
    expect(truncateMiddle("abcdefghijkl", 6, 4)).toBe("abcdef…ijkl");
  });

  it("supports a head-only truncation and ignores negative or fractional sizes", () => {
    expect(truncateMiddle("0123456789abcdef", 6, 0)).toBe("012345…");
    expect(truncateMiddle("0123456789abcdef", 4.9, -3)).toBe("0123…");
  });
});

describe("splitMoney", () => {
  it("splits whole units and cents from integer minor units", () => {
    expect(splitMoney(4700)).toEqual({ negative: false, whole: "$47", cents: ".00" });
    expect(splitMoney(123456)).toEqual({ negative: false, whole: "$1,234", cents: ".56" });
    expect(splitMoney(5)).toEqual({ negative: false, whole: "$0", cents: ".05" });
  });

  it("reports the sign separately so negative deltas format correctly", () => {
    expect(splitMoney(-550)).toEqual({ negative: true, whole: "$5", cents: ".50" });
    expect(splitMoney(0).negative).toBe(false);
  });

  it("rejects floats: money never crosses a boundary as a fraction", () => {
    expect(() => splitMoney(47.5)).toThrow(RangeError);
    expect(() => splitMoney(Number.NaN)).toThrow(RangeError);
  });
});

describe("formatUtcDateTime", () => {
  it("formats in UTC regardless of the host time zone", () => {
    expect(formatUtcDateTime(Date.parse("2026-10-06T02:05:00Z"))).toBe("6 Oct 2026, 02:05 UTC");
    expect(formatUtcDateTime(Date.parse("2026-12-31T23:59:59+09:00"))).toBe("31 Dec 2026, 14:59 UTC");
  });

  it("does not print Invalid Date", () => {
    expect(formatUtcDateTime(Number.NaN)).toBe("Unknown time");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const ago = (ms: number) => formatRelativeTime(now - ms, now);
  const ahead = (ms: number) => formatRelativeTime(now + ms, now);

  it("collapses anything under 45 seconds to 'just now', in both directions", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(44_000)).toBe("just now");
    expect(ahead(30_000)).toBe("just now");
  });

  it("uses minutes, hours and days", () => {
    expect(ago(45_000)).toBe("1 min ago");
    expect(ago(5 * 60_000)).toBe("5 min ago");
    expect(ago(59 * 60_000)).toBe("59 min ago");
    expect(ago(60 * 60_000)).toBe("1 h ago");
    expect(ago(23 * 3_600_000)).toBe("23 h ago");
    expect(ago(24 * 3_600_000)).toBe("1 d ago");
    expect(ago(6 * 86_400_000)).toBe("6 d ago");
  });

  it("describes future times, e.g. an authorization expiry", () => {
    expect(ahead(3 * 3_600_000)).toBe("in 3 h");
    expect(ahead(3 * 86_400_000)).toBe("in 3 d");
  });

  it("falls back to the absolute date beyond a week", () => {
    expect(ago(7 * 86_400_000)).toBe("29 Sep 2026, 12:00 UTC");
  });

  it("handles an invalid target", () => {
    expect(formatRelativeTime(Number.NaN, now)).toBe("Unknown time");
  });
});

describe("toEpochMs", () => {
  it("accepts ISO strings, epoch milliseconds and Date", () => {
    const ms = Date.parse("2026-10-06T02:05:00Z");
    expect(toEpochMs("2026-10-06T02:05:00Z")).toBe(ms);
    expect(toEpochMs(ms)).toBe(ms);
    expect(toEpochMs(new Date(ms))).toBe(ms);
    expect(toEpochMs("not a date")).toBeNaN();
  });
});

describe("clamp01 / formatPercent", () => {
  it("clamps to the unit interval", () => {
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(1.7)).toBe(1);
    expect(clamp01(0.42)).toBe(0.42);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("formats a 0–1 score as a whole percentage", () => {
    expect(formatPercent(0.874)).toBe("87%");
    expect(formatPercent(0.875)).toBe("88%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(2)).toBe("100%");
  });
});
