/**
 * Strict allowlist SVG sanitizer.
 *
 * A delivered illustration is untrusted input from another party's agent, and PACT shows it in
 * the buyer's browser. This module never tries to "strip the bad parts" of the original string:
 * it tokenizes the markup, keeps only elements and attributes it positively recognises, and
 * re-serialises a fresh document with its own escaping. Whatever the input contained, the
 * output can only be made of allowlisted static drawing primitives.
 *
 * There is deliberately no DOM dependency: this runs on the server before anything is stored.
 */
import { escapeAttr, escapeText, stripInvalidXmlChars } from "./svg-markup";

/** Same limit as IllustrationArtifactSchema.svg in the domain schema. */
export const MAX_SVG_CHARS = 200_000;

/** Real illustrations nest a handful of groups; anything deeper is hostile or broken. */
const MAX_DEPTH = 64;

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export type SanitizeResult = { ok: true; svg: string } | { ok: false; reason: string };

/** Lower-cased name -> canonical spelling. SVG is case-sensitive, hostile markup often is not. */
function canonicalMap(names: readonly string[]): ReadonlyMap<string, string> {
  return new Map(names.map((name) => [name.toLowerCase(), name]));
}

const ALLOWED_ELEMENTS = canonicalMap([
  "svg",
  "g",
  "defs",
  "title",
  "desc",
  "linearGradient",
  "radialGradient",
  "stop",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "path",
  "text",
  "tspan",
  "clipPath",
  "mask",
  "pattern",
  "use",
  "filter",
  "feGaussianBlur",
  "feOffset",
  "feBlend",
  "feColorMatrix",
  "feComposite",
  "feMerge",
  "feMergeNode",
  "feFlood",
  "feDropShadow",
]);

/**
 * Elements that are dropped together with everything inside them: they execute, embed foreign
 * documents, load remote resources, navigate, or animate attributes after sanitisation.
 * (Lower-cased local names; every animate* element is matched by prefix as well.)
 */
const DROPPED_WITH_CONTENT: ReadonlySet<string> = new Set([
  "script",
  "style",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "image",
  "a",
  "set",
  "audio",
  "video",
  "canvas",
  "feimage",
  "handler",
  "listener",
  "link",
  "meta",
]);

/** Their content is not markup in HTML parsers, so it must be skipped as raw text. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["script", "style"]);

/** The only elements whose character data is meaningful. Stray text elsewhere is discarded. */
const TEXT_CONTAINERS: ReadonlySet<string> = new Set(["text", "tspan", "title", "desc"]);

/** Elements that put pixels on the canvas; a document without any is rejected as empty. */
const DRAWABLE_ELEMENTS: ReadonlySet<string> = new Set([
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "path",
  "text",
  "use",
]);

/**
 * Presentation and geometry attributes only. Event handlers (on*), `style`, namespace
 * declarations and data-* never match because nothing outside this list is kept.
 */
const ALLOWED_ATTRIBUTES = canonicalMap([
  "id",
  "class",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "width",
  "height",
  "d",
  "points",
  "viewBox",
  "version",
  "transform",
  "fill",
  "fill-opacity",
  "fill-rule",
  "clip-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "opacity",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "clip-path",
  "clipPathUnits",
  "mask",
  "maskUnits",
  "filter",
  "filterUnits",
  "color-interpolation-filters",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "letter-spacing",
  "preserveAspectRatio",
  "patternUnits",
  "patternTransform",
  "stdDeviation",
  "dx",
  "dy",
  "in",
  "in2",
  "result",
  "mode",
  "operator",
  "values",
  "type",
  "flood-color",
  "flood-opacity",
  "href",
  "role",
  "aria-label",
  "aria-hidden",
]);

/**
 * XML's five predefined entities. Every other named entity is a custom (DTD) one and is dropped.
 * A Map, not an object literal: "&constructor;" must not resolve to something inherited.
 */
const PREDEFINED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

