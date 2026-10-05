import { describe, expect, it } from "vitest";
import { MAX_SVG_CHARS, sanitizeSvg } from "./svg-sanitize";

const NS = 'xmlns="http://www.w3.org/2000/svg"';

function clean(input: string): string {
  const result = sanitizeSvg(input);
  if (!result.ok) throw new Error(`expected the SVG to be accepted, got: ${result.reason}`);
  return result.svg;
}

function rejection(input: string): string {
  const result = sanitizeSvg(input);
  if (result.ok) throw new Error(`expected the SVG to be rejected, got: ${result.svg}`);
  return result.reason;
}

describe("sanitizeSvg — safe content is preserved", () => {
  it("keeps allowlisted elements and attributes and forces the SVG namespace", () => {
    const svg = clean(
      '<svg width="100" height="50" viewBox="0 0 100 50"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000" stop-opacity="0.5"/></linearGradient></defs>' +
        '<g transform="translate(2 3)" opacity="0.9"><rect x="1" y="2" width="10" height="10" rx="2" fill="url(#g)"/>' +
        '<circle cx="5" cy="5" r="3" stroke="#123" stroke-width="2"/><path d="M0 0L10 10Z" fill-rule="evenodd"/></g></svg>',
    );
    expect(svg.startsWith(`<svg ${NS} width="100" height="50" viewBox="0 0 100 50">`)).toBe(true);
    expect(svg).toContain('<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">');
    expect(svg).toContain('<rect x="1" y="2" width="10" height="10" rx="2" fill="url(#g)"/>');
    expect(svg).toContain('<path d="M0 0L10 10Z" fill-rule="evenodd"/>');
    expect(svg.endsWith("</g></svg>")).toBe(true);
  });

  it("is idempotent", () => {
    const once = clean('<svg><title>A &amp; B</title><text x="1" y="2" font-size="12">1 &lt; 2 "ok"</text><rect width="1" height="1"/></svg>');
    expect(clean(once)).toBe(once);
    expect(once).toContain("<title>A &amp; B</title>");
    expect(once).toContain('<text x="1" y="2" font-size="12">1 &lt; 2 "ok"</text>');
  });

  it("keeps filters, masks, patterns and clip paths that reference the same document", () => {
    const svg = clean(
      '<svg><defs><filter id="f"><feGaussianBlur stdDeviation="3"/><feDropShadow dx="1" dy="2" flood-color="#000" flood-opacity="0.2"/></filter>' +
        '<clipPath id="c"><rect width="5" height="5"/></clipPath><mask id="m"><rect width="5" height="5" fill="#fff"/></mask>' +
        '<pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1"/></pattern></defs>' +
        '<rect width="9" height="9" fill="url(#p)" filter="url(#f)" clip-path="url(#c)" mask="url(#m)"/></svg>',
    );
    expect(svg).toContain('<feGaussianBlur stdDeviation="3"/>');
    expect(svg).toContain('<feDropShadow dx="1" dy="2" flood-color="#000" flood-opacity="0.2"/>');
    expect(svg).toContain('fill="url(#p)" filter="url(#f)" clip-path="url(#c)" mask="url(#m)"');
  });

  it("keeps <use> with an internal reference and rewrites xlink:href to href", () => {
    const svg = clean('<svg><defs><circle id="dot" r="2"/></defs><use xlink:href="#dot" x="5" y="5"/><use href="#dot"/></svg>');
    expect(svg).toContain('<use href="#dot" x="5" y="5"/>');
    expect(svg).toContain('<use href="#dot"/>');
    expect(svg).not.toContain("xlink");
  });

  it("normalises mixed-case element and attribute names to their canonical spelling", () => {
    const svg = clean('<SVG VIEWBOX="0 0 4 4"><LinearGradient ID="g"><STOP Offset="0" STOP-COLOR="red"/></LinearGradient><RECT Width="4" HEIGHT="4" FILL="url(#g)"/></SVG>');
    expect(svg).toBe(
      `<svg ${NS} viewBox="0 0 4 4"><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient><rect width="4" height="4" fill="url(#g)"/></svg>`,
    );
  });

  it("accepts attributes without quotes and re-quotes them", () => {
    const svg = clean("<svg width=100 height=50><rect width=10 height=20 fill=red></rect><circle r=3 /><path d=M0,0L5,5/></svg>");
    expect(svg).toBe(
      `<svg ${NS} width="100" height="50"><rect width="10" height="20" fill="red"/><circle r="3"/><path d="M0,0L5,5"/></svg>`,
    );
  });

  it("drops text that is not inside a text container", () => {
    expect(clean("<svg>\n  stray <g> words <rect width='1' height='1'/></g>\n</svg>")).toBe(
      `<svg ${NS}><g><rect width="1" height="1"/></g></svg>`,
    );
  });
});

