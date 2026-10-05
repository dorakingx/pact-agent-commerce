import { describe, expect, it } from "vitest";
import {
  attribute,
  decodeEntities,
  findHiddenText,
  localName,
  nonRenderedContainer,
  parseSvg,
  svgDimensionProblems,
  svgSafetyProblems,
} from "./svg-inspect";
import { svgMarkup } from "./test-support";

const CANVAS = { width: 1600, height: 900 };
const withBody = (body: string) => parseSvg(svgMarkup(CANVAS.width, CANVAS.height, body));
const hiddenIn = (body: string) => findHiddenText(withBody(body), CANVAS);
const unsafeIn = (body: string) => svgSafetyProblems(withBody(body));

describe("parseSvg", () => {
  it("reads elements, attributes, text and comments of a well-formed document", () => {
    const doc = parseSvg(
      `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><!-- note --><g id="a"><text x='1' y="2">Hi &amp; bye</text></g><rect width=5 /></svg>`,
    );
    expect(doc.problem).toBeNull();
    expect(doc.root?.name).toBe("svg");
    expect(doc.elements.map((element) => element.name)).toEqual(["svg", "g", "text", "rect"]);
    expect(doc.comments).toEqual([" note "]);
    expect(doc.declarations).toEqual(['xml version="1.0"']);
    expect(doc.hasDoctype).toBe(false);

    const text = doc.elements[2];
    expect(attribute(text, "x")).toBe("1");
    expect(attribute(text, "y")).toBe("2");
    expect(attribute(text, "missing")).toBeNull();
    expect(text.parent?.name).toBe("g");
    expect(attribute(doc.elements[3], "width")).toBe("5");
    expect(doc.texts.filter((chunk) => chunk.text.trim() !== "")).toEqual([{ owner: text, text: "Hi & bye" }]);
  });

  it("lower-cases names so hostile casing cannot hide an element or attribute", () => {
    const doc = parseSvg(`<SVG viewBox="0 0 1 1"><ScRiPt>x</ScRiPt><rect ONLOAD="x()"/></SVG>`);
    expect(doc.elements.map((element) => element.name)).toEqual(["svg", "script", "rect"]);
    expect(attribute(doc.elements[2], "onload")).toBe("x()");
    expect(attribute(doc.root!, "viewbox")).toBe("0 0 1 1");
  });

  it("treats style and script content as raw text, even when it contains markup characters", () => {
    const doc = parseSvg(`<svg viewBox="0 0 1 1"><style>a > b { fill: red } /* <g> */</style><rect/></svg>`);
    expect(doc.problem).toBeNull();
    expect(doc.elements.map((element) => element.name)).toEqual(["svg", "style", "rect"]);
    expect(doc.texts.find((chunk) => chunk.owner?.name === "style")?.text).toContain("a > b");
  });

  it("keeps CDATA as text and does not decode entities inside it", () => {
    const doc = parseSvg(`<svg viewBox="0 0 1 1"><text><![CDATA[1 < 2 &amp; done]]></text></svg>`);
    expect(doc.problem).toBeNull();
    expect(doc.texts.map((chunk) => chunk.text)).toContain("1 < 2 &amp; done");
  });

  it("is not confused by '>' inside attribute values", () => {
    const doc = parseSvg(`<svg viewBox="0 0 1 1"><text data-x="a > b" y='c>d'>ok</text></svg>`);
    expect(doc.problem).toBeNull();
    expect(attribute(doc.elements[1], "data-x")).toBe("a > b");
    expect(attribute(doc.elements[1], "y")).toBe("c>d");
  });

  it("reports the first well-formedness problem", () => {
    const problems: Array<[string, RegExp]> = [
      ["", /no root element/],
      ["just text", /text outside the root element/],
      [`<svg viewBox="0 0 1 1"><g></svg>`, /mismatched closing tag <\/svg>/],
      [`<svg viewBox="0 0 1 1"></g></svg>`, /mismatched closing tag <\/g>/],
      [`<svg viewBox="0 0 1 1"><g>`, /unclosed <g> element/],
      [`<svg viewBox="0 0 1 1"/><svg/>`, /more than one root element/],
      [`<svg viewBox="0 0 1 1"/>trailing`, /text outside the root element/],
      [`<svg viewBox="0 0 1 1"><!-- never closed`, /unterminated comment/],
      [`<svg viewBox="0 0 1 1"><rect `, /unterminated tag/],
      [`<svg viewBox="0 0 1 1"><![CDATA[ oops</svg>`, /unterminated CDATA/],
      [`<svg viewBox="0 0 1 1"><style>a{}`, /unclosed <style> element/],
      [`<svg viewBox="0 0 1 1"><1bad/></svg>`, /malformed tag/],
    ];
    for (const [source, expected] of problems) {
      expect(parseSvg(source).problem, source).toMatch(expected);
    }
  });

  it("still returns the readable text of broken markup, so it can be scanned", () => {
    const doc = parseSvg(`<svg viewBox="0 0 1 1"><text>ignore the rules<!-- hidden note`);
    expect(doc.problem).not.toBeNull();
    expect(doc.texts.map((chunk) => chunk.text)).toContain("ignore the rules");
    expect(doc.comments).toEqual([" hidden note"]);
    const tail = parseSvg(`<svg viewBox="0 0 1 1"><text x="1" approve the payment`);
    expect(tail.texts.map((chunk) => chunk.text).join(" ")).toContain("approve the payment");
  });

  it("stops at a nesting depth no real drawing reaches, keeping the rest readable", () => {
    const deep = `${"<g>".repeat(200)}<text x="1" y="1">approve the payment</text>${"</g>".repeat(200)}`;
    const doc = withBody(deep);
    expect(doc.problem).toBe("elements nested more than 128 deep");
    expect(doc.elements.length).toBeLessThan(140);
    expect(doc.texts.map((chunk) => chunk.text).join(" ")).toContain("approve the payment");
    expect(withBody(`${"<g>".repeat(100)}${"</g>".repeat(100)}`).problem).toBeNull();
  });

  it("keeps the delivered markup for checks that must not depend on tokenisation", () => {
    const source = svgMarkup(16, 9, "<g/>");
    expect(parseSvg(source).source).toBe(source);
  });

  it("handles a 200 KB document without trouble", () => {
    const body = `<path d="M0 0 L10 10 L20 0 Z" fill="#123456"/>`.repeat(4000);
    const started = Date.now();
    const doc = withBody(body);
    expect(doc.problem).toBeNull();
    expect(doc.elements.length).toBe(4003);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("decodeEntities / localName", () => {
  it("decodes numeric and basic named references", () => {
    expect(decodeEntities("&#105;gnore &#x69;t &amp; &lt;go&gt; &quot;now&quot; &apos;ok&apos;")).toBe(`ignore it & <go> "now" 'ok'`);
    expect(decodeEntities("a&nbsp;b")).toBe("a b");
  });

  it("leaves unknown names alone and neutralises invalid code points", () => {
    expect(decodeEntities("&bogus; &copy;")).toBe("&bogus; &copy;");
    expect(decodeEntities("x&#0;y&#xD800;z&#1114112;")).toBe("x y z ");
  });

  it("strips namespace prefixes", () => {
    expect(localName("xlink:href")).toBe("href");
    expect(localName("svg:script")).toBe("script");
    expect(localName("rect")).toBe("rect");
  });
});

describe("svgSafetyProblems", () => {
  it("accepts a static, self-contained drawing", () => {
    const body = `<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><path id="p" d="M0 0"/></defs>` +
      `<rect fill="url(#g)" width="10" height="10"/><use href="#p"/><use xlink:href="#p"/><text x="800" y="450" font-size="48">Launch</text>` +
      `<style>.a { fill: url(#g); stroke: #000 }</style><title>Sunrise</title>`;
    expect(unsafeIn(body)).toEqual([]);
  });

  it("flags scripts, foreign content and embedded documents", () => {
    expect(unsafeIn("<script>alert(1)</script>")).toEqual(["contains a <script> element"]);
    expect(unsafeIn("<svg:script>alert(1)</svg:script>")).toEqual(["contains a <script> element"]);
    expect(unsafeIn("<foreignObject><div>hi</div></foreignObject>")).toEqual(["contains a <foreignObject> element"]);
    expect(unsafeIn(`<iframe src="#x"/>`)).toEqual(["contains a <iframe> element"]);
    expect(unsafeIn(`<embed/><object/>`)).toEqual(["contains a <embed> element", "contains a <object> element"]);
  });

  it("flags event handlers in any casing", () => {
    expect(unsafeIn(`<rect onload="x()"/>`)).toEqual(["has an onload event handler"]);
    expect(unsafeIn(`<rect OnClick="x()"/>`)).toEqual(["has an onclick event handler"]);
    expect(unsafeIn(`<rect onmouseover=x()/>`)).toEqual(["has an onmouseover event handler"]);
    // "on" alone, or a name merely starting with those letters followed by a non-letter, is not a handler.
    expect(unsafeIn(`<rect data-on="1" on-="1"/>`)).toEqual([]);
  });

  it("flags every form of external reference", () => {
    const external = ["references an external resource"];
    expect(unsafeIn(`<image href="https://evil.example/x.png"/>`)).toEqual(external);
    expect(unsafeIn(`<image xlink:href="//evil.example/x.png"/>`)).toEqual(external);
    expect(unsafeIn(`<use href="other.svg#icon"/>`)).toEqual(external);
    expect(unsafeIn(`<image href="data:image/png;base64,AAAA"/>`)).toEqual(external);
    expect(unsafeIn(`<rect fill="url(https://evil.example/p)"/>`)).toEqual(external);
    expect(unsafeIn(`<rect style="fill: url( 'http://evil.example/p' )"/>`)).toEqual(external);
    expect(unsafeIn(`<style>@import url(x.css);</style>`)).toEqual(external);
    expect(unsafeIn(`<style>.a { background: url("http://evil.example/a.png") }</style>`)).toEqual(external);
    expect(unsafeIn(`<a href="https://example.com"><text x="1" y="1">x</text></a>`)).toEqual(external);
  });

  it("flags javascript: URLs, including obfuscated ones", () => {
    expect(unsafeIn(`<a href="javascript:alert(1)"><text x="1" y="1">x</text></a>`)).toContain("contains a javascript: URL");
    expect(unsafeIn(`<a href="  JaVa\tScRiPt:alert(1)"><text x="1" y="1">x</text></a>`)).toContain("contains a javascript: URL");
    expect(unsafeIn(`<a href="java&#10;script:alert(1)"><text x="1" y="1">x</text></a>`)).toContain("contains a javascript: URL");
  });

  it("flags animations that rewrite a link target", () => {
    expect(unsafeIn(`<animate attributeName="href" to="javascript:alert(1)"/>`)).toContain("animates a link target");
    expect(unsafeIn(`<set attributeName="xlink:href" to="#x"/>`)).toEqual(["animates a link target"]);
    expect(unsafeIn(`<animate attributeName="opacity" to="1"/>`)).toEqual([]);
  });

  it("flags malformed markup, wrong roots and document type declarations", () => {
    expect(svgSafetyProblems(parseSvg(""))).toEqual(["is not well-formed (no root element)"]);
    expect(svgSafetyProblems(parseSvg("<div/>"))).toEqual(["root element is not <svg>"]);
    expect(svgSafetyProblems(parseSvg(`<html><svg viewBox="0 0 1 1"/></html>`))).toEqual(["root element is not <svg>"]);
    expect(svgSafetyProblems(parseSvg(`<!DOCTYPE svg [<!ENTITY lol "lol">]><svg viewBox="0 0 1 1"/>`))).toEqual(["contains a document type declaration"]);
    expect(svgSafetyProblems(parseSvg(`<svg viewBox="0 0 1 1"><g></svg>`))[0]).toMatch(/^is not well-formed/);
  });

  it("is not fooled by tags that different parsers tokenise differently", () => {
    // A stray quote makes a naive tokeniser swallow everything up to the next quote as one tag,
    // while an HTML parser ends the tag at the first ">" and then sees the <script>.
    expect(unsafeIn(`<g "><script>alert(1)</script><g ">`)).toContain("contains a <script> element");
    expect(unsafeIn(`<g x=[><script>alert(1)</script><g y=]>`)).toContain("contains a <script> element");
    expect(unsafeIn(`<g ="><rect onload="x()"/><g =">`)).toContain("has an onload event handler");
    expect(unsafeIn(`<g "><image href="https://evil.example/x.png"/><g ">`)).toContain("references an external resource");
    expect(unsafeIn(`<g '><a href='javascript:alert(1)'>x</a><g '>`)).toContain("contains a javascript: URL");
  });

  it("refuses active markup even where it would be inert, rather than reason about context", () => {
    expect(unsafeIn(`<!-- <script>alert(1)</script> -->`)).toEqual(["contains a <script> element"]);
    expect(unsafeIn(`<text x="1" y="1"><![CDATA[<iframe src="x">]]></text>`)).toEqual(["contains a <iframe> element", "references an external resource"]);
    expect(unsafeIn(`<desc>&lt;script&gt; is not a tag</desc>`)).toEqual([]);
  });

  it("flags CSS escape sequences, which can spell url( without containing it", () => {
    expect(unsafeIn(`<style>.a { background: u\\72l(http://evil.example/a.png) }</style>`)).toEqual(["uses CSS escape sequences"]);
    expect(unsafeIn(`<rect style="fill: \\75rl(x)"/>`)).toEqual(["uses CSS escape sequences"]);
  });

  it("does not mistake look-alike names for active content or handlers", () => {
    const body = `<g data-href="x" data-src="y" data-onload="z"><objective/><scripted/><text x="1" y="1" class="one only">On, online and offline</text></g>`;
    expect(unsafeIn(body)).toEqual([]);
    // Deliberate over-approximation: text that reads like a handler assignment is refused too.
    expect(unsafeIn(`<text x="1" y="1">We are online = better</text>`)).toEqual(["has an online event handler"]);
  });

  it("reports each kind of problem once", () => {
    const problems = unsafeIn(`<script/><script/><rect onload="a"/><circle onload="b"/><image href="http://a"/><image href="http://b"/>`);
    expect(problems).toEqual(["contains a <script> element", "has an onload event handler", "references an external resource"]);
  });
});

describe("svgDimensionProblems", () => {
  const problems = (svg: string, recorded = CANVAS) => svgDimensionProblems(parseSvg(svg), recorded, 0.01);

  it("accepts a viewBox, a pixel size, or both, when they agree with the delivery record", () => {
    expect(problems(`<svg viewBox="0 0 1600 900"/>`)).toEqual([]);
    expect(problems(`<svg width="1600" height="900"/>`)).toEqual([]);
    expect(problems(`<svg width="1600px" height="900px" viewBox="0 0 16 9"/>`)).toEqual([]);
    expect(problems(`<svg viewBox="0,0,1600,900"/>`)).toEqual([]);
    expect(problems(`<svg viewBox="-800 -450 1600 900"/>`)).toEqual([]);
  });

  it("requires the file to declare its geometry", () => {
    const missing = ["declares neither a viewBox nor a pixel width and height"];
    expect(problems(`<svg/>`)).toEqual(missing);
    expect(problems(`<svg width="100%" height="100%"/>`)).toEqual(missing);
    expect(problems(`<svg width="1600"/>`)).toEqual(missing);
    expect(problems(`<svg width="100em" height="50em"/>`)).toEqual(missing);
  });

  it("rejects a file whose real ratio differs from the recorded one", () => {
    // Recorded as 1600×900 (16:9) but the drawing is square.
    expect(problems(`<svg viewBox="0 0 1200 1200"/>`)).toEqual(["viewBox 1200×1200 does not match the delivered 1600×900"]);
    expect(problems(`<svg width="1200" height="1200"/>`)).toEqual(["declares 1200×1200 but was delivered as 1600×900"]);
    expect(problems(`<svg width="1600" height="900" viewBox="0 0 100 100"/>`)).toEqual(["viewBox 100×100 does not match the delivered 1600×900"]);
    expect(problems(`<svg width="1600" viewBox="0 0 1600 900" height="1200"/>`)).toEqual(["declares 1600×1200 but was delivered as 1600×900"]);
  });

  it("allows sub-pixel and within-tolerance differences only", () => {
    expect(problems(`<svg width="1600.4" height="899.6"/>`)).toEqual([]);
    expect(problems(`<svg width="1602" height="900"/>`)).toEqual(["declares 1602×900 but was delivered as 1600×900"]);
    expect(problems(`<svg viewBox="0 0 1600 905"/>`)).toEqual([]); // 0.55% off
    expect(problems(`<svg viewBox="0 0 1600 920"/>`)).toEqual(["viewBox 1600×920 does not match the delivered 1600×900"]); // 2.2% off
  });

  it("rejects a malformed viewBox", () => {
    expect(problems(`<svg viewBox="0 0 x 9"/>`)).toEqual(["has a malformed viewBox", "declares neither a viewBox nor a pixel width and height"]);
    expect(problems(`<svg viewBox="0 0 1600" width="1600" height="900"/>`)).toEqual(["has a malformed viewBox"]);
    expect(problems(`<svg viewBox="0 0 0 0" width="1600" height="900"/>`)).toEqual(["has a malformed viewBox"]);
  });

  it("has nothing to say about a document without a root (safety reports that)", () => {
    expect(problems("")).toEqual([]);
  });
});

describe("findHiddenText", () => {
  const reasons = (body: string) => hiddenIn(body).map((hidden) => hidden.reason);

  it("finds nothing in ordinary visible lettering", () => {
    expect(hiddenIn(`<text x="800" y="450" font-size="48" fill="#fff">Launch day</text>`)).toEqual([]);
    expect(hiddenIn(`<text x="10" y="40"><tspan fill="#fff">Launch</tspan> <tspan dy="20">day</tspan></text>`)).toEqual([]);
    expect(hiddenIn(`<g opacity="0.8" transform="translate(100 50)"><text x="10" y="40" font-size="12px">Small print</text></g>`)).toEqual([]);
    expect(hiddenIn(`<text x="1590" y="880" text-anchor="end" font-size="14pt">© Northwind</text>`)).toEqual([]);
  });

  it("does not treat accessibility text as hidden", () => {
    expect(hiddenIn(`<title>Sunrise over hills</title><desc>A calm scene in navy and amber.</desc><metadata>made with care</metadata>`)).toEqual([]);
  });

  it("allows outlined lettering: no fill but a visible stroke", () => {
    expect(hiddenIn(`<text x="10" y="40" fill="none" stroke="#fff" stroke-width="2">Outline</text>`)).toEqual([]);
    expect(reasons(`<text x="10" y="40" fill="none" stroke="none">x</text>`)).toEqual(["transparent fill"]);
    expect(reasons(`<text x="10" y="40" fill="none" stroke="#fff" stroke-opacity="0">x</text>`)).toEqual(["transparent fill"]);
  });

  it("detects zero opacity on the text or any ancestor", () => {
    expect(hiddenIn(`<text x="10" y="40" opacity="0">secret</text>`)).toEqual([{ text: "secret", reason: "opacity 0" }]);
    expect(reasons(`<g opacity="0"><g><text x="10" y="40">x</text></g></g>`)).toEqual(["opacity 0"]);
    expect(reasons(`<text x="10" y="40" opacity="0.01">x</text>`)).toEqual(["opacity 0"]);
    expect(reasons(`<text x="10" y="40" style="opacity: 0%">x</text>`)).toEqual(["opacity 0"]);
    expect(reasons(`<text x="10" y="40" opacity="0.5">x</text>`)).toEqual([]);
  });

  it("detects transparent fills in every spelling", () => {
    for (const fill of [`fill-opacity="0"`, `fill="none"`, `fill="transparent"`, `fill="rgba(0, 0, 0, 0)"`, `fill="#ffffff00"`, `fill="#fff0"`, `style="fill:none"`, `fill="hsla(0 0% 0% / 0)"`]) {
      expect(reasons(`<text x="10" y="40" ${fill}>x</text>`), fill).toEqual(["transparent fill"]);
    }
    expect(reasons(`<g fill="none"><text x="10" y="40">inherited</text></g>`)).toEqual(["transparent fill"]);
    expect(reasons(`<g fill="none"><text x="10" y="40" fill="#fff">overridden</text></g>`)).toEqual([]);
    expect(reasons(`<text x="10" y="40" fill="#ffffff80">half</text>`)).toEqual([]);
  });

  it("detects display:none and visibility:hidden, however they are set", () => {
    expect(reasons(`<text x="10" y="40" display="none">x</text>`)).toEqual(["display:none"]);
    expect(reasons(`<g style="display: none"><text x="10" y="40">x</text></g>`)).toEqual(["display:none"]);
    expect(reasons(`<text x="10" y="40" visibility="hidden">x</text>`)).toEqual(["visibility:hidden"]);
    expect(reasons(`<g visibility="hidden"><text x="10" y="40">x</text></g>`)).toEqual(["visibility:hidden"]);
    expect(reasons(`<g visibility="hidden"><text x="10" y="40" visibility="visible">x</text></g>`)).toEqual([]);
    expect(reasons(`<style>.h { display: none !important }</style><text class="a h" x="10" y="40">x</text>`)).toEqual(["display:none"]);
    expect(reasons(`<style>text { visibility: hidden }</style><text x="10" y="40">x</text>`)).toEqual(["visibility:hidden"]);
    expect(reasons(`<style>#t { opacity: 0 }</style><text id="t" x="10" y="40">x</text>`)).toEqual(["opacity 0"]);
  });

  it("lets an inline style override a stylesheet rule, as a browser would", () => {
    expect(reasons(`<style>.h { display: none }</style><text class="h" style="display:inline" x="10" y="40">x</text>`)).toEqual([]);
  });

  it("applies the last matching stylesheet rule, whichever kind of selector it uses", () => {
    const text = `<text id="t" class="a b" x="10" y="40">x</text>`;
    // A later rule wins over an earlier one, across tag, class, id and compound selectors.
    expect(reasons(`<style>.a { display: none } text { display: inline }</style>${text}`)).toEqual([]);
    expect(reasons(`<style>text { display: inline } .b { display: none }</style>${text}`)).toEqual(["display:none"]);
    expect(reasons(`<style>#t { display: none } * { display: inline }</style>${text}`)).toEqual([]);
    expect(reasons(`<style>* { display: inline } text.a#t { display: none }</style>${text}`)).toEqual(["display:none"]);
    expect(reasons(`<style>.a { display: none } .a { display: inline }</style>${text}`)).toEqual([]);
    // Each property cascades on its own: a later rule that does not set it changes nothing.
    expect(reasons(`<style>.a { visibility: hidden } .b { fill: #000 }</style>${text}`)).toEqual(["visibility:hidden"]);
    // One declaration block shared by a selector list applies to every selector in it.
    expect(reasons(`<style>circle, .b, rect { opacity: 0 }</style>${text}`)).toEqual(["opacity 0"]);
  });

  it("matches a compound selector only when every part matches", () => {
    const hide = (selector: string): string[] => reasons(`<style>${selector} { display: none }</style><text id="t" class="a b" x="10" y="40">x</text>`);
    expect(hide("text.a")).toEqual(["display:none"]);
    expect(hide("text#t")).toEqual(["display:none"]);
    expect(hide(".b#t")).toEqual(["display:none"]);
    expect(hide("circle.a")).toEqual([]);
    expect(hide("text.c")).toEqual([]);
    expect(hide("text.a#other")).toEqual([]);
    // An id or class containing separators cannot be made to look like another selector.
    expect(reasons(`<style>text.a#t { display: none }</style><text id="a t" x="10" y="40">x</text>`)).toEqual([]);
    expect(reasons(`<style>.a#t { display: none }</style><text id=" a t" class="" x="10" y="40">x</text>`)).toEqual([]);
  });

  it("detects unreadably small text relative to the rendered size", () => {
    expect(reasons(`<text x="10" y="40" font-size="1">x</text>`)).toEqual(["unreadably small font"]);
    expect(reasons(`<text x="10" y="40" font-size="0.5px">x</text>`)).toEqual(["unreadably small font"]);
    expect(reasons(`<g font-size="1"><text x="10" y="40">x</text></g>`)).toEqual(["unreadably small font"]);
    expect(reasons(`<text x="10" y="40" font-size="2">x</text>`)).toEqual([]);
    // In a 16×9 user-unit drawing rendered at 1600 px, a font-size of 1 is 100 px tall.
    const small = parseSvg(`<svg viewBox="0 0 16 9"><text x="1" y="5" font-size="1">Big</text><text x="1" y="8" font-size="0.01">tiny</text></svg>`);
    expect(findHiddenText(small, CANVAS)).toEqual([{ text: "tiny", reason: "unreadably small font" }]);
  });

  it("detects text parked far outside the canvas", () => {
    expect(reasons(`<text x="-9000" y="40">x</text>`)).toEqual(["positioned outside the canvas"]);
    expect(reasons(`<text x="10" y="5000">x</text>`)).toEqual(["positioned outside the canvas"]);
    expect(reasons(`<text x="1800" y="40">x</text>`)).toEqual(["positioned outside the canvas"]);
    expect(reasons(`<g transform="translate(5000 0)"><text x="10" y="40">x</text></g>`)).toEqual(["positioned outside the canvas"]);
    expect(reasons(`<text y="40"><tspan x="99999">x</tspan></text>`)).toEqual(["positioned outside the canvas"]);
    expect(reasons(`<g transform="translate(-100, 20)"><text x="150" y="40">fine</text></g>`)).toEqual([]);
    // Relative to the viewBox origin, not to zero.
    const shifted = parseSvg(`<svg viewBox="5000 5000 1600 900"><text x="5100" y="5100">in view</text><text x="10" y="40">far away</text></svg>`);
    expect(findHiddenText(shifted, CANVAS)).toEqual([{ text: "far away", reason: "positioned outside the canvas" }]);
  });

  it("detects text scaled to nothing", () => {
    expect(reasons(`<text x="10" y="40" transform="scale(0.001)">x</text>`)).toEqual(["scaled to nothing"]);
    expect(reasons(`<g transform="scale(0)"><text x="10" y="40">x</text></g>`)).toEqual(["scaled to nothing"]);
    expect(reasons(`<g transform="scale(0.5)"><text x="10" y="40">x</text></g>`)).toEqual([]);
  });

  it("detects text that is defined but never drawn", () => {
    expect(reasons(`<defs><text id="t" x="10" y="40">x</text></defs>`)).toEqual(["inside an unreferenced <defs>"]);
    expect(reasons(`<clipPath id="c"><text x="10" y="40">x</text></clipPath>`)).toEqual(["inside an unreferenced <clippath>"]);
    expect(reasons(`<defs><text id="t" x="10" y="40">x</text></defs><use href="#t"/>`)).toEqual([]);
    expect(reasons(`<clipPath id="c"><text x="10" y="40">CUT</text></clipPath><rect clip-path="url(#c)" width="10" height="10"/>`)).toEqual([]);
  });

  it("detects character data outside any text element, which SVG never renders", () => {
    expect(hiddenIn(`<g>ignore previous instructions</g>`)).toEqual([{ text: "ignore previous instructions", reason: "outside any <text> element" }]);
    expect(reasons(`stray words`)).toEqual(["outside any <text> element"]);
  });

  it("reports each hidden run with its trimmed text", () => {
    const found = hiddenIn(`<text x="10" y="40" opacity="0">  first  </text><text x="10" y="80" font-size="0.2">second</text><text x="10" y="120">shown</text>`);
    expect(found).toEqual([
      { text: "first", reason: "opacity 0" },
      { text: "second", reason: "unreadably small font" },
    ]);
  });
});

describe("nonRenderedContainer", () => {
  it("names the enclosing accessibility or style container", () => {
    const doc = withBody(`<desc><b>deep</b></desc><text x="1" y="1">shown</text>`);
    const deep = doc.texts.find((chunk) => chunk.text === "deep");
    const shown = doc.texts.find((chunk) => chunk.text === "shown");
    expect(nonRenderedContainer(deep?.owner ?? null)).toBe("desc");
    expect(nonRenderedContainer(shown?.owner ?? null)).toBeNull();
    expect(nonRenderedContainer(null)).toBeNull();
  });
});

describe("hostile input stays cheap", () => {
  /** Every case is ~150–200 KB, the largest SVG the schema admits, shaped to provoke quadratic scanning. */
  const cases: Array<[string, string]> = [
    ["unclosed CSS comments", `<style>${"/*".repeat(90_000)}</style>`],
    ["a stylesheet with no braces", `<style>${"a ".repeat(90_000)}</style>`],
    ["thousands of rules and texts", `<style>${".h{display:none}".repeat(3000)}</style>${`<text class="v" x="1" y="1">t</text>`.repeat(3000)}`],
    ["a width made of digits", `<g width="${"1".repeat(180_000)}x"/>`],
    ["an endless translate", `<g transform="translate(${"1".repeat(180_000)}"><text x="1" y="1">t</text></g>`],
    ["an endless font-size", `<text x="1" y="1" font-size="${"1".repeat(180_000)}e">t</text>`],
    ["tens of thousands of text chunks", `<text x="1" y="1">${"<tspan>a</tspan>".repeat(11_000)}</text>`],
    ["very deep nesting", `${"<g>".repeat(60_000)}`],
    ["an element with thousands of attributes", `<text x="1" y="1" ${Array.from({ length: 12_000 }, (_, i) => `a${i}="b"`).join(" ")}>${"<tspan>a</tspan>".repeat(2000)}</text>`],
    ["thousands of unterminated tags", "<g ".repeat(60_000)],
    ["a long run of whitespace after a handler-like name", `<g onabc${" ".repeat(180_000)}>`],
    ["many style elements", "<style>a{}</style>".repeat(10_000)],
    [
      "thousands of class rules against elements carrying thousands of classes",
      `<style>${Array.from({ length: 2500 }, (_, i) => `.c${i}{opacity:1}`).join("")}</style>${`<text x="1" y="1" class="${Array.from({ length: 800 }, (_, i) => `k${i}`).join(" ")}">t</text>`.repeat(30)}`,
    ],
    [
      "thousands of compound rules that match on id but not on tag",
      `<style>${"circle#t{display:none}".repeat(3000)}</style>${`<text id="t" x="1" y="1">t</text>`.repeat(3000)}`,
    ],
  ];

  for (const [label, body] of cases) {
    it(`stays fast for ${label}`, () => {
      const started = performance.now();
      const doc = withBody(body);
      svgSafetyProblems(doc);
      svgDimensionProblems(doc, CANVAS, 0.01);
      findHiddenText(doc, CANVAS);
      expect(performance.now() - started).toBeLessThan(1500);
    });
  }

  it("treats an oversized root size as undeclared rather than parsing it", () => {
    const doc = parseSvg(`<svg width="${"1".repeat(100)}" height="900"/>`);
    expect(svgDimensionProblems(doc, CANVAS, 0.01)).toEqual(["declares neither a viewBox nor a pixel width and height"]);
  });
});
