import { describe, expect, it } from "vitest";
import { isCanonicalIsoUtc, toIsoUtc, toIsoUtcOrNull } from "./time";

describe("toIsoUtc", () => {
  it.each([
    // Postgres text output, as returned by both drivers for timestamptz columns.
    ["2026-10-06 02:05:33.123+00", "2026-10-06T02:05:33.123Z"],
    ["2026-10-06 11:05:33.123456+09", "2026-10-06T02:05:33.123Z"],
    ["2026-10-06 07:35:33+05:30", "2026-10-06T02:05:33.000Z"],
    ["2026-10-05 21:35:33.5-04:30", "2026-10-06T02:05:33.500Z"],
    ["2026-10-06 02:05:33-00", "2026-10-06T02:05:33.000Z"],
    // ISO-8601 input from callers.
    ["2026-10-06T02:05:33.123Z", "2026-10-06T02:05:33.123Z"],
    ["2026-10-06T02:05:33Z", "2026-10-06T02:05:33.000Z"],
    ["2026-10-06T02:05Z", "2026-10-06T02:05:00.000Z"],
    ["2026-10-06T11:05:33+09:00", "2026-10-06T02:05:33.000Z"],
    ["2026-10-06T11:05:33+0900", "2026-10-06T02:05:33.000Z"],
    ["2026-10-06t02:05:33z", "2026-10-06T02:05:33.000Z"],
    ["  2026-10-06T02:05:33Z  ", "2026-10-06T02:05:33.000Z"],
  ])("converts %s", (input, expected) => {
    expect(toIsoUtc(input)).toBe(expected);
  });

  it("truncates sub-millisecond digits instead of rounding up", () => {
    expect(toIsoUtc("2026-10-06 02:05:33.999999+00")).toBe("2026-10-06T02:05:33.999Z");
  });

  it("crosses day and year boundaries correctly", () => {
    expect(toIsoUtc("2027-01-01 08:30:00+09")).toBe("2026-12-31T23:30:00.000Z");
  });

  it.each([
    "2026-10-06T02:05:33", // no offset: the time zone would be a guess
    "2026-10-06 02:05:33",
    "2026-10-06",
    "06/10/2026 02:05",
    "infinity",
    "",
  ])("rejects %j", (input) => {
    expect(() => toIsoUtc(input)).toThrow(RangeError);
  });

  it("rejects a well-formed but impossible instant", () => {
    expect(() => toIsoUtc("2026-13-45T02:05:33Z")).toThrow(/out of range/);
  });
});

describe("toIsoUtcOrNull", () => {
  it("passes null through and converts everything else", () => {
    expect(toIsoUtcOrNull(null)).toBeNull();
    expect(toIsoUtcOrNull("2026-10-06 02:05:33+00")).toBe("2026-10-06T02:05:33.000Z");
  });
});

describe("isCanonicalIsoUtc", () => {
  it("accepts only the exact Date#toISOString() form", () => {
    expect(isCanonicalIsoUtc(new Date().toISOString())).toBe(true);
    expect(isCanonicalIsoUtc("2026-10-06T02:05:33.123Z")).toBe(true);
    expect(isCanonicalIsoUtc("2026-10-06T02:05:33Z")).toBe(false);
    expect(isCanonicalIsoUtc("2026-10-06T11:05:33.123+09:00")).toBe(false);
    expect(isCanonicalIsoUtc("2026-10-06 02:05:33.123+00")).toBe(false);
    expect(isCanonicalIsoUtc("not a timestamp")).toBe(false);
  });
});
