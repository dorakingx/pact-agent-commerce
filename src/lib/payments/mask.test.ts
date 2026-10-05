import { describe, expect, it } from "vitest";
import { maskEmail } from "./mask";

describe("maskEmail", () => {
  it("keeps the first two characters and the domain", () => {
    expect(maskEmail("sb-buyer42@personal.example.com")).toBe("sb****@personal.example.com");
  });

  it("uses a fixed-width mask, so the length of the hidden part is not revealed", () => {
    expect(maskEmail("abc@example.com")).toBe("ab****@example.com");
    expect(maskEmail("abcdefghijklmnop@example.com")).toBe("ab****@example.com");
  });

  it("never shows a one- or two-character local part in full", () => {
    expect(maskEmail("ab@example.com")).toBe("a****@example.com");
    expect(maskEmail("a@example.com")).toBe("a****@example.com");
  });

  it("returns null when there is nothing to mask", () => {
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail(undefined)).toBeNull();
    expect(maskEmail("   ")).toBeNull();
  });

  it("reveals nothing of a value that is not an e-mail address", () => {
    expect(maskEmail("not-an-address")).toBe("****");
    expect(maskEmail("@example.com")).toBe("****");
    expect(maskEmail("someone@")).toBe("****");
  });
});
