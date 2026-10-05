import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("joins truthy class names", () => {
    expect(cn("a", false, null, undefined, "b", { c: true, d: false })).toBe("a b c");
  });

  it("lets a later Tailwind utility override an earlier conflicting one", () => {
    expect(cn("px-4 text-sm", "px-2")).toBe("text-sm px-2");
  });

  it("understands PACT's custom radius and shadow tokens", () => {
    expect(cn("rounded-card", "rounded-none")).toBe("rounded-none");
    expect(cn("rounded-md", "rounded-control")).toBe("rounded-control");
    expect(cn("shadow-pop", "shadow-none")).toBe("shadow-none");
  });

  it("does not confuse a token text colour with a font size", () => {
    expect(cn("text-sm", "text-muted")).toBe("text-sm text-muted");
    expect(cn("text-muted", "text-fg")).toBe("text-fg");
  });
});
