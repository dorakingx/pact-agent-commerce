import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "./canonical";
import {
  compileContract,
  deriveVerificationRules,
  hashContract,
  paypalCustomId,
  paypalDescription,
  paypalInvoiceId,
  verifyContractHash,
} from "./contract";
import {
  ContractSchema,
  DEFAULT_POLICY,
  SignedContractSchema,
  VerificationRuleSchema,
  type Contract,
  type IllustrationSpec,
  type Mandate,
  type Policy,
  type SignedContract,
  type Terms,
} from "./schemas";
import { BUYER_IDENTITY } from "./sellers";
import { SCENARIO_MANDATES, TEST_NOW, sellerById, signedContractFor } from "./test-support";

const happy = SCENARIO_MANDATES["happy-path"].mandate;
const approval = SCENARIO_MANDATES.approval.mandate;
const heroSpec = happy.deliverable as IllustrationSpec;
const northwind = sellerById("northwind");
const terms: Terms = { priceMinor: 4700, deadline: "2026-10-07T18:00:00.000Z", revisionLimit: 1, count: 3 };

type CompileInput = Parameters<typeof compileContract>[0];
const baseInput: CompileInput = {
  dealId: "deal_abc123def456",
  contractId: "ctr_k3v9x0q2m7ab",
  mandate: happy,
  terms,
  seller: northwind,
  policy: DEFAULT_POLICY,
  now: TEST_NOW,
};
const compile = (overrides: Partial<CompileInput> = {}): SignedContract => compileContract({ ...baseInput, ...overrides });

/** Rebuild an object with its keys in reverse order, recursively. */
function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeys) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)])) as T;
  }
  return value;
}

describe("deriveVerificationRules", () => {
  it("derives the six illustration rules", () => {
    expect(deriveVerificationRules(happy.deliverable, terms)).toEqual([
      { id: "R1", kind: "deliverable_count", required: true, evaluator: "deterministic", description: "3 illustrations delivered" },
      { id: "R2", kind: "aspect_ratio_coverage", required: true, evaluator: "deterministic", description: "Every illustration delivered in 16:9 and 1:1" },
      { id: "R3", kind: "valid_format", required: true, evaluator: "deterministic", description: "Files are valid, safe SVG" },
      { id: "R4", kind: "deadline", required: true, evaluator: "deterministic", description: "Delivered by 2026-10-07 18:00 UTC" },
      { id: "R5", kind: "brief_adherence", required: true, evaluator: "ai", description: "Illustrations match the brief: landing-page hero illustrations" },
      { id: "R6", kind: "no_embedded_instructions", required: true, evaluator: "deterministic", description: "Files contain no hidden instructions aimed at the verifier" },
    ]);
  });

  it("derives the six copy rules", () => {
    const copyTerms: Terms = { priceMinor: 18000, deadline: "2026-10-09T09:00:00.000Z", revisionLimit: 2, count: 6 };
    expect(deriveVerificationRules(approval.deliverable, copyTerms)).toEqual([
      { id: "R1", kind: "deliverable_count", required: true, evaluator: "deterministic", description: "6 copy pieces delivered" },
      { id: "R2", kind: "language_coverage", required: true, evaluator: "ai", description: "Every piece delivered in English and Japanese" },
      { id: "R3", kind: "word_count", required: true, evaluator: "deterministic", description: "Each piece is 80–120 words" },
      { id: "R4", kind: "deadline", required: true, evaluator: "deterministic", description: "Delivered by 2026-10-09 09:00 UTC" },
      { id: "R5", kind: "brief_adherence", required: true, evaluator: "ai", description: "Copy matches the brief: product descriptions for a new espresso machine lineup" },
      { id: "R6", kind: "no_embedded_instructions", required: true, evaluator: "deterministic", description: "Text contains no hidden instructions aimed at the verifier" },
    ]);
  });

  it("uses the negotiated count and reads naturally for one item and one ratio", () => {
    const single: IllustrationSpec = { ...heroSpec, aspectRatios: ["4:5"] };
    const rules = deriveVerificationRules(single, { ...terms, count: 1 });
    expect(rules[0].description).toBe("1 illustration delivered");
    expect(rules[1].description).toBe("Every illustration delivered in 4:5");
    const three = deriveVerificationRules({ ...heroSpec, aspectRatios: ["16:9", "1:1", "4:5"] }, terms);
    expect(three[1].description).toBe("Every illustration delivered in 16:9, 1:1 and 4:5");
  });

  it("always yields schema-valid, required rules, even for a 200-character brief with line breaks", () => {
    const subject = `Hero art\nfor the launch ${"with many many details ".repeat(9)}`.slice(0, 200);
    const rules = deriveVerificationRules({ ...heroSpec, subject }, terms);
    for (const rule of rules) {
      expect(VerificationRuleSchema.safeParse(rule).success, rule.id).toBe(true);
      expect(rule.required).toBe(true);
      expect(rule.description).not.toMatch(/[\n\r\t]/);
    }
    expect(rules[4].description.length).toBeLessThanOrEqual(200);
    expect(rules[4].description.endsWith("…")).toBe(true);
  });

  it("assigns only judgement calls to the AI", () => {
    const aiKinds = (rules: ReturnType<typeof deriveVerificationRules>) => rules.filter((rule) => rule.evaluator === "ai").map((rule) => rule.kind);
    expect(aiKinds(deriveVerificationRules(happy.deliverable, terms))).toEqual(["brief_adherence"]);
    expect(aiKinds(deriveVerificationRules(approval.deliverable, terms))).toEqual(["language_coverage", "brief_adherence"]);
  });
});

