import { describe, expect, it } from "vitest";
import { countWords, detectLanguage } from "./text-metrics";
import { englishText } from "./test-support";

const SAMPLES = {
  en: "The new espresso machine brings café quality coffee to your kitchen with precise temperature control and a quiet pump.",
  es: "La nueva máquina de espresso lleva el café de calidad a tu cocina con un control preciso de la temperatura y una bomba silenciosa.",
  fr: "La nouvelle machine à espresso apporte un café de qualité dans votre cuisine avec un contrôle précis de la température et une pompe silencieuse.",
  de: "Die neue Espressomaschine bringt Kaffee in Café-Qualität in Ihre Küche, mit präziser Temperaturregelung und einer leisen Pumpe für jeden Morgen.",
  ja: "新しいエスプレッソマシンは、毎朝のコーヒーを特別な一杯に変えます。精密な温度管理と静かなポンプで、カフェの味をご自宅で楽しめます。",
} as const;

describe("countWords", () => {
  it("counts space-separated words and ignores punctuation", () => {
    expect(countWords("one two  three\nfour")).toBe(4);
    expect(countWords("Hello, world! It's 9 o'clock — café-quality.")).toBe(7);
    expect(countWords(SAMPLES.en)).toBe(19);
  });

  it("returns zero for empty or punctuation-only text", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n\t ")).toBe(0);
    expect(countWords("… — !!! ???")).toBe(0);
  });

  it("matches the generator used by the test fixtures", () => {
    for (const words of [1, 79, 80, 120, 121, 500]) {
      expect(countWords(englishText(words))).toBe(words);
    }
  });

  it("segments Japanese into words instead of counting one unbroken run", () => {
    const words = countWords(SAMPLES.ja, "ja");
    expect(words).toBeGreaterThan(20);
    expect(words).toBeLessThan(SAMPLES.ja.length);
    // The locale hint does not change dictionary segmentation of Japanese text.
    expect(countWords(SAMPLES.ja)).toBe(words);
    expect(countWords("東京")).toBe(1);
  });

  it("grows linearly with repeated content", () => {
    const once = countWords(SAMPLES.ja, "ja");
    expect(countWords(SAMPLES.ja.repeat(3), "ja")).toBe(once * 3);
  });

  it("tolerates an invalid locale tag from an untrusted label", () => {
    expect(countWords("three small words", "j@")).toBe(3);
    expect(countWords("three small words", "")).toBe(3);
    expect(countWords("three small words", "not a locale at all")).toBe(3);
  });
});

describe("detectLanguage", () => {
  it("identifies each supported language from ordinary product copy", () => {
    for (const [language, text] of Object.entries(SAMPLES)) {
      const detected = detectLanguage(text);
      expect(detected.language, text).toBe(language);
      expect(detected.confidence, language).toBeGreaterThanOrEqual(0.7);
      expect(detected.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("recognises Japanese that mixes in Latin brand names", () => {
    const detected = detectLanguage("新しい Espresso Pro X200 は、朝のコーヒーを変えます。");
    expect(detected.language).toBe("ja");
    expect(detected.confidence).toBeGreaterThan(0.6);
  });

  it("is less sure about kanji without any kana", () => {
    const kanjiOnly = detectLanguage("新型珈琲機");
    expect(kanjiOnly.language).toBe("ja");
    expect(kanjiOnly.confidence).toBeLessThanOrEqual(0.5);
    expect(detectLanguage(SAMPLES.ja).confidence).toBeGreaterThan(kanjiOnly.confidence);
  });

  it("is not fooled by a label: English text is English whatever the seller calls it", () => {
    // A seller delivering the English text twice and labelling one copy "ja".
    expect(detectLanguage(SAMPLES.en).language).toBe("en");
    expect(detectLanguage(englishText(100)).language).toBe("en");
  });

  it("is not thrown by a long quoted subject in another language when told what the text quotes", () => {
    const subject = "The Complete Guide to Cold Brew Coffee Subscriptions for Small Offices and Remote Teams";
    const tagline = `「${subject}」：毎朝を、もっと豊かに。丁寧に選んだ豆をお届けします。`;
    // Mostly Latin letters by count, so the bare reading is confidently wrong…
    expect(detectLanguage(tagline)).toMatchObject({ language: "en" });
    // …but what is left once the quoted subject is set aside is Japanese.
    expect(detectLanguage(tagline, { ignore: [subject] })).toMatchObject({ language: "ja" });
    expect(detectLanguage(tagline, { ignore: [subject] }).confidence).toBeGreaterThanOrEqual(0.9);
    // A subject cut short where it is quoted is still recognised by its beginning.
    const clipped = `「${subject.slice(0, 48)}…」：毎朝を、もっと豊かに。丁寧に選んだ豆をお届けします。`;
    expect(detectLanguage(clipped, { ignore: [subject] })).toMatchObject({ language: "ja" });
  });

  it("does not let the ignore list turn English into something else", () => {
    const text = "The new espresso machine is ready for your kitchen, and it is quiet.";
    expect(detectLanguage(text, { ignore: ["espresso machine", "a subject that never appears in it"] })).toMatchObject({ language: "en" });
  });

  it("answers unknown, with zero confidence, when there is nothing to go on", () => {
    for (const text of ["", "   ", "12345 67890", "!!! ???", "Espresso Pro", "X200"]) {
      expect(detectLanguage(text), JSON.stringify(text)).toEqual({ language: "unknown", confidence: 0 });
    }
  });

  it("does not guess when two languages are equally likely", () => {
    // One distinctive English word and one distinctive German word.
    expect(detectLanguage("the und")).toEqual({ language: "unknown", confidence: 0 });
  });

  it("has low confidence for very thin evidence", () => {
    const thin = detectLanguage("Espresso Pro X200 Barista Edition Chrome Steel Deluxe and Grinder Bundle Premium Kit");
    expect(thin.language).toBe("en");
    expect(thin.confidence).toBeLessThan(0.7);
  });

  it("is deterministic and case-insensitive", () => {
    expect(detectLanguage(SAMPLES.fr)).toEqual(detectLanguage(SAMPLES.fr));
    expect(detectLanguage(SAMPLES.de.toUpperCase()).language).toBe("de");
  });
});
