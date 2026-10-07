import { describe, expect, it } from "vitest";
import { SCENARIOS } from "@/lib/domain/scenarios";
import { INTENT_MAX_CHARS as SERVER_MAX, INTENT_MIN_CHARS as SERVER_MIN, cleanText } from "@/lib/services/sanitize";
import { ApiClientError } from "./api";
import {
  INTENT_MAX_CHARS,
  INTENT_MIN_CHARS,
  cleanIntent,
  createErrorMessage,
  intentState,
  rateLimitMinutes,
  scenarioEdited,
} from "./deal-derive-compose";

describe("cleanIntent", () => {
  const samples = [
    "",
    "   ",
    "Get three landing-page illustrations for under $50 by tomorrow at 6 PM.",
    "  two\tbanners\n\nplease \r\n",
    "zero\u200bwidth\u200djoiners and a soft\u00adhyphen",
    "bidi \u202eoverride\u202c and a BOM \ufeff",
    "ｆｕｌｌ－ｗｉｄｔｈ　１２３ and ligature ﬁ",
    "line\u2028separator and paragraph\u2029separator and NEL\u0085here",
    "emoji 👩\u200d💻 stays readable",
    "日本語のリクエスト、明日の18時まで",
    "control\u0000chars\u0007gone",
  ];

  it("cleans exactly as the server does, so the counter shows the enforced number", () => {
    for (const sample of samples) expect(cleanIntent(sample)).toBe(cleanText(sample));
  });

  it("shares the server's limits", () => {
    expect(INTENT_MIN_CHARS).toBe(SERVER_MIN);
    expect(INTENT_MAX_CHARS).toBe(SERVER_MAX);
  });
});

describe("intentState", () => {
  it("an empty box is not valid, and does not nag yet", () => {
    expect(intentState("")).toEqual({ length: 0, tooShort: true, tooLong: false, valid: false, hint: null });
    expect(intentState(" \n\t ")).toMatchObject({ length: 0, valid: false, hint: null });
  });
  it("says how many characters are missing", () => {
    expect(intentState("fix bike")).toMatchObject({ length: 8, tooShort: true, valid: false, hint: "2 more to reach the 10-character minimum" });
  });
  it("accepts both ends of the range", () => {
    expect(intentState("x".repeat(10))).toMatchObject({ length: 10, valid: true, hint: null });
    expect(intentState("x".repeat(600))).toMatchObject({ length: 600, valid: true, hint: null });
  });
  it("says how far over the limit the text is", () => {
    expect(intentState("x".repeat(612))).toMatchObject({ length: 612, tooLong: true, valid: false, hint: "12 over the 600-character limit" });
  });
  it("counts after cleaning: padding and invisible characters are free", () => {
    expect(intentState(`  ${"x".repeat(600)}\u200b\n`).valid).toBe(true);
    expect(intentState("a         b").length).toBe(3);
  });
  it("every scenario's own text is valid", () => {
    for (const scenario of SCENARIOS) expect(intentState(scenario.intent).valid).toBe(true);
  });
});

describe("scenarioEdited", () => {
  const scenario = SCENARIOS[0];
  it("is false without a scenario, and for the scenario's own text", () => {
    expect(scenarioEdited("anything", undefined)).toBe(false);
    expect(scenarioEdited(scenario.intent, scenario)).toBe(false);
  });
  it("ignores changes the server would clean away", () => {
    expect(scenarioEdited(`  ${scenario.intent}\n`, scenario)).toBe(false);
  });
  it("is true once the words change", () => {
    expect(scenarioEdited(scenario.intent.replace("three", "four"), scenario)).toBe(true);
    expect(scenarioEdited("", scenario)).toBe(true);
  });
});

describe("create errors", () => {
  const now = Date.parse("2026-10-06T10:00:00.000Z");
  const limited = (resetAt: unknown) => new ApiClientError(429, "rate_limited", "Too many requests.", "req_1", { resetAt });

  it("turns a rate limit into a wait in minutes, rounded up", () => {
    expect(rateLimitMinutes(limited("2026-10-06T10:03:10.000Z"), now)).toBe(4);
    expect(rateLimitMinutes(limited("2026-10-06T10:00:20.000Z"), now)).toBe(1);
    expect(rateLimitMinutes(limited("2026-10-06T09:59:00.000Z"), now)).toBe(1);
  });
  it("has no number when the server gave no usable reset time", () => {
    expect(rateLimitMinutes(limited("soon"), now)).toBeNull();
    expect(rateLimitMinutes(limited(undefined), now)).toBeNull();
    expect(rateLimitMinutes(new ApiClientError(429, "rate_limited", "x", null, null), now)).toBeNull();
    expect(rateLimitMinutes(new ApiClientError(400, "invalid_request", "x", null, { resetAt: "2026-10-06T10:03:00.000Z" }), now)).toBeNull();
  });
  it("words the rate limit for a person", () => {
    expect(createErrorMessage(limited("2026-10-06T10:03:10.000Z"), now)).toBe(
      "This session has started as many deals as the demo allows for now. Try again in about 4 minutes.",
    );
    expect(createErrorMessage(limited("2026-10-06T10:00:20.000Z"), now)).toContain("in about a minute");
    expect(createErrorMessage(limited(null), now)).toContain("shortly");
  });
  it("passes every other message through unchanged", () => {
    const invalid = new ApiClientError(400, "invalid_request", "Describe what you need in at least 10 characters.", "req_2", null);
    expect(createErrorMessage(invalid, now)).toBe("Describe what you need in at least 10 characters.");
  });
});
