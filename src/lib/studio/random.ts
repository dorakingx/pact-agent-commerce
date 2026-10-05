/**
 * Deterministic hashing and pseudo-randomness for the studio.
 *
 * A delivery must be reproducible: the same contract always yields the same files, so that a
 * verification report, an audit entry and a re-render in the browser all describe one artefact.
 * Nothing in the studio may call Math.random().
 */

/** FNV-1a over UTF-16 code units, folded to an unsigned 32-bit integer. */
export function hash32(...parts: readonly (string | number)[]): number {
  let h = 0x811c9dc5;
  // The separator keeps ("ab", "c") and ("a", "bc") from colliding.
  const text = parts.join("\u001f");
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** A shuffled copy (Fisher–Yates). */
  shuffle<T>(items: readonly T[]): T[];
}

/** mulberry32: tiny, fast, and well distributed enough for layout variation. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int,
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new RangeError("cannot pick from an empty list");
      return items[int(0, items.length - 1)];
    },
    chance: (p) => next() < p,
    shuffle: <T>(items: readonly T[]): T[] => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = int(0, i);
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
  };
}
