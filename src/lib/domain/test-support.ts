/**
 * Builders shared by the domain test suites (and usable by integration tests): realistic
 * mandates for the four demo scenarios, signed contracts, and deliveries that satisfy them.
 * Not imported by application code.
 */
import { compileContract } from "./contract";
import { applyMove, buyerContextFor, initialNegotiation, nextActor, sellerContextFor } from "./negotiation";
import { scriptedBuyerMove, scriptedSellerMove } from "./negotiation-strategy";
import {
  DEFAULT_POLICY,
  type AspectRatio,
  type CopyArtifact,
  type IllustrationArtifact,
  type Mandate,
  type NegotiationState,
  type Policy,
  type SignedContract,
  type Submission,
  type Terms,
} from "./schemas";
import type { ScenarioId } from "./scenarios";
import { SELLERS, type SellerProfile } from "./sellers";

/** A Tuesday morning; "tomorrow at 6 PM" is 33 hours away. */
export const TEST_NOW = new Date("2026-10-06T09:00:00.000Z");
const TOMORROW_6PM = "2026-10-07T18:00:00.000Z";

export function sellerById(id: string): SellerProfile {
  const seller = SELLERS.find((candidate) => candidate.id === id);
  if (seller === undefined) throw new Error(`Unknown seller in test fixture: ${id}`);
  return seller;
}

/** Hand-built mandates equivalent to the request text of each demo scenario. */
export const SCENARIO_MANDATES: Record<ScenarioId, { mandate: Mandate; sellerId: string }> = {
  "happy-path": {
    sellerId: "northwind",
    mandate: {
      summary: "Three landing-page illustrations in 16:9 and 1:1",
      category: "illustration",
      deliverable: {
        kind: "illustration",
        count: 3,
        aspectRatios: ["16:9", "1:1"],
        subject: "landing-page hero illustrations",
        style: null,
      },
      minCount: 3,
      budgetMinor: 5000,
      deadline: TOMORROW_6PM,
      revisionsWanted: 1,
      minRevisions: 1,
      notes: [],
    },
  },
  revision: {
    sellerId: "quickdraw",
    mandate: {
      summary: "Two launch banner illustrations in 16:9 and 1:1",
      category: "illustration",
      deliverable: {
        kind: "illustration",
        count: 2,
        aspectRatios: ["16:9", "1:1"],
        subject: "launch banners for our product update",
        style: null,
      },
      minCount: 2,
      budgetMinor: 3200,
      deadline: TOMORROW_6PM,
      revisionsWanted: 1,
      minRevisions: 1,
      notes: [],
    },
  },
  approval: {
    sellerId: "lingua",
    mandate: {
      summary: "Six product descriptions in English and Japanese",
      category: "copywriting",
      deliverable: {
        kind: "copy",
        count: 6,
        languages: ["en", "ja"],
        minWords: 80,
        maxWords: 120,
        subject: "product descriptions for a new espresso machine lineup",
        tone: null,
      },
      minCount: 6,
      budgetMinor: 22000,
      deadline: "2026-10-09T09:00:00.000Z",
      revisionsWanted: 2,
      minRevisions: 1,
      notes: [],
    },
  },
  injection: {
    sellerId: "pixelharbor",
    mandate: {
      summary: "Two hero illustrations for a security webinar page",
      category: "illustration",
      deliverable: {
        kind: "illustration",
        count: 2,
        aspectRatios: ["16:9"],
        subject: "hero illustrations for a security webinar page",
        style: null,
      },
      minCount: 2,
      budgetMinor: 4500,
      deadline: "2026-10-08T09:00:00.000Z",
      revisionsWanted: 1,
      minRevisions: 1,
      notes: [],
    },
  },
};

/** Play the two scripted negotiators against each other through the rules engine until it closes. */
export function playScripted(mandate: Mandate, seller: SellerProfile, now: Date = TEST_NOW): NegotiationState {
  const rules = { mandate, seller, now };
  let state = initialNegotiation();
  while (state.status === "open") {
    const actor = nextActor(state);
    const proposed =
      actor === "seller" ? scriptedSellerMove(sellerContextFor(state, rules)) : scriptedBuyerMove(buyerContextFor(state, rules));
    state = applyMove(state, actor, proposed, { source: "scripted", model: null, latencyMs: null }, rules).state;
  }
  return state;
}