describe("sanitizeSvg — classic attack vectors", () => {
  it("removes <script> together with its content, even when the content is not well-formed markup", () => {
    const svg = clean('<svg><script type="text/javascript">if (a<b && c>d) { alert("</g>") }</script><rect width="1" height="1"/></svg>');
    expect(svg).toBe(`<svg ${NS}><rect width="1" height="1"/></svg>`);
  });

  it("removes mixed-case and namespaced script elements", () => {
    const svg = clean('<svg><ScRiPt>alert(1)</sCrIpT><svg:script>alert(2)</svg:script><SCRIPT href="x.js"/><rect width="1" height="1"/></svg>');
    expect(svg).toBe(`<svg ${NS}><rect width="1" height="1"/></svg>`);
  });

  it("drops every event handler attribute", () => {
    const svg = clean('<svg onload="alert(1)" ONLOAD=alert(2)><rect width="1" height="1" onclick="steal()" onmouseover=\'x()\' OnFocus="y()"/></svg>');
    expect(svg).toBe(`<svg ${NS}><rect width="1" height="1"/></svg>`);
  });

  it("removes <foreignObject> and the iframe inside it", () => {
    const svg = clean(
      '<svg><foreignObject width="100" height="100"><iframe src="javascript:alert(1)"></iframe><body xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror=alert(1)></img></body></foreignObject><rect width="1" height="1"/></svg>',
    );
    expect(svg).toBe(`<svg ${NS}><rect width="1" height="1"/></svg>`);
  });

  it("removes links and javascript: URLs wherever they appear", () => {
    const svg = clean(
      '<svg><a href="javascript:alert(1)"><rect width="9" height="9"/></a><a xlink:href="https://evil.example"><text>click</text></a>' +
        '<rect width="1" height="1" fill="javascript:alert(1)" href="javascript:alert(2)"/></svg>',
    );
    expect(svg).toBe(`<svg ${NS}><rect width="1" height="1"/></svg>`);
  });

  it("sees through entity and whitespace obfuscation of javascript:", () => {
    const svg = clean(
      '<svg><rect width="1" height="1" fill="&#106;avascript:alert(1)" stroke="java&#x09;script:alert(1)" mask="jav\nascript:x" filter=" JaVaScRiPt:alert(1)"/></svg>',
    );
    expect(svg).toBe(`<svg ${NS}><rect width="1" height="1"/></svg>`);
  });

  it("removes <image>, including remote and data: sources", () => {
    const svg = clean(
      '<svg><image href="http://evil.example/track.png" width="1" height="1"/><image xlink:href="data:image/svg+xml;base64,PHN2Zz4="/><rect width="1" height="1"/></svg>',
    );
    expect(svg).toBe(`<svg ${NS}><rect width="1" height="1"/></svg>`);
  });

  it("removes <use> that points outside the document", () => {
    const svg = clean(
      '<svg><use href="http://evil/x.svg#a"/><use xlink:href="//evil/x.svg#a"/><use href="data:image/svg+xml,&lt;svg id=a&gt;#a"/><use/><use href="#ok"/><rect id="ok" width="1" height="1"/></svg>',
    );
    expect(svg).toBe(`<svg ${NS}><use href="#ok"/><rect id="ok" width="1" height="1"/></svg>`);
  });

  it("drops style attributes and <style> elements", () => {
    const svg = clean(
      '<svg><style>@import url(http://evil.example/x.css); rect { fill: url(http://evil.example/a) }</style>' +
        '<rect width="1" height="1" style="background:url(http://evil.example/beacon)"/></svg>',
    );
    expect(svg).toBe(`<svg ${NS}><rect width="1" height="1"/></svg>`);
  });

  it("drops presentation attributes with external, data: or escaped url() references", () => {
    const svg = clean(
      '<svg><rect width="1" height="1" fill="url(http://evil.example/p.svg#g)" stroke="url( \'https://evil.example\' )" ' +
        'filter="url(data:image/svg+xml,x)" mask="u\\72l(http://evil.example)" clip-path="url(#c) url(//evil.example)"/>' +
        '<circle r="1" fill="url(#g)" stroke="URL( #h )"/></svg>',
    );
    expect(svg).toBe(`<svg ${NS}><rect width="1" height="1"/><circle r="1" fill="url(#g)" stroke="URL( #h )"/></svg>`);
  });

  it("defuses entity expansion (billion laughs): the DTD is dropped and custom entities resolve to nothing", () => {
    const bomb =
      '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">' +
      '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;"><!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
      '<svg><text x="0" y="10">a&lol3;b&xxe;c</text></svg>';
    expect(clean(bomb)).toBe(`<svg ${NS}><text x="0" y="10">abc</text></svg>`);
  });

  it("removes comments, CDATA sections and processing instructions", () => {
    const svg = clean(
      '<?xml-stylesheet href="http://evil.example/x.css"?><!-- <script>alert(1)</script> --><svg><![CDATA[<script>alert(2)</script>]]>' +
        '<text>ok<!-- hidden --></text><?php echo 1 ?></svg>',
    );
    expect(svg).toBe(`<svg ${NS}><text>ok</text></svg>`);
  });

  it("removes animation elements that could rewrite attributes after sanitisation", () => {
    const svg = clean(
      '<svg><rect width="1" height="1"><animate attributeName="href" values="javascript:alert(1)"/><set attributeName="onclick" to="x()"/>' +
        '<animateTransform attributeName="transform" type="rotate"/><animateMotion path="M0 0"/></rect></svg>',
    );
    expect(svg).toBe(`<svg ${NS}><rect width="1" height="1"/></svg>`);
  });

  it("removes embedding elements", () => {
    const svg = clean(
      '<svg><iframe src="https://evil.example"></iframe><object data="x.swf"></object><embed src="x.swf"/><video src="x.mp4"></video><rect width="1" height="1"/></svg>',
    );
    expect(svg).toBe(`<svg ${NS}><rect width="1" height="1"/></svg>`);
  });

  it("unwraps unknown harmless wrappers and nested <svg>, keeping their children", () => {
    const svg = clean(
      '<svg><switch><g><rect width="1" height="1"/></g></switch><svg x="5" y="5" onload="x()"><circle r="2"/></svg><marker><path d="M0 0"/></marker></svg>',
    );
    expect(svg).toBe(`<svg ${NS}><g><rect width="1" height="1"/></g><circle r="2"/><path d="M0 0"/></svg>`);
  });

  it("escapes markup smuggled through entities instead of reviving it", () => {
    const svg = clean('<svg><text>&lt;script&gt;alert(1)&lt;/script&gt;</text><title>&#60;img src=x onerror=alert(1)&#62;</title><rect id="&quot;&gt;&lt;script&gt;" width="1" height="1"/></svg>');
    expect(svg).toBe(
      `<svg ${NS}><text>&lt;script&gt;alert(1)&lt;/script&gt;</text><title>&lt;img src=x onerror=alert(1)&gt;</title><rect id="&quot;&gt;&lt;script&gt;" width="1" height="1"/></svg>`,
    );
    expect(clean(svg)).toBe(svg);
  });

  it("resolves only XML's own entities, never inherited object properties", () => {
    const svg = clean("<svg><text>a&constructor;b&__proto__;c&toString;d&nbsp;e&amp;f & g &; &#; &#xZZ;</text></svg>");
    expect(svg).toBe(`<svg ${NS}><text>abcde&amp;f &amp; g &amp;; &amp;#; &amp;#xZZ;</text></svg>`);
  });

  it("strips characters that are illegal in XML", () => {
    const svg = clean('<svg><text>a\u0000b\u0008c&#0;d&#x1F;e\ufffef</text></svg>');
    expect(svg).toBe(`<svg ${NS}><text>abcdef</text></svg>`);
  });

  it("breaks <use> chains and cycles, which could ask a renderer for billions of shapes", () => {
    const bomb =
      '<svg><defs><rect id="a0" width="1" height="1"/>' +
      '<g id="a1"><use href="#a0"/><use href="#a0"/></g>' +
      '<g id="a2"><use href="#a1"/><use href="#a1"/></g>' +
      '<g id="a3"><use href="#a2"/><use href="#a2"/></g>' +
      '<use id="alias" href="#a0"/></defs>' +
      '<use href="#a3"/><use href="#a1"/><use href="#alias"/><use href="#a0"/><g id="loop"><use href="#loop"/></g><use href="#nowhere"/></svg>';
    expect(clean(bomb)).toBe(
      `<svg ${NS}><defs><rect id="a0" width="1" height="1"/><g id="a1"><use href="#a0"/><use href="#a0"/></g>` +
        '<g id="a2"/><g id="a3"/><use id="alias" href="#a0"/></defs>' +
        '<use href="#a0"/><g id="loop"/><use href="#nowhere"/></svg>',
    );
  });

  it("stays linear on pathological input", () => {
    const started = Date.now();
    const ampersands = `<svg><text>${"&".repeat(150_000)}</text></svg>`;
    expect(sanitizeSvg(ampersands).ok).toBe(false); // every "&" grows to "&amp;": over the size limit
    const brackets = `<svg><text>${"a&lt;".repeat(30_000)}</text><rect width="1" height="1" fill="${"&#x26;".repeat(3_000)}"/></svg>`;
    expect(sanitizeSvg(brackets).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("drops duplicate attributes, namespace declarations and data attributes", () => {
    const svg = clean(
      '<svg xmlns="http://evil.example/ns" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:ev="http://www.w3.org/2001/xml-events" data-x="1">' +
        '<rect width="1" width="999" height="1" ev:event="load" xml:base="http://evil.example/"/></svg>',
    );
    expect(svg).toBe(`<svg ${NS}><rect width="1" height="1"/></svg>`);
  });
});

describe("sanitizeSvg — rejection", () => {
  it("rejects empty input", () => {
    expect(rejection("")).toMatch(/empty/);
    expect(rejection("  \n\t ")).toMatch(/empty/);
  });

  it("rejects documents with nothing left to draw", () => {
    expect(rejection("<svg></svg>")).toMatch(/nothing drawable/);
    expect(rejection("<svg><script>alert(1)</script></svg>")).toMatch(/nothing drawable/);
    expect(rejection('<svg><defs><linearGradient id="g"/></defs><title>t</title></svg>')).toMatch(/nothing drawable/);
  });

  it("rejects unclosed and mismatched tags", () => {
    expect(rejection('<svg><g><rect width="1" height="1"/></svg>')).toMatch(/malformed/);
    expect(rejection('<svg><rect width="1" height="1"/>')).toMatch(/unclosed <svg>/);
    expect(rejection('<svg><rect width="1" height="1"></svg>')).toMatch(/malformed/);
    expect(rejection('<svg><rect width="1" height="1"/></svg></g>')).toMatch(/unexpected closing tag/);
    expect(rejection('<svg><rect width="1" height="1"')).toMatch(/unterminated/);
    expect(rejection('<svg><rect width="1 height="1"/></svg>')).toMatch(/malformed/);
    expect(rejection("<svg><script>alert(1)<rect/></svg>")).toMatch(/unterminated <script>/);
    expect(rejection("<svg><!-- never closed <rect/></svg>")).toMatch(/unterminated comment/);
    expect(rejection('<svg>< rect width="1"/></svg>')).toMatch(/malformed/);
  });

  it("rejects documents whose root is not a single <svg>", () => {
    expect(rejection('<g><rect width="1" height="1"/></g>')).toMatch(/root element must be <svg>/);
    expect(rejection('<html><svg><rect width="1" height="1"/></svg></html>')).toMatch(/root element must be <svg>/);
    expect(rejection('<svg><rect width="1" height="1"/></svg><svg><rect width="1" height="1"/></svg>')).toMatch(/more than one root/);
    expect(rejection('hello <svg><rect width="1" height="1"/></svg>')).toMatch(/text outside/);
    expect(rejection("just text")).toMatch(/malformed/);
  });

  it("rejects oversized input and absurd nesting", () => {
    const big = `<svg><path d="${"M0 0".repeat(MAX_SVG_CHARS / 4)}"/></svg>`;
    expect(rejection(big)).toMatch(/larger than 200000/);
    const deep = `<svg>${"<g>".repeat(80)}<rect width="1" height="1"/>${"</g>".repeat(80)}</svg>`;
    expect(rejection(deep)).toMatch(/nested deeper/);
  });

  it("accepts input right at the size limit", () => {
    const prefix = `<svg ${NS}><path d="`;
    const suffix = '"/></svg>';
    const svg = prefix + "M".repeat(MAX_SVG_CHARS - prefix.length - suffix.length) + suffix;
    expect(svg.length).toBe(MAX_SVG_CHARS);
    expect(clean(svg)).toBe(svg);
  });
});