describe("compileContract", () => {
  it("builds the contract from the mandate, the agreed terms and the policy in force", () => {
    const signed = compile();
    expect(signed.contract).toEqual({
      contractId: "ctr_k3v9x0q2m7ab",
      schemaVersion: 1,
      dealId: "deal_abc123def456",
      createdAt: "2026-10-06T09:00:00.000Z",
      title: "3 illustrations · landing-page hero illustrations",
      category: "illustration",
      buyer: { id: BUYER_IDENTITY.id, name: BUYER_IDENTITY.name },
      seller: { id: "northwind", name: "Northwind Studio" },
      price: { amountMinor: 4700, currency: "USD" },
      deadline: "2026-10-07T18:00:00.000Z",
      revisionLimit: 1,
      deliverables: [happy.deliverable],
      verificationRules: deriveVerificationRules(happy.deliverable, terms),
      settlement: {
        trigger: "verified_delivery",
        autoCaptureMinConfidence: 0.85,
        humanReviewMinConfidence: 0.5,
        onExhaustedRevisions: "void_authorization",
      },
    });
    expect(ContractSchema.safeParse(signed.contract).success).toBe(true);
    expect(SignedContractSchema.safeParse(signed).success).toBe(true);
  });

  it("fingerprints the canonical JSON of the contract", () => {
    const signed = compile();
    expect(signed.termsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(signed.termsHash).toBe(sha256Hex(canonicalJson(signed.contract)));
    expect(signed.termsHash).toBe(hashContract(signed.contract));
    expect(verifyContractHash(signed)).toBe(true);
  });

  it("is deterministic: the same input always gives the same contract and hash", () => {
    expect(compile()).toEqual(compile());
    const reordered = compile({ mandate: reverseKeys(happy), terms: reverseKeys(terms), policy: reverseKeys(DEFAULT_POLICY) });
    expect(reordered.termsHash).toBe(compile().termsHash);
  });

  it("only takes id and name from the seller: private rate cards never enter the contract", () => {
    const signed = compile();
    expect(Object.keys(signed.contract.seller).sort()).toEqual(["id", "name"]);
    expect(JSON.stringify(signed.contract)).not.toMatch(/rateCard|floorFactor|budgetMinor|minCount/);
    expect(compile({ seller: { id: "northwind", name: "Northwind Studio" } }).termsHash).toBe(signed.termsHash);
  });

  it("uses the negotiated count, not the count the buyer first wanted", () => {
    const flexible: Mandate = { ...happy, minCount: 2 };
    const signed = compile({ mandate: flexible, terms: { ...terms, count: 2 } });
    expect(signed.contract.deliverables[0].count).toBe(2);
    expect(signed.contract.title).toBe("2 illustrations · landing-page hero illustrations");
    expect(signed.contract.verificationRules[0].description).toBe("2 illustrations delivered");
    // The mandate itself is not modified.
    expect(flexible.deliverable.count).toBe(3);
  });

  it("stores the deadline as a UTC instant, so equal instants hash equally", () => {
    const tokyo = compile({ terms: { ...terms, deadline: "2026-10-08T03:00:00+09:00" } });
    expect(tokyo.contract.deadline).toBe("2026-10-07T18:00:00.000Z");
    expect(tokyo.termsHash).toBe(compile().termsHash);
  });

  it("freezes the policy's confidence thresholds into the contract", () => {
    const strict: Policy = { ...DEFAULT_POLICY, autoCaptureMinConfidence: 0.95, humanReviewMinConfidence: 0.7 };
    const signed = compile({ policy: strict });
    expect(signed.contract.settlement).toMatchObject({ autoCaptureMinConfidence: 0.95, humanReviewMinConfidence: 0.7 });
    expect(signed.termsHash).not.toBe(compile().termsHash);
  });

  it("is unaffected by policy fields that are not part of the contract", () => {
    const otherLimits: Policy = { ...DEFAULT_POLICY, autonomousLimitMinor: 1, dailyLimitMinor: 99, requireApprovalForNewSellers: false, allowedCategories: [] };
    expect(compile({ policy: otherLimits }).termsHash).toBe(compile().termsHash);
  });

  it("changes the hash when any term changes", () => {
    const original = compile().termsHash;
    const variants: Array<[string, Partial<CompileInput>]> = [
      ["price by one cent-step", { terms: { ...terms, priceMinor: 4800 } }],
      ["deadline by one second", { terms: { ...terms, deadline: "2026-10-07T18:00:01.000Z" } }],
      ["revision limit", { terms: { ...terms, revisionLimit: 2 } }],
      ["count", { mandate: { ...happy, minCount: 2 }, terms: { ...terms, count: 2 } }],
      ["seller id", { seller: { id: "quickdraw", name: "Northwind Studio" } }],
      ["seller name", { seller: { id: "northwind", name: "Northwind Studios" } }],
      ["deal id", { dealId: "deal_abc123def457" }],
      ["contract id", { contractId: "ctr_k3v9x0q2m7ac" }],
      ["creation time", { now: new Date(TEST_NOW.getTime() + 1) }],
      ["subject", { mandate: { ...happy, deliverable: { ...heroSpec, subject: "landing-page hero illustration" } } }],
      ["aspect ratios", { mandate: { ...happy, deliverable: { ...heroSpec, aspectRatios: ["16:9"] } } }],
      ["aspect ratio order", { mandate: { ...happy, deliverable: { ...heroSpec, aspectRatios: ["1:1", "16:9"] } } }],
      ["style", { mandate: { ...happy, deliverable: { ...heroSpec, style: "flat" } } }],
      ["category", { mandate: { ...happy, category: "other" } }],
      ["auto-capture threshold", { policy: { ...DEFAULT_POLICY, autoCaptureMinConfidence: 0.86 } }],
      ["human-review threshold", { policy: { ...DEFAULT_POLICY, humanReviewMinConfidence: 0.51 } }],
    ];
    const hashes = new Set([original]);
    for (const [label, overrides] of variants) {
      const hash = compile(overrides).termsHash;
      expect(hash, label).not.toBe(original);
      hashes.add(hash);
    }
    expect(hashes.size).toBe(variants.length + 1);
  });

  it("ignores mandate fields that are private to the buyer", () => {
    const original = compile().termsHash;
    const privateChanges: Mandate = { ...happy, budgetMinor: 9900, summary: "something else", notes: ["rush if possible"], revisionsWanted: 3 };
    expect(compile({ mandate: privateChanges }).termsHash).toBe(original);
  });

  it("compiles a copy contract", () => {
    const signed = compile({
      mandate: approval,
      terms: { priceMinor: 18000, deadline: approval.deadline, revisionLimit: 2, count: 6 },
      seller: sellerById("lingua"),
    });
    expect(signed.contract.title).toBe("6 copy pieces · product descriptions for a new espresso machine lineup");
    expect(signed.contract.category).toBe("copywriting");
    expect(signed.contract.verificationRules.map((rule) => rule.kind)).toContain("word_count");
    expect(verifyContractHash(signed)).toBe(true);
  });

  it("keeps the title within its limit and on one line", () => {
    const subject = `${"A very long subject line ".repeat(8)}`.trim().slice(0, 200);
    const signed = compile({ mandate: { ...happy, deliverable: { ...heroSpec, subject: `  ${subject.slice(0, 100)}\n${subject.slice(100, 196)}` } } });
    expect(signed.contract.title.length).toBeLessThanOrEqual(160);
    expect(signed.contract.title).not.toContain("\n");
    expect(signed.contract.title.startsWith("3 illustrations · A very long")).toBe(true);
  });

  it("refuses to produce an invalid contract", () => {
    expect(() => compile({ terms: { ...terms, priceMinor: 50 } })).toThrow();
    expect(() => compile({ terms: { ...terms, priceMinor: 47.5 } })).toThrow();
    expect(() => compile({ terms: { ...terms, count: 7 } })).toThrow(); // illustration specs allow at most 6
    expect(() => compile({ terms: { ...terms, revisionLimit: 4 } })).toThrow();
    expect(() => compile({ contractId: "contract-1" })).toThrow();
    expect(() => compile({ terms: { ...terms, deadline: "next week" } })).toThrow(RangeError);
  });

  it("does not mutate its input", () => {
    const input = structuredClone(baseInput);
    const snapshot = JSON.stringify(input);
    compileContract(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("hashContract / verifyContractHash", () => {
  const signed = compile();

  it("is independent of key order at every depth", () => {
    expect(hashContract(reverseKeys(signed.contract))).toBe(signed.termsHash);
    expect(verifyContractHash({ contract: reverseKeys(signed.contract), termsHash: signed.termsHash })).toBe(true);
  });

  it("survives a JSON round trip through storage", () => {
    const stored = JSON.parse(JSON.stringify(signed)) as SignedContract;
    expect(verifyContractHash(stored)).toBe(true);
  });

  it("detects any change to the contract after signing", () => {
    const tamper = (change: (contract: Contract) => void): boolean => {
      const copy = structuredClone(signed);
      change(copy.contract);
      return verifyContractHash(copy);
    };
    expect(tamper((c) => { c.price.amountMinor = 4600; })).toBe(false);
    expect(tamper((c) => { c.deadline = "2026-10-08T18:00:00.000Z"; })).toBe(false);
    expect(tamper((c) => { c.revisionLimit = 0; })).toBe(false);
    expect(tamper((c) => { c.seller.id = "pixelharbor"; })).toBe(false);
    expect(tamper((c) => { c.verificationRules[1].required = false; })).toBe(false);
    expect(tamper((c) => { c.verificationRules[4].evaluator = "deterministic"; })).toBe(false);
    expect(tamper((c) => { c.verificationRules.pop(); })).toBe(false);
    expect(tamper((c) => { c.verificationRules.reverse(); })).toBe(false);
    expect(tamper((c) => { c.settlement.autoCaptureMinConfidence = 0.5; })).toBe(false);
    expect(tamper((c) => { c.deliverables[0].count = 1; })).toBe(false);
    expect(tamper(() => undefined)).toBe(true);
  });

  it("detects a swapped or malformed hash", () => {
    const other = compile({ terms: { ...terms, priceMinor: 100 } });
    expect(verifyContractHash({ contract: signed.contract, termsHash: other.termsHash })).toBe(false);
    expect(verifyContractHash({ contract: signed.contract, termsHash: signed.termsHash.toUpperCase() })).toBe(false);
    expect(verifyContractHash({ contract: signed.contract, termsHash: "" })).toBe(false);
  });

  it("returns false, without throwing, for a contract that cannot be canonicalised", () => {
    const broken = structuredClone(signed) as SignedContract & { contract: Contract & { extra?: unknown } };
    broken.contract.extra = undefined;
    expect(verifyContractHash(broken)).toBe(false);
    const nan = structuredClone(signed);
    nan.contract.price.amountMinor = Number.NaN;
    expect(verifyContractHash(nan)).toBe(false);
  });
});

describe("PayPal bindings", () => {
  const signed = compile();

  it("binds the order to the contract through custom_id", () => {
    expect(paypalCustomId(signed)).toBe(`pact:v1:${signed.termsHash}`);
    expect(paypalCustomId(signed)).toHaveLength(72);
    expect(paypalCustomId(signed).length).toBeLessThanOrEqual(255);
    expect(paypalCustomId(compile({ terms: { ...terms, priceMinor: 4800 } }))).not.toBe(paypalCustomId(signed));
  });

  it("uses the contract id as invoice_id", () => {
    expect(paypalInvoiceId(signed)).toBe("ctr_k3v9x0q2m7ab");
    expect(paypalInvoiceId(signed).length).toBeLessThanOrEqual(127);
  });

  it("describes the purchase for the payer", () => {
    expect(paypalDescription(signed)).toBe("PACT ctr_k3v9x0q2m7ab · 3 illustrations · Northwind Studio");
    expect(paypalDescription(signedContractFor("approval", { terms: { priceMinor: 18000 } }))).toBe("PACT ctr_test00000001 · 6 copy pieces · Lingua Labs");
  });

  it("never exceeds PayPal's 127-character description limit", () => {
    const long = compile({ seller: { id: "northwind", name: "N".repeat(300) } });
    expect(paypalDescription(long)).toHaveLength(127);
    expect(paypalDescription(long).endsWith("…")).toBe(true);
  });
});
