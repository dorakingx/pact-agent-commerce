import { describe, expect, it } from "vitest";
import { el, escapeAttr, escapeText, num } from "./svg-markup";
import { clampText, singleLine, tidyParagraphs } from "./text";

describe("singleLine / tidyParagraphs", () => {
  it("collapses whitespace and removes control characters", () => {
    expect(singleLine("  a\n\tb \u0000 c\u0007 ")).toBe("a b c");
    expect(tidyParagraphs(" one\ntwo \n\n\n  three\u0000 \n")).toBe("one two\n\nthree");
  });
});

describe("clampText", () => {
  it("leaves short text alone and cuts long text at a word boundary with an ellipsis", () => {
    expect(clampText("short", 10)).toBe("short");
    const cut = clampText("The quick brown fox jumps over the lazy dog", 20);
    expect(cut).toBe("The quick brown fox…");
    expect(cut.length).toBeLessThanOrEqual(20);
  });

  it("never exceeds the limit or splits a surrogate pair", () => {
    const emoji = "😀".repeat(10);
    for (let max = 1; max <= 20; max += 1) {
      const cut = clampText(emoji, max);
      expect(cut.length).toBeLessThanOrEqual(max);
      expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
    expect(clampText("unbroken".repeat(10), 12)).toHaveLength(12);
  });
});

describe("svg markup", () => {
  it("escapes text and attribute values", () => {
    expect(escapeText('a < b & "c" > d')).toBe('a &lt; b &amp; "c" &gt; d');
    expect(escapeAttr('a < b & "c"')).toBe("a &lt; b &amp; &quot;c&quot;");
    expect(escapeText("ok\u0000\u0008\uffff")).toBe("ok");
  });

  it("formats numbers compactly and refuses non-finite values", () => {
    expect(num(12.3456)).toBe("12.3");
    expect(num(0.126, 2)).toBe("0.13");
    expect(num(-0.01)).toBe("0");
    expect(num(5)).toBe("5");
    expect(() => num(Number.NaN)).toThrow(RangeError);
    expect(() => num(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("serialises elements, omitting empty attributes and self-closing empty elements", () => {
    expect(el("rect", { x: 1.26, fill: "#fff", stroke: null, rx: undefined, opacity: 0.456, hidden: false })).toBe(
      '<rect x="1.3" fill="#fff" opacity="0.46"/>',
    );
    expect(el("g", { id: 'a"b' }, [el("circle", { r: 2 }), "x"])).toBe('<g id="a&quot;b"><circle r="2"/>x</g>');
    expect(el("g", {}, [])).toBe("<g/>");
  });
});
