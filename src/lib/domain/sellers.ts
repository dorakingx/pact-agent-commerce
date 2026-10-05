/**
 * Seller directory for the demo marketplace.
 *
 * Each seller is an autonomous agent with a deterministic rate card (its private pricing
 * policy) and a behaviour profile. Two profiles are CONTROLLED DEMO FAULTS, clearly labelled
 * in the UI, so the failure paths of the settlement engine can be shown on demand.
 */
import type { Category, SellerBehavior } from "./schemas";

export interface RateCard {
  /** Illustration: price per illustration including its first aspect ratio. */
  illustrationBaseMinor: number;
  /** Illustration: price per additional aspect ratio, per illustration. */
  extraRatioMinor: number;
  /** Copy: price per word (of maxWords) for the first language, in minor units. */
  perWordMinor: number;
  /** Copy: multiplier applied to each additional language. */
  extraLanguageFactor: number;
  /** Price per included revision round. */
  revisionMinor: number;
  /** Rush surcharges, checked in order: first tier whose `underHours` exceeds the lead time applies. */
  rushTiers: readonly { underHours: number; factor: number }[];
  /** Walk-away price as a fraction of list (0–1). Private to the seller. */
  floorFactor: number;
  /** Fastest turnaround the seller commits to, in hours. */
  minHours: number;
}

export interface SellerProfile {
  id: string;
  name: string;
  tagline: string;
  categories: readonly Category[];
  /** "new" sellers have no settled history with this buyer and can trigger a policy approval. */
  trust: "established" | "new";
  completedDeals: number;
  /** Share of past deals captured on first verification, 0–1. */
  firstPassRate: number;
  behavior: SellerBehavior;
  rateCard: RateCard;
}

export const SELLERS: readonly SellerProfile[] = [
  {
    id: "northwind",
    name: "Northwind Studio",
    tagline: "Editorial-grade vector illustration, delivered to spec.",
    categories: ["illustration"],
    trust: "established",
    completedDeals: 184,
    firstPassRate: 0.97,
    behavior: "reliable",
    rateCard: {
      illustrationBaseMinor: 1300,
      extraRatioMinor: 350,
      perWordMinor: 0,
      extraLanguageFactor: 0,
      revisionMinor: 300,
      rushTiers: [
        { underHours: 4, factor: 1.5 },
        { underHours: 12, factor: 1.2 },
      ],
      floorFactor: 0.84,
      minHours: 2,
    },
  },
  {
    id: "quickdraw",
    name: "Quickdraw Collective",
    tagline: "Fast, cheap banner sets. Sometimes too fast.",
    categories: ["illustration"],
    trust: "established",
    completedDeals: 61,
    firstPassRate: 0.72,
    behavior: "omits_variant",
    rateCard: {
      illustrationBaseMinor: 1100,
      extraRatioMinor: 300,
      perWordMinor: 0,
      extraLanguageFactor: 0,
      revisionMinor: 200,
      rushTiers: [{ underHours: 6, factor: 1.25 }],
      floorFactor: 0.82,
      minHours: 1,
    },
  },
  {
    id: "lingua",
    name: "Lingua Labs",
    tagline: "Launch copy and localisation by bilingual writer agents.",
    categories: ["copywriting", "translation"],
    trust: "established",
    completedDeals: 240,
    firstPassRate: 0.95,
    behavior: "reliable",
    rateCard: {
      illustrationBaseMinor: 0,
      extraRatioMinor: 0,
      perWordMinor: 14,
      extraLanguageFactor: 0.8,
      revisionMinor: 900,
      rushTiers: [
        { underHours: 6, factor: 1.4 },
        { underHours: 24, factor: 1.15 },
      ],
      floorFactor: 0.86,
      minHours: 3,
    },
  },
  {
    id: "pixelharbor",
    name: "Pixel Harbor",
    tagline: "New to the network. Unverified track record.",
    categories: ["illustration"],
    trust: "new",
    completedDeals: 0,
    firstPassRate: 0,
    behavior: "embeds_instructions",
    rateCard: {
      illustrationBaseMinor: 900,
      extraRatioMinor: 250,
      perWordMinor: 0,
      extraLanguageFactor: 0,
      revisionMinor: 200,
      rushTiers: [],
      floorFactor: 0.8,
      minHours: 1,
    },
  },
] as const;

export function getSeller(id: string): SellerProfile | undefined {
  return SELLERS.find((s) => s.id === id);
}

/** Default seller for a category when the human did not pick a scenario: the most reliable match. */
export function matchSeller(category: Category): SellerProfile | undefined {
  return SELLERS.filter((s) => s.categories.includes(category) && s.behavior === "reliable").sort(
    (a, b) => b.firstPassRate - a.firstPassRate,
  )[0];
}

/** Public subset safe to expose to the buyer side and the browser (no rate card, no floor). */
export interface SellerPublic {
  id: string;
  name: string;
  tagline: string;
  categories: readonly Category[];
  trust: "established" | "new";
  completedDeals: number;
  firstPassRate: number;
  /** Present only for controlled demo-fault sellers, so the UI can label them honestly. */
  demoFault: Exclude<SellerBehavior, "reliable"> | null;
}

export function toSellerPublic(s: SellerProfile): SellerPublic {
  return {
    id: s.id,
    name: s.name,
    tagline: s.tagline,
    categories: s.categories,
    trust: s.trust,
    completedDeals: s.completedDeals,
    firstPassRate: s.firstPassRate,
    demoFault: s.behavior === "reliable" ? null : s.behavior,
  };
}

export const BUYER_IDENTITY = { id: "buyer-agent", name: "Buyer Agent (acting for you)" } as const;
