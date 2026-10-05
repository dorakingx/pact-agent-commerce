import { describe, expect, it } from "vitest";
import { newDealCode, newId } from "./ids";
import { ContractSchema } from "./schemas";

describe("newId", () => {
  const prefixes = ["deal", "ctr", "sub", "rep", "evt", "sess", "art"] as const;

  it("is the prefix, an underscore and 12 lowercase alphanumerics", () => {
    for (const prefix of prefixes) {
      for (let i = 0; i < 50; i += 1) {
        expect(newId(prefix)).toMatch(new RegExp(`^${prefix}_[0-9a-z]{12}$`));
      }
    }
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newId("deal")));
    expect(ids.size).toBe(5000);
  });

  it("produces contract ids the contract schema accepts", () => {
    const contractId = ContractSchema.shape.contractId;
    for (let i = 0; i < 20; i += 1) {
      expect(contractId.safeParse(newId("ctr")).success).toBe(true);
    }
  });
});

describe("newDealCode", () => {
  it('is "PACT-" plus four unambiguous characters', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(newDealCode()).toMatch(/^PACT-[2-9A-HJ-NP-Z]{4}$/);
    }
  });

  it("never uses the look-alike characters 0, O, 1 or I", () => {
    const seen = new Set(Array.from({ length: 2000 }, () => newDealCode().slice(5)).join(""));
    for (const lookAlike of ["0", "O", "1", "I"]) {
      expect(seen.has(lookAlike)).toBe(false);
    }
    // 2000 codes x 4 chars over a 32-letter alphabet: every allowed character shows up.
    expect(seen.size).toBe(32);
  });
});
