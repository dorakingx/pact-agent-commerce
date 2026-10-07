import { describe, expect, it } from "vitest";
import { statesOnlyForeignBudget } from "./intent-extract";

describe("statesOnlyForeignBudget", () => {
  it.each([
    "3 landing-page illustrations in 16:9, under €50",
    "Two icons, budget is 5000 yen",
    "Write 4 taglines, at most £40",
    "Three banners, max 60 EUR, by Friday",
    "ロゴを2つ、予算は5000円で",
    "Two posters for ¥8000",
    "Icons for our app, JPY 9000 at most",
  ])("is true for a budget in another currency and no dollar amount: %s", (intent) => {
    expect(statesOnlyForeignBudget(intent)).toBe(true);
  });

  it.each([
    "3 landing-page illustrations in 16:9, under $50",
    "Two icons, about €45 — call it $50 at most",
    "Three banners for our euro trip campaign, budget $80",
    "An illustration of a 5 pound cake for the bakery, under 40 dollars",
    "Two posters about the yen carry trade",
    "Write 4 taglines for our coffee subscription",
  ])("is false when a dollar amount is stated or no foreign amount is: %s", (intent) => {
    expect(statesOnlyForeignBudget(intent)).toBe(false);
  });
});
