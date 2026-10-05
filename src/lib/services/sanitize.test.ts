import { describe, expect, it } from "vitest";
import { ApiError } from "./errors";
import { INTENT_MAX_CHARS, INTENT_MIN_CHARS, REASON_MAX_CHARS, cleanText, sanitizeIntent, sanitizeReason } from "./sanitize";

/** Invisible characters are built from code points so no editor or tool can silently alter them. */
const cp = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);

const ZERO_WIDTH = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff];
const BIDI = [0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x061c];
const CONTROLS = [0x00, 0x07, 0x08, 0x1b, 0x7f, 0x80, 0x9b];
const OTHER_INVISIBLE = [0x00ad, 0xe000, 0xf8ff, 0xfffe, 0xffff, 0xfdd0, 0xe0001, 0xe0041, 0xe007f, 0x10ffff];

const REQUEST = "Get three landing-page illustrations for under $50 by tomorrow at 6 PM.";

describe("cleanText", () => {
  it("collapses every kind of whitespace to single spaces and trims", () => {
    const messy = `  Get\tthree${cp(0x0a)}${cp(0x0d, 0x0a)}landing-page${cp(0x0b)}${cp(0x0c)}illustrations   for${cp(0xa0)}under${cp(0x3000)}$50  `;
    expect(cleanText(messy)).toBe("Get three landing-page illustrations for under $50");
  });

  it("treats line and paragraph separators as word boundaries", () => {
    expect(cleanText(`first${cp(0x2028)}second${cp(0x2029)}third${cp(0x85)}fourth`)).toBe("first second third fourth");
  });

  it.each([...ZERO_WIDTH, ...BIDI, ...CONTROLS, ...OTHER_INVISIBLE])("removes the invisible code point U+%s", (codePoint) => {
    expect(cleanText(`pay${cp(codePoint)}ment`)).toBe("payment");
  });

  it("removes lone surrogates but keeps well-formed pairs", () => {
    expect(cleanText(`a${String.fromCharCode(0xd800)}b${String.fromCharCode(0xdc00)}c`)).toBe("abc");
    expect(cleanText(`a ${cp(0x1f600)} b`)).toBe(`a ${cp(0x1f600)} b`);
  });

  it("normalises compatibility forms to the characters they look like", () => {
    // Full-width "ABC123", the "fi" ligature, a full-width dollar sign.
    expect(cleanText(cp(0xff21, 0xff22, 0xff23, 0xff11, 0xff12, 0xff13))).toBe("ABC123");
    expect(cleanText(`${cp(0xfb01)}ve`)).toBe("five");
    expect(cleanText(`${cp(0xff04)}${cp(0xff15)}${cp(0xff10)}`)).toBe("$50");
  });

  it("cannot be used to hide an instruction inside a visible request", () => {
    const hidden = `${REQUEST}${cp(0x202e)}${cp(0x200b)}${cp(0xe0049)}${cp(0xe0047)}${cp(0xe004e)}`;
    expect(cleanText(hidden)).toBe(REQUEST);
  });

  it("keeps ordinary text in any script, punctuation and emoji", () => {
    const text = `Logo: "Café Ñandú" — 3 Entwürfe für 45 €, ロゴを3つ ${cp(0x2764, 0xfe0f)}!`;
    expect(cleanText(text)).toBe(text.normalize("NFKC"));
  });

  it("is idempotent", () => {
    const once = cleanText(`  ${cp(0xff21)}\t${cp(0x200b)}b${cp(0x2028)}c  `);
    expect(cleanText(once)).toBe(once);
  });
});

describe("sanitizeIntent", () => {
  it("returns the cleaned request", () => {
    expect(sanitizeIntent(`\n  ${REQUEST}${cp(0x200b)}  `)).toBe(REQUEST);
  });

  it("enforces 10 to 600 characters on the cleaned text", () => {
    expect(INTENT_MIN_CHARS).toBe(10);
    expect(INTENT_MAX_CHARS).toBe(600);
    expect(sanitizeIntent("a".repeat(10))).toHaveLength(10);
    expect(sanitizeIntent("a".repeat(600))).toHaveLength(600);
    expect(() => sanitizeIntent("a".repeat(9))).toThrow(ApiError);
    expect(() => sanitizeIntent("a".repeat(601))).toThrow(ApiError);
  });

  it("measures what a person can see: padding and invisible characters do not count", () => {
    expect(() => sanitizeIntent(`logo${" ".repeat(50)}`)).toThrow(/at least 10 characters/);
    expect(() => sanitizeIntent(`logo${cp(0x200b).repeat(50)}`)).toThrow(/at least 10 characters/);
    expect(() => sanitizeIntent("")).toThrow(ApiError);
    expect(() => sanitizeIntent(cp(0x202e).repeat(40))).toThrow(ApiError);
    // 600 visible characters stay valid however much invisible padding surrounds them.
    expect(sanitizeIntent(`${cp(0xfeff).repeat(300)}${"b".repeat(600)}${"\n".repeat(300)}`)).toHaveLength(600);
  });

  it("measures after normalisation, which can lengthen the text", () => {
    // U+FDFA expands to an 18-character phrase under NFKC.
    expect(() => sanitizeIntent(cp(0xfdfa).repeat(40))).toThrow(/600 characters or fewer/);
  });

  it("reports a 400 with the API's invalid-request code", () => {
    const error = (() => {
      try {
        sanitizeIntent("short");
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: "invalid_request" });
  });
});

describe("sanitizeReason", () => {
  it("is null when absent or empty after cleaning", () => {
    expect(sanitizeReason(undefined)).toBeNull();
    expect(sanitizeReason("")).toBeNull();
    expect(sanitizeReason(` \n${cp(0x200b)}\t `)).toBeNull();
  });

  it("cleans and bounds the text", () => {
    expect(sanitizeReason(`  Looks${cp(0x202e)} right\nto me.  `)).toBe("Looks right to me.");
    const long = sanitizeReason("x".repeat(1000));
    expect(long).toHaveLength(REASON_MAX_CHARS);
    expect(long?.endsWith("…")).toBe(true);
  });
});
