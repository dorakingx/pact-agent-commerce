import { describe, expect, it } from "vitest";
import { AG_THEME_ATTRIBUTE, THEME_ATTRIBUTE, THEME_STORAGE_KEY, isTheme, themeInitScript } from "./theme";

interface FakeEnvironment {
  stored?: string | null;
  storageThrows?: boolean;
  prefersDark?: boolean;
  hasMatchMedia?: boolean;
}

/** Runs the inline pre-paint script against a minimal fake of the browser globals it touches. */
function runInitScript({ stored = null, storageThrows = false, prefersDark = false, hasMatchMedia = true }: FakeEnvironment) {
  const attributes = new Map<string, string>();
  const document = { documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) } };
  const localStorage = {
    getItem: (key: string) => {
      if (storageThrows) throw new Error("SecurityError");
      return key === THEME_STORAGE_KEY ? stored : null;
    },
  };
  const matchMedia = (query: string) => ({ matches: query.includes("dark") && prefersDark });
  const window = hasMatchMedia ? { matchMedia } : {};
  new Function("document", "localStorage", "matchMedia", "window", themeInitScript)(document, localStorage, matchMedia, window);
  return attributes;
}

describe("themeInitScript", () => {
  it("applies a stored choice over the OS preference", () => {
    expect(runInitScript({ stored: "dark", prefersDark: false }).get(THEME_ATTRIBUTE)).toBe("dark");
    expect(runInitScript({ stored: "light", prefersDark: true }).get(THEME_ATTRIBUTE)).toBe("light");
  });

  it("follows the OS preference when nothing is stored", () => {
    expect(runInitScript({ prefersDark: true }).get(THEME_ATTRIBUTE)).toBe("dark");
    expect(runInitScript({ prefersDark: false }).get(THEME_ATTRIBUTE)).toBe("light");
  });

  it("ignores a corrupted stored value", () => {
    expect(runInitScript({ stored: "sepia", prefersDark: true }).get(THEME_ATTRIBUTE)).toBe("dark");
  });

  it("still themes the page when storage is blocked or matchMedia is missing", () => {
    expect(runInitScript({ storageThrows: true, prefersDark: true }).get(THEME_ATTRIBUTE)).toBe("dark");
    expect(runInitScript({ hasMatchMedia: false }).get(THEME_ATTRIBUTE)).toBe("light");
  });

  it("keeps the AG Grid theme attribute in sync", () => {
    for (const env of [{ stored: "dark" }, { stored: "light" }, { prefersDark: true }] satisfies FakeEnvironment[]) {
      const attributes = runInitScript(env);
      expect(attributes.get(AG_THEME_ATTRIBUTE)).toBe(attributes.get(THEME_ATTRIBUTE));
    }
  });
});

describe("isTheme", () => {
  it("accepts only the two supported themes", () => {
    expect(isTheme("light")).toBe(true);
    expect(isTheme("dark")).toBe(true);
    expect(isTheme("system")).toBe(false);
    expect(isTheme(null)).toBe(false);
  });
});
