import { describe, expect, it } from "vitest";
import { mix } from "./palettes";
import { createRng, hash32 } from "./random";

describe("hash32", () => {
  it("is stable, unsigned and sensitive to part boundaries", () => {
    expect(hash32("landing page", 1)).toBe(hash32("landing page", 1));
    expect(hash32("landing page", 1)).not.toBe(hash32("landing page", 2));
    expect(hash32("ab", "c")).not.toBe(hash32("a", "bc"));
    for (const value of [hash32(""), hash32("x"), hash32("日本語", 3)]) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("createRng", () => {
  it("replays the same sequence for the same seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const draws = (rng: ReturnType<typeof createRng>): number[] => Array.from({ length: 20 }, () => rng.next());
    const first = draws(a);
    expect(draws(b)).toEqual(first);
    expect(draws(c)).not.toEqual(first);
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("keeps ranges, integers and picks inside their bounds", () => {
    const rng = createRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) {
      const real = rng.range(-2, 3);
      expect(real).toBeGreaterThanOrEqual(-2);
      expect(real).toBeLessThan(3);
      const whole = rng.int(4, 6);
      expect([4, 5, 6]).toContain(whole);
      seen.add(whole);
      expect(["a", "b"]).toContain(rng.pick(["a", "b"]));
    }
    expect(seen).toEqual(new Set([4, 5, 6]));
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it("shuffles into a permutation without touching the input", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8] as const;
    const shuffled = createRng(99).shuffle(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...shuffled].sort((a, b) => a - b)).toEqual([...input]);
    expect(createRng(99).shuffle(input)).toEqual(shuffled);
  });
});

describe("mix", () => {
  it("blends two colours and clamps the ratio", () => {
    expect(mix("#000000", "#FFFFFF", 0)).toBe("#000000");
    expect(mix("#000000", "#FFFFFF", 1)).toBe("#FFFFFF");
    expect(mix("#000000", "#FFFFFF", 0.5)).toBe("#808080");
    expect(mix("#102030", "#FFFFFF", -3)).toBe("#102030");
    expect(mix("#102030", "#405060", 9)).toBe("#405060");
  });
});
