import { describe, expect, it } from "vitest";
import {
  MAX_AMOUNT_MINOR,
  assertMinor,
  clampMinor,
  formatMoney,
  fromPayPalValue,
  isMinor,
  percentOf,
  roundToMajor,
  toMinor,
  toPayPalValue,
} from "./money";

describe("isMinor / assertMinor", () => {
  it("accepts non-negative safe integers only", () => {
    for (const ok of [0, 1, 99, 100, MAX_AMOUNT_MINOR, Number.MAX_SAFE_INTEGER]) {
      expect(isMinor(ok)).toBe(true);
      expect(() => assertMinor(ok)).not.toThrow();
    }
    for (const bad of [-1, 0.5, 45.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "100", null, undefined]) {
      expect(isMinor(bad)).toBe(false);
      expect(() => assertMinor(bad, "price")).toThrow(RangeError);
    }
  });

  it("names the offending field in the error", () => {
    expect(() => assertMinor(1.5, "capture amount")).toThrow(/capture amount/);
  });
});

describe("toPayPalValue / fromPayPalValue", () => {
  it("round-trips every amount from $0.00 to $50.00", () => {
    for (let minor = 0; minor <= 5000; minor += 1) {
      expect(fromPayPalValue(toPayPalValue(minor))).toBe(minor);
    }
  });

  it("round-trips large and awkward amounts exactly", () => {
    for (const minor of [9_999, 10_000, 10_001, 123_456, MAX_AMOUNT_MINOR, 99_999_999, 12_345_678_901, 99_999_999_999]) {
      expect(fromPayPalValue(toPayPalValue(minor))).toBe(minor);
    }
  });

  it("always renders exactly two decimals and no float artefacts", () => {
    expect(toPayPalValue(0)).toBe("0.00");
    expect(toPayPalValue(5)).toBe("0.05");
    expect(toPayPalValue(50)).toBe("0.50");
    expect(toPayPalValue(4550)).toBe("45.50");
    expect(toPayPalValue(4700)).toBe("47.00");
    // 0.1 + 0.2 style inputs never exist here: the value is derived from integer arithmetic.
    expect(toPayPalValue(30)).toBe("0.30");
    expect(toPayPalValue(1_000_000)).toBe("10000.00");
  });

  it("refuses to render floats and negatives", () => {
    for (const bad of [45.5, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => toPayPalValue(bad)).toThrow(RangeError);
    }
  });

  it("parses the decimal forms PayPal may return", () => {
    expect(fromPayPalValue("45.50")).toBe(4550);
    expect(fromPayPalValue("45.5")).toBe(4550);
    expect(fromPayPalValue("45")).toBe(4500);
    expect(fromPayPalValue("0.07")).toBe(7);
    expect(fromPayPalValue("0")).toBe(0);
    expect(fromPayPalValue("007.10")).toBe(710);
  });

  it("rejects anything that is not a plain non-negative decimal", () => {
    const invalid = ["", " ", "-1.00", "+1.00", "1e3", "1,000", "1,000.00", "1.000", "1.", ".50", "$45.00", "45.50 ", " 45.50", "45.5.0", "NaN", "Infinity", "0x10", "１２.００", "1234567890.00"];
    for (const value of invalid) {
      expect(() => fromPayPalValue(value), value).toThrow(RangeError);
    }
  });

  it("rejects non-string input at runtime", () => {
    for (const value of [45.5, null, undefined, {}]) {
      expect(() => fromPayPalValue(value as unknown as string)).toThrow(RangeError);
    }
  });
});

describe("toMinor", () => {
  it("converts major units, rounding half away from zero", () => {
    expect(toMinor(0)).toBe(0);
    expect(toMinor(45.5)).toBe(4550);
    expect(toMinor(19.99)).toBe(1999);
    expect(toMinor(1.005)).toBe(101);
    expect(toMinor(0.1 + 0.2)).toBe(30);
  });

  it("rejects negatives and non-finite numbers", () => {
    for (const bad of [-0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => toMinor(bad)).toThrow(RangeError);
    }
  });
});

describe("formatMoney", () => {
  it("formats with a dollar sign, thousands separators and two decimals", () => {
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(5)).toBe("$0.05");
    expect(formatMoney(4700)).toBe("$47.00");
    expect(formatMoney(100_000)).toBe("$1,000.00");
    expect(formatMoney(123_456_789)).toBe("$1,234,567.89");
  });
});

describe("percentOf", () => {
  it("rounds to the nearest minor unit", () => {
    expect(percentOf(4700, 50)).toBe(2350);
    expect(percentOf(4700, 33)).toBe(1551);
    expect(percentOf(999, 50)).toBe(500);
    expect(percentOf(100, 1)).toBe(1);
    expect(percentOf(0, 99)).toBe(0);
    expect(percentOf(4700, 0)).toBe(0);
    expect(percentOf(4700, 100)).toBe(4700);
  });

  it("rejects invalid inputs", () => {
    expect(() => percentOf(47.5, 50)).toThrow(RangeError);
    expect(() => percentOf(4700, -1)).toThrow(RangeError);
    expect(() => percentOf(4700, Number.NaN)).toThrow(RangeError);
  });
});

describe("roundToMajor / clampMinor", () => {
  it("rounds to the nearest whole dollar", () => {
    expect(roundToMajor(0)).toBe(0);
    expect(roundToMajor(49)).toBe(0);
    expect(roundToMajor(50)).toBe(100);
    expect(roundToMajor(4660)).toBe(4700);
    expect(roundToMajor(4940)).toBe(4900);
    expect(() => roundToMajor(-1)).toThrow(RangeError);
  });

  it("clamps into a range and rounds fractional input", () => {
    expect(clampMinor(50, 100, 200)).toBe(100);
    expect(clampMinor(250, 100, 200)).toBe(200);
    expect(clampMinor(150.4, 100, 200)).toBe(150);
  });
});
