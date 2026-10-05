/**
 * Contract compiler.
 *
 * Turns agreed terms into the immutable contract artifact and its SHA-256 fingerprint. The
 * fingerprint is what binds everything downstream together: the PayPal order carries it in
 * custom_id, every verification report names it, and capture is refused unless all three agree.
 *
 * Compilation is deterministic — the same input always yields the same contract and hash —
 * and takes nothing from an LLM: verification rules are derived from the deliverable spec.
 */
import { canonicalJson, sha256Hex } from "./canonical";
import {
  assertNever,
  deliverableCountLabel,
  formatUtcTimestamp,
  joinList,
  languageName,
  parseTimestamp,
  plural,
  singleLine,
  truncate,
} from "./format";
import {
  ContractSchema,
  type Contract,
  type DeliverableSpec,
  type Mandate,
  type Policy,
  type SignedContract,
  type Terms,
  type VerificationRule,
  type VerificationRuleKind,
} from "./schemas";
import { BUYER_IDENTITY, type SellerProfile } from "./sellers";

const RULE_DESCRIPTION_MAX = 200;
const TITLE_MAX = 160;
/** PayPal purchase_units[].description is cut off after 127 characters. */
const PAYPAL_DESCRIPTION_MAX = 127;

type RuleDraft = Pick<VerificationRule, "kind" | "description" | "evaluator">;

function draft(kind: VerificationRuleKind, evaluator: VerificationRule["evaluator"], description: string): RuleDraft {
  return { kind, evaluator, description: truncate(description, RULE_DESCRIPTION_MAX) };
}

function deadlineRule(terms: Terms): RuleDraft {
  return draft("deadline", "deterministic", `Delivered by ${formatUtcTimestamp(terms.deadline)}`);
}

function ruleDrafts(deliverable: DeliverableSpec, terms: Terms): RuleDraft[] {
  switch (deliverable.kind) {
    case "illustration":
      return [
        draft("deliverable_count", "deterministic", `${plural(terms.count, "illustration")} delivered`),
        draft(
          "aspect_ratio_coverage",
          "deterministic",
          `Every illustration delivered in ${joinList(deliverable.aspectRatios)}`,
        ),
        draft("valid_format", "deterministic", "Files are valid, safe SVG"),
        deadlineRule(terms),
        draft("brief_adherence", "ai", `Illustrations match the brief: ${singleLine(deliverable.subject)}`),
        draft(
          "no_embedded_instructions",
          "deterministic",
          "Files contain no hidden instructions aimed at the verifier",
        ),
      ];
    case "copy":
      return [
        draft("deliverable_count", "deterministic", `${plural(terms.count, "copy piece")} delivered`),
        draft(
          "language_coverage",
          "ai",
          `Every piece delivered in ${joinList(deliverable.languages.map(languageName))}`,
        ),
        draft("word_count", "deterministic", `Each piece is ${deliverable.minWords}–${deliverable.maxWords} words`),
        deadlineRule(terms),
        draft("brief_adherence", "ai", `Copy matches the brief: ${singleLine(deliverable.subject)}`),
        draft(
          "no_embedded_instructions",
          "deterministic",
          "Text contains no hidden instructions aimed at the verifier",
        ),
      ];
    default:
      return assertNever(deliverable);
  }
}

/**
 * The conditions a delivery must satisfy, derived purely from the deliverable spec and the
 * agreed terms. Every rule is required: a contract never auto-captures on advisory checks alone.
 */
export function deriveVerificationRules(deliverable: DeliverableSpec, terms: Terms): VerificationRule[] {
  return ruleDrafts(deliverable, terms).map((rule, i) => ({ id: `R${i + 1}`, required: true, ...rule }));
}

/** SHA-256 over the canonical JSON of the contract. Independent of key order. */
export function hashContract(contract: Contract): string {
  return sha256Hex(canonicalJson(contract));
}

function contractTitle(deliverable: DeliverableSpec, count: number): string {
  return truncate(`${deliverableCountLabel(deliverable.kind, count)} · ${singleLine(deliverable.subject)}`, TITLE_MAX);
}

function canonicalTimestamp(iso: string, label: string): string {
  const ms = parseTimestamp(iso);
  if (ms === null) throw new RangeError(`compileContract: ${label} is not a valid timestamp: ${JSON.stringify(iso)}`);
  return new Date(ms).toISOString();
}

/**
 * Compile the agreed terms into a signed contract.
 *
 * The scope comes from the buyer's mandate with the negotiated count; the confidence thresholds
 * that later gate settlement are copied from the policy in force NOW, so a later policy edit
 * cannot retroactively change what this contract requires.
 *
 * @throws ZodError when the result would not be a valid contract (e.g. a count the spec forbids).
 */
export function compileContract(input: {
  dealId: string;
  contractId: string;
  mandate: Mandate;
  terms: Terms;
  seller: Pick<SellerProfile, "id" | "name">;
  policy: Policy;
  now: Date;
}): SignedContract {
  const { dealId, contractId, mandate, seller, policy, now } = input;
  // Deadlines may arrive with a UTC offset; the hashed artifact always stores the UTC instant.
  const terms: Terms = { ...input.terms, deadline: canonicalTimestamp(input.terms.deadline, "terms.deadline") };
  const deliverable: DeliverableSpec = { ...mandate.deliverable, count: terms.count };

  const contract = ContractSchema.parse({
    contractId,
    schemaVersion: 1,
    dealId,
    createdAt: now.toISOString(),
    title: contractTitle(deliverable, terms.count),
    category: mandate.category,
    buyer: { id: BUYER_IDENTITY.id, name: BUYER_IDENTITY.name },
    seller: { id: seller.id, name: seller.name },
    price: { amountMinor: terms.priceMinor, currency: "USD" },
    deadline: terms.deadline,
    revisionLimit: terms.revisionLimit,
    deliverables: [deliverable],
    verificationRules: deriveVerificationRules(deliverable, terms),
    settlement: {
      trigger: "verified_delivery",
      autoCaptureMinConfidence: policy.autoCaptureMinConfidence,
      humanReviewMinConfidence: policy.humanReviewMinConfidence,
      onExhaustedRevisions: "void_authorization",
    },
  } satisfies Contract);

  return { contract, termsHash: hashContract(contract) };
}

/**
 * True when `termsHash` is the fingerprint of `contract` as it stands now. Never throws:
 * a contract that cannot even be canonicalised is, by definition, not the one that was signed.
 */
export function verifyContractHash(signed: SignedContract): boolean {
  try {
    return hashContract(signed.contract) === signed.termsHash;
  } catch {
    return false;
  }
}

/** PayPal custom_id (max 255 chars, not shown to the payer): binds PayPal's record to the contract. */
export function paypalCustomId(signed: SignedContract): string {
  return `pact:v1:${signed.termsHash}`;
}

/** PayPal invoice_id (max 127 chars, unique per merchant): the contract id. */
export function paypalInvoiceId(signed: SignedContract): string {
  return signed.contract.contractId;
}

/** PayPal purchase-unit description shown to the payer, e.g. "PACT ctr_xxx · 3 illustrations · Northwind Studio". */
export function paypalDescription(signed: SignedContract): string {
  const { contract } = signed;
  const deliverable = contract.deliverables[0];
  const scope = deliverableCountLabel(deliverable.kind, deliverable.count);
  return truncate(`PACT ${contract.contractId} · ${scope} · ${contract.seller.name}`, PAYPAL_DESCRIPTION_MAX);
}