export function signedContractFor(
  scenario: ScenarioId,
  overrides: { terms?: Partial<Terms>; policy?: Policy; dealId?: string; contractId?: string } = {},
): SignedContract {
  const { mandate, sellerId } = SCENARIO_MANDATES[scenario];
  const seller = sellerById(sellerId);
  const terms: Terms = {
    priceMinor: 4700,
    deadline: mandate.deadline,
    revisionLimit: mandate.revisionsWanted,
    count: mandate.deliverable.count,
    ...overrides.terms,
  };
  return compileContract({
    dealId: overrides.dealId ?? "deal_test00000001",
    contractId: overrides.contractId ?? "ctr_test00000001",
    mandate,
    terms,
    seller,
    policy: overrides.policy ?? DEFAULT_POLICY,
    now: TEST_NOW,
  });
}

const RATIO_PIXELS: Record<AspectRatio, readonly [width: number, height: number]> = {
  "16:9": [1600, 900],
  "1:1": [1200, 1200],
  "4:3": [1600, 1200],
  "3:2": [1500, 1000],
  "4:5": [1200, 1500],
  "9:16": [900, 1600],
};

/** A minimal static SVG whose declared size matches the given pixels. `body` is inserted verbatim. */
export function svgMarkup(width: number, height: number, body = ""): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="#0b1f3a"/><circle cx="${width / 2}" cy="${height / 2}" r="120" fill="#f5b942"/>` +
    `${body}</svg>`
  );
}

export function illustrationArtifact(
  index: number,
  ratio: AspectRatio,
  overrides: Partial<IllustrationArtifact> = {},
): IllustrationArtifact {
  const [width, height] = RATIO_PIXELS[ratio];
  return {
    id: `art_${index}_${ratio.replace(":", "x")}`,
    kind: "illustration",
    index,
    title: `Hero illustration ${index}`,
    aspectRatio: ratio,
    width,
    height,
    format: "svg",
    svg: svgMarkup(overrides.width ?? width, overrides.height ?? height),
    description: "A calm sunrise over layered hills in navy and amber.",
    ...overrides,
  };
}

const ENGLISH_FILLER = [
  "the", "new", "espresso", "machine", "brings", "café", "quality", "coffee", "to", "your", "kitchen", "with",
  "precise", "temperature", "control", "and", "a", "quiet", "pump", "that", "is", "ready", "in", "seconds",
];

/** English prose with exactly `words` words. */
export function englishText(words: number): string {
  return Array.from({ length: words }, (_, i) => ENGLISH_FILLER[i % ENGLISH_FILLER.length]).join(" ");
}

export function copyArtifact(index: number, language: string, text: string, overrides: Partial<CopyArtifact> = {}): CopyArtifact {
  return {
    id: `art_${index}_${language}`,
    kind: "copy",
    index,
    title: `Product description ${index}`,
    language,
    text,
    ...overrides,
  };
}

export function submissionOf(
  artifacts: Submission["artifacts"],
  overrides: Partial<Submission> = {},
): Submission {
  return {
    id: "sub_test00000001",
    dealId: "deal_test00000001",
    round: 1,
    artifacts,
    note: "Here is the delivery. Happy to adjust anything.",
    source: "scripted",
    model: null,
    submittedAt: "2026-10-07T03:40:00.000Z",
    ...overrides,
  };
}

/** A delivery that satisfies the happy-path contract: 3 illustrations × (16:9, 1:1). */
export function completeIllustrationSet(count = 3, ratios: readonly AspectRatio[] = ["16:9", "1:1"]): IllustrationArtifact[] {
  const artifacts: IllustrationArtifact[] = [];
  for (let index = 1; index <= count; index += 1) {
    for (const ratio of ratios) artifacts.push(illustrationArtifact(index, ratio));
  }
  return artifacts;
}
