import { describe, expect, it } from "vitest";
import { NAV_ITEMS, isActivePath } from "./nav";

describe("isActivePath", () => {
  it("matches the page itself and anything nested below it", () => {
    expect(isActivePath("/workspace", "/workspace")).toBe(true);
    expect(isActivePath("/workspace/deals/abc", "/workspace")).toBe(true);
  });

  it("does not match a sibling route that merely shares a prefix", () => {
    expect(isActivePath("/workspaces", "/workspace")).toBe(false);
    expect(isActivePath("/operations", "/workspace")).toBe(false);
  });

  it("treats the home link as active only on the home page", () => {
    expect(isActivePath("/", "/")).toBe(true);
    expect(isActivePath("/workspace", "/")).toBe(false);
  });
});

describe("NAV_ITEMS", () => {
  it("lists the product areas, then the explainer, with absolute, unique paths", () => {
    expect(NAV_ITEMS.map((item) => item.href)).toEqual(["/workspace", "/operations", "/policies", "/how-it-works"]);
    expect(new Set(NAV_ITEMS.map((item) => item.href)).size).toBe(NAV_ITEMS.length);
    expect(NAV_ITEMS.every((item) => item.label.length > 0)).toBe(true);
  });
});