/** Longest character or entity reference body we recognise ("&" and ";" excluded). */
const MAX_ENTITY_CHARS = 33;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const ENTITY_BODY_PATTERN = /^(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z_:][A-Za-z0-9_.:-]{0,31})$/;
const FRAGMENT_PATTERN = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/;
/** A paint-server / clip / mask / filter reference to an element of the same document. */
const INTERNAL_URL_PATTERN = /url\((["']?)#[a-z_][a-z0-9_.:-]*\1\)/g;
const FORBIDDEN_SCHEMES = ["javascript:", "vbscript:", "data:"] as const;

/** Thrown by the tokenizer / tree builder; converted to `{ ok: false }` at the boundary. */
class MalformedSvgError extends Error {}

interface RawAttribute {
  name: string;
  value: string;
}

type Token =
  | { kind: "text"; value: string }
  | { kind: "open"; name: string; attributes: RawAttribute[]; selfClosing: boolean }
  | { kind: "close"; name: string };

interface ElementNode {
  name: string;
  attributes: [name: string, value: string][];
  children: (ElementNode | string)[];
}

/* -------------------------------------------------------------------------- */
/*  Tokenizer                                                                  */
/* -------------------------------------------------------------------------- */

function isWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === "\f";
}

function localName(name: string): string {
  const colon = name.lastIndexOf(":");
  return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class Tokenizer {
  private pos = 0;

  constructor(private readonly input: string) {}

  /** Returns the next token, or null at the end of the input. Markup that carries no content is skipped. */
  next(): Token | null {
    while (this.pos < this.input.length) {
      if (this.input[this.pos] !== "<") return this.readText();
      if (this.input.startsWith("<!--", this.pos)) {
        this.skipPast("-->", 4, "unterminated comment");
      } else if (this.input.startsWith("<![CDATA[", this.pos)) {
        this.skipPast("]]>", 9, "unterminated CDATA section");
      } else if (this.input.startsWith("<?", this.pos)) {
        this.skipPast("?>", 2, "unterminated processing instruction");
      } else if (this.input.startsWith("<!", this.pos)) {
        this.skipDeclaration();
      } else if (this.input.startsWith("</", this.pos)) {
        return this.readCloseTag();
      } else {
        return this.readOpenTag();
      }
    }
    return null;
  }

  private readText(): Token {
    const end = this.input.indexOf("<", this.pos);
    const stop = end === -1 ? this.input.length : end;
    const value = this.input.slice(this.pos, stop);
    this.pos = stop;
    return { kind: "text", value };
  }

  private skipPast(terminator: string, prefixLength: number, problem: string): void {
    const end = this.input.indexOf(terminator, this.pos + prefixLength);
    if (end === -1) throw new MalformedSvgError(problem);
    this.pos = end + terminator.length;
  }

  /**
   * <!DOCTYPE ...> including an internal subset: `[ <!ENTITY a "..."> ... ]`. The whole
   * declaration is discarded, which is what defuses entity-expansion ("billion laughs") input:
   * no entity is ever defined, so none can expand.
   */
  private skipDeclaration(): void {
    let depth = 0;
    let quote: string | null = null;
    for (let i = this.pos + 2; i < this.input.length; i += 1) {
      const ch = this.input[i];
      if (quote !== null) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "[") {
        depth += 1;
      } else if (ch === "]") {
        depth = Math.max(0, depth - 1);
      } else if (ch === ">" && depth === 0) {
        this.pos = i + 1;
        return;
      }
    }
    throw new MalformedSvgError("unterminated declaration");
  }

  private readCloseTag(): Token {
    const start = this.pos + 2;
    let i = start;
    while (i < this.input.length && !isWhitespace(this.input[i]) && this.input[i] !== ">") i += 1;
    const name = this.input.slice(start, i);
    while (isWhitespace(this.input[i])) i += 1;
    if (this.input[i] !== ">" || !NAME_PATTERN.test(name)) {
      throw new MalformedSvgError("malformed closing tag");
    }
    this.pos = i + 1;
    return { kind: "close", name };
  }

  private readOpenTag(): Token {
    let i = this.pos + 1;
    const nameStart = i;
    while (i < this.input.length && !isWhitespace(this.input[i]) && this.input[i] !== ">" && this.input[i] !== "/") {
      i += 1;
    }
    const name = this.input.slice(nameStart, i);
    if (!NAME_PATTERN.test(name)) throw new MalformedSvgError("stray '<' or invalid tag name");

    const attributes: RawAttribute[] = [];
    for (;;) {
      while (isWhitespace(this.input[i])) i += 1;
      const ch = this.input[i];
      if (ch === undefined) throw new MalformedSvgError(`unterminated <${name}> tag`);
      if (ch === ">") {
        this.pos = i + 1;
        return this.finishOpenTag(name, attributes, false);
      }
      if (ch === "/") {
        if (this.input[i + 1] !== ">") throw new MalformedSvgError(`unexpected '/' in <${name}> tag`);
        this.pos = i + 2;
        return this.finishOpenTag(name, attributes, true);
      }
      i = this.readAttribute(i, name, attributes);
    }
  }

  /** Parses one attribute starting at `i` and returns the index just after it. */
  private readAttribute(start: number, tagName: string, into: RawAttribute[]): number {
    let i = start;
    while (
      i < this.input.length &&
      !isWhitespace(this.input[i]) &&
      this.input[i] !== "=" &&
      this.input[i] !== ">" &&
      this.input[i] !== "/"
    ) {
      i += 1;
    }
    const name = this.input.slice(start, i);
    if (name === "" || /["'<]/.test(name)) throw new MalformedSvgError(`invalid attribute in <${tagName}> tag`);
    while (isWhitespace(this.input[i])) i += 1;
    if (this.input[i] !== "=") {
      // A bare attribute (HTML style). It has no value we could keep.
      into.push({ name, value: "" });
      return i;
    }
    i += 1;
    while (isWhitespace(this.input[i])) i += 1;
    const quote = this.input[i];
    if (quote === '"' || quote === "'") {
      const end = this.input.indexOf(quote, i + 1);
      if (end === -1) throw new MalformedSvgError(`unterminated attribute value in <${tagName}> tag`);
      into.push({ name, value: this.input.slice(i + 1, end) });
      return end + 1;
    }
    // Unquoted value (HTML style): ends at whitespace, '>' or a self-closing '/>'.
    const valueStart = i;
    while (
      i < this.input.length &&
      !isWhitespace(this.input[i]) &&
      this.input[i] !== ">" &&
      !(this.input[i] === "/" && this.input[i + 1] === ">")
    ) {
      i += 1;
    }
    if (i >= this.input.length) throw new MalformedSvgError(`unterminated <${tagName}> tag`);
    into.push({ name, value: this.input.slice(valueStart, i) });
    return i;
  }

  /**
   * <script> and <style> bodies are raw text for an HTML parser ("if (a<b)" is legal there), so
   * they cannot be tokenized as markup. Consume through the matching end tag and report the
   * element as empty.
   */
  private finishOpenTag(name: string, attributes: RawAttribute[], selfClosing: boolean): Token {
    if (selfClosing || !RAW_TEXT_ELEMENTS.has(localName(name))) {
      return { kind: "open", name, attributes, selfClosing };
    }
    const endTag = new RegExp(`</${escapeRegExp(name)}\\s*>`, "gi");
    endTag.lastIndex = this.pos;
    const match = endTag.exec(this.input);
    if (match === null) throw new MalformedSvgError(`unterminated <${name}> element`);
    this.pos = match.index + match[0].length;
    return { kind: "open", name, attributes, selfClosing: true };
  }
}

/* -------------------------------------------------------------------------- */
/*  Values                                                                     */
/* -------------------------------------------------------------------------- */

function resolveEntity(body: string): string {
  if (body[0] !== "#") return PREDEFINED_ENTITIES.get(body) ?? "";
  const hex = body[1] === "x" || body[1] === "X";
  const codePoint = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
  if (!Number.isInteger(codePoint) || codePoint > 0x10ffff) return "";
  return stripInvalidXmlChars(String.fromCodePoint(codePoint));
}

/**
 * Decode character references exactly once, so that checks run on what a browser would see
 * ("&#106;avascript:" is "javascript:"). References to custom entities resolve to nothing.
 */
function decodeEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const amp = raw.indexOf("&", i);
    if (amp === -1) {
      out += raw.slice(i);
      break;
    }
    out += raw.slice(i, amp);
    // Only look a reference's length ahead: scanning to the end for every "&" would be quadratic.
    const window = raw.slice(amp + 1, amp + 1 + MAX_ENTITY_CHARS);
    const semi = window.indexOf(";");
    const body = semi === -1 ? null : window.slice(0, semi);
    if (body !== null && ENTITY_BODY_PATTERN.test(body)) {
      out += resolveEntity(body);
      i = amp + semi + 2;
    } else {
      // A bare ampersand is kept as a literal character and re-escaped on output.
      out += "&";
      i = amp + 1;
    }
  }
  return out;
}

/** Whitespace and control characters are ignored by URL parsers, so "java\nscript:" must match too. */
function compactLower(value: string): string {
  let out = "";
  for (const ch of value) {
    if ((ch.codePointAt(0) ?? 0) > 0x20) out += ch;
  }
  return out.toLowerCase();
}

/**
 * CSS functions other than url() that name an image or another element. Presentation attributes
 * such as `mask` are parsed as CSS, so `mask="image-set('https://…' 1x)"` makes a browser fetch
 * that address when the file is opened — an external reference without the letters "url(".
 * (`-webkit-image-set(` contains `image-set(`.) No drawing needs any of them.
 */
const RESOURCE_FUNCTIONS = ["image-set(", "image(", "cross-fade(", "element(", "paint("] as const;

function isSafeAttributeValue(name: string, value: string): boolean {
  // CSS escapes ("u\72l(") could spell url() or a scheme past the checks below; no drawing needs them.
  if (value.includes("\\")) return false;
  const compact = compactLower(value);
  if (FORBIDDEN_SCHEMES.some((scheme) => compact.includes(scheme))) return false;
  if (name === "href") return FRAGMENT_PATTERN.test(value.trim());
  if (RESOURCE_FUNCTIONS.some((fn) => compact.includes(fn))) return false;
  // Every url(...) must point inside this document; anything else could fetch a remote resource.
  return !compact.replace(INTERNAL_URL_PATTERN, "").includes("url(");
}

function cleanAttributes(raw: readonly RawAttribute[]): [string, string][] {
  const kept = new Map<string, string>();
  for (const attribute of raw) {
    const lower = attribute.name.toLowerCase();
    // SVG 2 made the xlink prefix optional; emitting plain href avoids needing its namespace.
    const canonical = lower === "xlink:href" ? "href" : ALLOWED_ATTRIBUTES.get(lower);
    if (canonical === undefined || kept.has(canonical)) continue;
    const value = stripInvalidXmlChars(decodeEntities(attribute.value));
    if (isSafeAttributeValue(canonical, value)) kept.set(canonical, value);
  }
  return [...kept];
}

/* -------------------------------------------------------------------------- */
/*  Tree building                                                              */
/* -------------------------------------------------------------------------- */

type Disposition = "keep" | "unwrap" | "drop";

interface Frame {
  /** Tag name exactly as written, lower-cased: the closing tag has to match it. */
  rawName: string;
  disposition: Disposition;
  /** The output element this frame writes into (its own node when kept, otherwise an ancestor's). */
  target: ElementNode | null;
}

/** What to do with an element; a kept element also gets its canonical (case-corrected) name. */
type Verdict = { disposition: "keep"; name: string } | { disposition: "unwrap" | "drop" };

function classify(name: string, attributes: readonly [string, string][], isNested: boolean): Verdict {
  const local = localName(name);
  if (DROPPED_WITH_CONTENT.has(local) || local.startsWith("animate")) return { disposition: "drop" };
  const canonical = ALLOWED_ELEMENTS.get(local);
  if (canonical === undefined) return { disposition: "unwrap" };
  // A nested <svg> opens a new viewport and coordinate system; flatten it so the document keeps one root.
  if (canonical === "svg" && isNested) return { disposition: "unwrap" };
  // <use> may only re-draw an element of this document; without a valid internal target it is inert or remote.
  if (canonical === "use" && !attributes.some(([key]) => key === "href")) return { disposition: "drop" };
  return { disposition: "keep", name: canonical };
}

function buildTree(input: string): ElementNode {
  const tokenizer = new Tokenizer(input);
  const stack: Frame[] = [];
  let root: ElementNode | null = null;

  for (let token = tokenizer.next(); token !== null; token = tokenizer.next()) {
    const top = stack[stack.length - 1];

    if (token.kind === "text") {
      if (top === undefined) {
        if (token.value.trim() !== "") throw new MalformedSvgError("text outside the root <svg> element");
      } else if (top.disposition !== "drop" && top.target !== null && TEXT_CONTAINERS.has(top.target.name)) {
        const text = decodeEntities(token.value);
        if (text !== "") top.target.children.push(text);
      }
      continue;
    }

    if (token.kind === "close") {
      if (top === undefined || top.rawName !== token.name.toLowerCase()) {
        throw new MalformedSvgError(`unexpected closing tag </${token.name}>`);
      }
      stack.pop();
      continue;
    }

    const rawName = token.name.toLowerCase();
    if (top === undefined) {
      if (root !== null) throw new MalformedSvgError("more than one root element");
      if (ALLOWED_ELEMENTS.get(localName(token.name)) !== "svg") {
        throw new MalformedSvgError("root element must be <svg>");
      }
    }
    if (top?.disposition === "drop") {
      if (!token.selfClosing) stack.push({ rawName, disposition: "drop", target: null });
      continue;
    }

    const attributes = cleanAttributes(token.attributes);
    const verdict = classify(token.name, attributes, top !== undefined);
    let target = top?.target ?? null;
    if (verdict.disposition === "keep") {
      const node: ElementNode = { name: verdict.name, attributes, children: [] };
      if (target === null) root = node;
      else target.children.push(node);
      target = node;
    }
    if (!token.selfClosing) {
      if (stack.length >= MAX_DEPTH) throw new MalformedSvgError(`elements nested deeper than ${MAX_DEPTH} levels`);
      stack.push({ rawName, disposition: verdict.disposition, target });
    }
  }

  const unclosed = stack[stack.length - 1];
  if (unclosed !== undefined) throw new MalformedSvgError(`unclosed <${unclosed.rawName}> element`);
  if (root === null) throw new MalformedSvgError("no <svg> root element found");
  return root;
}

/* -------------------------------------------------------------------------- */
/*  <use> chains                                                               */
/* -------------------------------------------------------------------------- */

function containsUse(node: ElementNode): boolean {
  return node.children.some((child) => typeof child !== "string" && (child.name === "use" || containsUse(child)));
}

/** Ids of elements that are, or contain, a <use>. Only the first element carrying an id counts. */
function collectChainedIds(node: ElementNode, seen: Set<string>, chained: Set<string>): void {
  const id = node.attributes.find(([name]) => name === "id")?.[1];
  if (id !== undefined && !seen.has(id)) {
    seen.add(id);
    if (node.name === "use" || containsUse(node)) chained.add(id);
  }
  for (const child of node.children) {
    if (typeof child !== "string") collectChainedIds(child, seen, chained);
  }
}

/**
 * A <use> may re-draw plain shapes, never something that itself contains a <use>. Chains of
 * references multiply ("ten copies of ten copies of ..."), which lets a few hundred bytes ask a
 * renderer for billions of shapes, and a reference to an ancestor is a cycle.
 */
function pruneUseChains(node: ElementNode, chained: ReadonlySet<string>): void {
  node.children = node.children.filter((child) => {
    if (typeof child === "string") return true;
    if (child.name === "use") {
      const href = child.attributes.find(([name]) => name === "href")?.[1] ?? "";
      return !chained.has(href.trim().slice(1));
    }
    pruneUseChains(child, chained);
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/*  Output                                                                     */
/* -------------------------------------------------------------------------- */

function hasDrawableContent(node: ElementNode): boolean {
  return node.children.some(
    (child) => typeof child !== "string" && (DRAWABLE_ELEMENTS.has(child.name) || hasDrawableContent(child)),
  );
}

function serialize(node: ElementNode, isRoot: boolean): string {
  let out = `<${node.name}`;
  // The namespace is ours, never the input's: it is what makes the output a real SVG document.
  if (isRoot) out += ` xmlns="${SVG_NAMESPACE}"`;
  for (const [name, value] of node.attributes) out += ` ${name}="${escapeAttr(value)}"`;
  if (node.children.length === 0) return `${out}/>`;
  out += ">";
  for (const child of node.children) {
    out += typeof child === "string" ? escapeText(child) : serialize(child, false);
  }
  return `${out}</${node.name}>`;
}

/**
 * Sanitize untrusted SVG markup.
 *
 * Returns a well-formed document with exactly one root `<svg xmlns="http://www.w3.org/2000/svg">`
 * that contains only allowlisted elements and attributes, or `{ ok: false }` with a
 * human-readable reason when the input is empty, malformed, too large, or has nothing left to draw.
 */
export function sanitizeSvg(input: string): SanitizeResult {
  if (input.trim() === "") return { ok: false, reason: "SVG is empty" };
  if (input.length > MAX_SVG_CHARS) {
    return { ok: false, reason: `SVG is larger than ${MAX_SVG_CHARS} characters` };
  }
  let root: ElementNode;
  try {
    root = buildTree(input);
  } catch (error) {
    if (error instanceof MalformedSvgError) return { ok: false, reason: `malformed SVG: ${error.message}` };
    throw error;
  }
  const chained = new Set<string>();
  collectChainedIds(root, new Set(), chained);
  pruneUseChains(root, chained);
  if (!hasDrawableContent(root)) {
    return { ok: false, reason: "SVG is empty: nothing drawable is left after sanitisation" };
  }
  const svg = serialize(root, true);
  if (svg.length > MAX_SVG_CHARS) {
    return { ok: false, reason: `sanitised SVG is larger than ${MAX_SVG_CHARS} characters` };
  }
  return { ok: true, svg };
}
