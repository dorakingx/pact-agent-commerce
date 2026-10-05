/**
 * Read-only SVG inspection for the verifier.
 *
 * A delivered SVG is untrusted input. This module never renders or repairs it; it reads the
 * markup just far enough to answer three questions deterministically:
 *   1. Is it a well-formed, static SVG (no scripts, handlers or external references)?
 *   2. Do its declared dimensions agree with what the seller says they delivered?
 *   3. Does it carry text a human would not see but a model reading the file would?
 *
 * Two design rules follow from "untrusted":
 *   - Safety is judged on the RAW markup, not on this module's own token stream. Browsers and
 *     XML parsers disagree about malformed tags, and a check that trusts one tokeniser can be
 *     shown a different document than the one a browser would run.
 *   - Every loop is linear in the input and nesting is capped, so a hostile 200 KB file cannot
 *     stall verification.
 *
 * There is deliberately no DOM dependency: the same code runs in tests, on the server and in CI.
 */

export interface SvgElement {
  /** Lower-cased tag name including any namespace prefix. */
  name: string;
  /** Lower-cased attribute name and entity-decoded value, in document order. */
  attributes: ReadonlyArray<readonly [name: string, value: string]>;
  parent: SvgElement | null;
}

export interface SvgTextChunk {
  /** Innermost open element, or null for text outside the root. */
  owner: SvgElement | null;
  text: string;
}

export interface SvgDocument {
  /** The markup exactly as delivered. */
  source: string;
  root: SvgElement | null;
  elements: SvgElement[];
  /** Character data and CDATA, entity-decoded, in document order. */
  texts: SvgTextChunk[];
  comments: string[];
  /** Processing instructions and <!DOCTYPE ...> style declarations. */
  declarations: string[];
  hasDoctype: boolean;
  /** First well-formedness problem found, or null. */
  problem: string | null;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode numeric and the basic named character references, so "&#105;gnore" reads as "ignore". */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole: string, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : " ";
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Element or attribute name without its namespace prefix ("xlink:href" -> "href"). */
export function localName(name: string): string {
  const colon = name.lastIndexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/** First value of the attribute with this (lower-case) name, or null. */
export function attribute(element: SvgElement, name: string): string | null {
  for (const [key, value] of element.attributes) {
    if (key === name) return value;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Tokeniser                                                                  */
/* -------------------------------------------------------------------------- */

/** Their content is character data even when it contains "<" (CSS selectors, script source). */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["script", "style"]);

/** Real illustrations nest a handful of groups; anything deeper is hostile or broken. */
const MAX_DEPTH = 128;

const ATTRIBUTE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Index of the ">" that ends a tag, skipping quoted attribute values. */
function findTagEnd(source: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

/** Index of the ">" that ends a <!DOCTYPE ...> declaration, including any [ internal subset ]. */
function findDeclarationEnd(source: string, from: number): number {
  let quote: string | null = null;
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
    } else if (ch === ">" && depth <= 0) {
      return i;
    }
  }
  return -1;
}

function parseTag(body: string, parent: SvgElement | null): SvgElement | null {
  const nameMatch = /^[A-Za-z_][\w:.-]*/.exec(body);
  if (nameMatch === null) return null;
  const attributes: Array<readonly [string, string]> = [];
  for (const match of body.slice(nameMatch[0].length).matchAll(ATTRIBUTE)) {
    attributes.push([match[1].toLowerCase(), decodeEntities(match[2] ?? match[3] ?? match[4] ?? "")]);
  }
  return { name: nameMatch[0].toLowerCase(), attributes, parent };
}

/**
 * Case-insensitive search for `</name ...>` starting at `from`; linear, no regex backtracking.
 * `lowered` is the lower-cased source, computed once by the caller.
 */
function findClosingTag(
  source: string,
  lowered: string,
  name: string,
  from: number,
): { start: number; end: number } | null {
  const needle = `</${name}`;
  for (let start = lowered.indexOf(needle, from); start !== -1; start = lowered.indexOf(needle, start + 1)) {
    const end = source.indexOf(">", start + needle.length);
    if (end === -1) return null;
    if (source.slice(start + needle.length, end).trim() === "") return { start, end: end + 1 };
  }
  return null;
}

/**
 * Tolerant tokeniser: it always returns everything it could read (so hostile text is still
 * scanned) and records the first reason the markup is not well-formed.
 */
export function parseSvg(source: string): SvgDocument {
  const doc: SvgDocument = {
    source,
    root: null,
    elements: [],
    texts: [],
    comments: [],
    declarations: [],
    hasDoctype: false,
    problem: null,
  };
  const stack: SvgElement[] = [];
  let lowered: string | null = null;
  const fail = (problem: string): void => {
    if (doc.problem === null) doc.problem = problem;
  };
  const top = (): SvgElement | null => stack[stack.length - 1] ?? null;
  /** Reads an `open ... close` construct; returns the index after it, or -1 when it never closes. */
  const readUntil = (start: number, open: string, close: string, sink: string[] | null, what: string): number => {
    const end = source.indexOf(close, start + open.length);
    const content = source.slice(start + open.length, end === -1 ? source.length : end);
    if (sink === null) doc.texts.push({ owner: top(), text: content });
    else sink.push(content);
    if (end === -1) fail(`unterminated ${what}`);
    return end === -1 ? -1 : end + close.length;
  };
  /** Stops tokenising but keeps the unread tail available to the instruction scan. */
  const abandon = (from: number, problem: string): -1 => {
    doc.texts.push({ owner: top(), text: source.slice(from) });
    fail(problem);
    return -1;
  };

  const openElement = (body: string, after: number): number => {
    const selfClosing = body.endsWith("/");
    const element = parseTag(selfClosing ? body.slice(0, -1) : body, top());
    if (element === null) {
      fail("malformed tag");
      return after;
    }
    if (stack.length === 0) {
      if (doc.root === null) doc.root = element;
      else fail("more than one root element");
    }
    doc.elements.push(element);
    if (selfClosing) return after;

    if (RAW_TEXT_ELEMENTS.has(localName(element.name))) {
      lowered ??= source.toLowerCase();
      const closing = findClosingTag(source, lowered, element.name, after);
      doc.texts.push({ owner: element, text: decodeEntities(source.slice(after, closing?.start ?? source.length)) });
      if (closing === null) fail(`unclosed <${element.name}> element`);
      return closing?.end ?? -1;
    }
    if (stack.length >= MAX_DEPTH) return abandon(after, `elements nested more than ${MAX_DEPTH} deep`);
    stack.push(element);
    return after;
  };

  let i = 0;
  while (i !== -1 && i < source.length) {
    if (source[i] !== "<") {
      const next = source.indexOf("<", i);
      const end = next === -1 ? source.length : next;
      const text = source.slice(i, end);
      doc.texts.push({ owner: top(), text: decodeEntities(text) });
      if (stack.length === 0 && text.trim() !== "") fail("text outside the root element");
      i = end;
    } else if (source.startsWith("<!--", i)) {
      i = readUntil(i, "<!--", "-->", doc.comments, "comment");
    } else if (source.startsWith("<![CDATA[", i)) {
      i = readUntil(i, "<![CDATA[", "]]>", null, "CDATA section");
    } else if (source.startsWith("<?", i)) {
      i = readUntil(i, "<?", "?>", doc.declarations, "processing instruction");
    } else if (source.startsWith("<!", i)) {
      const end = findDeclarationEnd(source, i + 2);
      doc.declarations.push(source.slice(i + 2, end === -1 ? source.length : end));
      doc.hasDoctype = true;
      if (end === -1) fail("unterminated declaration");
      i = end === -1 ? -1 : end + 1;
    } else {
      const end = findTagEnd(source, i + 1);
      if (end === -1) {
        i = abandon(i, "unterminated tag");
      } else {
        const body = source.slice(i + 1, end);
        if (body.startsWith("/")) {
          const name = body.slice(1).trim().toLowerCase();
          const open = stack.pop();
          if (open === undefined || open.name !== name) fail(`mismatched closing tag </${name.slice(0, 40)}>`);
          i = end + 1;
        } else {
          i = openElement(body, end + 1);
        }
      }
    }
  }

  const unclosed = top();
  if (unclosed !== null) fail(`unclosed <${unclosed.name}> element`);
  if (doc.root === null) fail("no root element");
  return doc;
}

/* -------------------------------------------------------------------------- */
/*  Safety: active content and external references                             */
/* -------------------------------------------------------------------------- */

/** Elements that execute code, embed foreign documents or play media. */
const ACTIVE_ELEMENT = /<(?:[\w.-]+:)?(script|foreignobject|iframe|embed|object|audio|video|handler|listener)(?![\w.-])/gi;
/** on* attributes. Matched anywhere in the markup, so a tag that confuses a tokeniser cannot hide one. */
const EVENT_HANDLER = /(?:^|[\s"'/<])(on[a-z]{2,})\s*=/gi;
const LINK_ATTRIBUTE = /(?:^|[\s"'/<])(?:[\w.-]+:)?(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*))/gi;
/** url(...) that points anywhere other than a fragment of the same document. */
const EXTERNAL_URL_FUNCTION = /url\(\s*['"]?\s*(?!#)/i;
const ANIMATED_LINK = /attributename\s*=\s*["']?\s*(?:[\w.-]+:)?href(?![\w.-])/i;

const ELEMENT_DISPLAY_NAME: Readonly<Record<string, string>> = { foreignobject: "foreignObject" };

/**
 * Everything that makes the file more than a static drawing. An empty list means the SVG is
 * well-formed, self-contained and inert.
 *
 * The checks run over the raw markup and err on the side of refusing: a file that merely
 * mentions `<script` inside a text node is rejected too. Sellers deliver drawings, and a
 * drawing has no reason to contain that string.
 */
export function svgSafetyProblems(doc: SvgDocument): string[] {
  const problems = new Set<string>();
  if (doc.problem !== null) problems.add(`is not well-formed (${doc.problem})`);
  if (doc.root !== null && localName(doc.root.name) !== "svg") problems.add("root element is not <svg>");
  if (doc.hasDoctype) problems.add("contains a document type declaration");

  const { source } = doc;
  for (const match of source.matchAll(ACTIVE_ELEMENT)) {
    const tag = match[1].toLowerCase();
    problems.add(`contains a <${ELEMENT_DISPLAY_NAME[tag] ?? tag}> element`);
  }
  for (const match of source.matchAll(EVENT_HANDLER)) {
    problems.add(`has an ${match[1].toLowerCase().slice(0, 24)} event handler`);
  }
  for (const match of source.matchAll(LINK_ATTRIBUTE)) {
    const target = decodeEntities(match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!target.startsWith("#")) problems.add("references an external resource");
  }
  if (ANIMATED_LINK.test(source)) problems.add("animates a link target");

  const decoded = decodeEntities(source);
  if (EXTERNAL_URL_FUNCTION.test(decoded) || /@import/i.test(decoded)) problems.add("references an external resource");
  // Browsers ignore whitespace and control characters inside a URL scheme ("java\nscript:").
  if (/javascript:/i.test(decoded.replace(/[\s\u0000-\u001f]+/g, ""))) problems.add("contains a javascript: URL");
  // CSS escapes can spell url( or @import without containing those characters ("u\72l(").
  if (source.includes("\\") && /style/i.test(source)) problems.add("uses CSS escape sequences");
  return [...problems];
}

/* -------------------------------------------------------------------------- */
/*  Dimensions                                                                 */
/* -------------------------------------------------------------------------- */

interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Longest attribute value worth interpreting as a number, length or paint. */
const MAX_VALUE_CHARS = 64;

function parseViewBox(value: string | null): ViewBox | null {
  if (value === null || value.length > 4 * MAX_VALUE_CHARS) return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, width, height] = parts;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** A length in CSS pixels, or null when absent or relative (%, em): those say nothing about real size. */
function parsePixelLength(value: string | null): number | null {
  if (value === null || value.length > MAX_VALUE_CHARS) return null;
  const match = /^(\d+(?:\.\d+)?|\.\d+)(?:px)?$/i.exec(value.trim());
  return match === null ? null : Number(match[1]);
}

/** Declared pixel sizes may differ from the delivery record by sub-pixel rounding only. */
const PIXEL_TOLERANCE = 1;

/**
 * Compare what the file itself declares with the width/height recorded for the artifact.
 * Aspect-ratio coverage is computed from the recorded size, so a file whose real geometry
 * disagrees with its record must never pass as valid.
 */
export function svgDimensionProblems(
  doc: SvgDocument,
  recorded: { width: number; height: number },
  ratioTolerance: number,
): string[] {
  // Without an <svg> root there is no geometry to compare; svgSafetyProblems reports that case.
  if (doc.root === null || localName(doc.root.name) !== "svg") return [];
  const problems: string[] = [];
  const rawViewBox = attribute(doc.root, "viewbox");
  const viewBox = parseViewBox(rawViewBox);
  const width = parsePixelLength(attribute(doc.root, "width"));
  const height = parsePixelLength(attribute(doc.root, "height"));
  const size = `${recorded.width}×${recorded.height}`;

  if (rawViewBox !== null && viewBox === null) problems.push("has a malformed viewBox");
  if (viewBox === null && (width === null || height === null)) {
    problems.push("declares neither a viewBox nor a pixel width and height");
  }
  const widthOff = width !== null && Math.abs(width - recorded.width) > PIXEL_TOLERANCE;
  const heightOff = height !== null && Math.abs(height - recorded.height) > PIXEL_TOLERANCE;
  if (widthOff || heightOff) {
    problems.push(`declares ${width ?? "auto"}×${height ?? "auto"} but was delivered as ${size}`);
  }
  if (viewBox !== null) {
    const recordedRatio = recorded.width / recorded.height;
    const drift = Math.abs(viewBox.width / viewBox.height - recordedRatio) / recordedRatio;
    if (drift > ratioTolerance) {
      problems.push(`viewBox ${viewBox.width}×${viewBox.height} does not match the delivered ${size}`);
    }
  }
  return problems;
}

/* -------------------------------------------------------------------------- */
/*  Hidden text                                                                */
/* -------------------------------------------------------------------------- */

export interface HiddenText {
  text: string;
  /** Short human-readable cause, e.g. "opacity 0". */
  reason: string;
}

/** Legitimately invisible containers (accessibility text, styles). They are scanned, not flagged. */
const NON_RENDERED_BY_DESIGN: ReadonlySet<string> = new Set(["title", "desc", "metadata", "style", "script"]);
/** Content here only appears if something references it. */
const REFERENCE_ONLY: ReadonlySet<string> = new Set(["defs", "symbol", "clippath", "mask", "pattern", "marker"]);
const TEXT_POSITIONING: ReadonlySet<string> = new Set(["text", "tspan", "textpath"]);

/** Name of the enclosing accessibility or style container (title, desc, metadata, style, script), if any. */
export function nonRenderedContainer(owner: SvgElement | null): string | null {
  for (let node = owner; node !== null; node = node.parent) {
    const name = localName(node.name);
    if (NON_RENDERED_BY_DESIGN.has(name)) return name;
  }
  return null;
}

/** Anything at or below this alpha (or scale) is invisible to a person. */
const INVISIBLE_ALPHA = 0.02;
/** Text rendered smaller than this many device pixels cannot be read. */
const MIN_LEGIBLE_PX = 2;
const NUMBER = "-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:e[-+]?\\d+)?";
const FIRST_NUMBER = new RegExp(NUMBER, "i");
const FONT_SIZE = new RegExp(`^(${NUMBER})\\s*(px|pt)?$`, "i");
const TRANSLATE = new RegExp(`translate\\(\\s*(${NUMBER})(?:[\\s,]+(${NUMBER}))?\\s*\\)`, "gi");
const SCALE = new RegExp(`scale\\(\\s*(${NUMBER})`, "i");
/** The presentation properties that can make text invisible. */
const TRACKED_PROPERTIES = ["display", "opacity", "visibility", "fill", "fill-opacity", "stroke", "stroke-opacity", "font-size"] as const;
type TrackedProperty = (typeof TRACKED_PROPERTIES)[number];

type Declarations = ReadonlyMap<string, string>;

/** The latest stylesheet value of one tracked property for one exact selector. */
interface SheetValue {
  /** Position of the rule in the sheet; of two matching rules the later one wins. */
  order: number;
  value: string;
}

/**
 * Stylesheet rules that can hide text, addressable by exact simple selector. Looking an element
 * up costs a few map reads per class it carries, however many rules the sheet has: scanning
 * the sheet per element would let a file of thousands of rules and thousands of elements cost
 * millions of comparisons.
 */
type RuleIndex = ReadonlyMap<string, ReadonlyMap<TrackedProperty, SheetValue>>;

/**
 * Selector parts never contain a space (see the selector pattern), so a key with exactly two
 * spaces identifies one (tag, class, id) triple and nothing an element supplies can forge another.
 */
function selectorKey(tag: string | null, className: string | null, id: string | null): string {
  return `${tag ?? "*"} ${className ?? ""} ${id ?? ""}`;
}

function parseDeclarations(css: string): Declarations {
  const declarations = new Map<string, string>();
  for (const part of css.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const value = part.slice(colon + 1).replace(/!important/i, "").trim().toLowerCase();
    declarations.set(part.slice(0, colon).trim().toLowerCase(), value);
  }
  return declarations;
}

function withoutCssComments(css: string): string {
  let out = "";
  let cursor = 0;
  for (let open = css.indexOf("/*"); open !== -1; open = css.indexOf("/*", cursor)) {
    const close = css.indexOf("*/", open + 2);
    out += `${css.slice(cursor, open)} `;
    cursor = close === -1 ? css.length : close + 2;
  }
  return out + css.slice(cursor);
}

function trackedValues(declarations: Declarations): [TrackedProperty, string][] {
  const tracked: [TrackedProperty, string][] = [];
  for (const property of TRACKED_PROPERTIES) {
    const value = declarations.get(property);
    if (value !== undefined) tracked.push([property, value]);
  }
  return tracked;
}

/**
 * Index every stylesheet rule that sets a tracked property. Simple selectors only (tag, .class,
 * #id, *): anything fancier is ignored rather than guessed at. Rules are numbered in sheet
 * order, and a later rule for the same selector replaces an earlier one, as in the cascade.
 */
function styleRuleIndex(doc: SvgDocument): RuleIndex {
  const index = new Map<string, Map<TrackedProperty, SheetValue>>();
  let order = 0;
  for (const chunk of doc.texts) {
    if (chunk.owner === null || localName(chunk.owner.name) !== "style") continue;
    const css = withoutCssComments(chunk.text);
    for (let cursor = 0; cursor < css.length; ) {
      const open = css.indexOf("{", cursor);
      const close = open === -1 ? -1 : css.indexOf("}", open + 1);
      if (close === -1) break;
      const tracked = trackedValues(parseDeclarations(css.slice(open + 1, close)));
      for (const selector of tracked.length === 0 ? [] : css.slice(cursor, open).split(",")) {
        const match = /^(\*|[a-z][\w-]*)?(?:\.([\w-]+))?(?:#([\w-]+))?$/i.exec(selector.trim());
        if (match === null || match[0] === "") continue;
        const tag = match[1] === undefined || match[1] === "*" ? null : match[1].toLowerCase();
        const key = selectorKey(tag, match[2] ?? null, match[3] ?? null);
        const entry = index.get(key) ?? new Map<TrackedProperty, SheetValue>();
        order += 1;
        for (const [property, value] of tracked) entry.set(property, { order, value });
        index.set(key, entry);
      }
      cursor = close + 1;
    }
  }
  return index;
}

/**
 * The stylesheet's value for each tracked property on one element: of all rules whose selector
 * matches the element, the last one in the sheet that sets the property.
 */
function sheetValues(element: SvgElement, index: RuleIndex): Partial<Record<TrackedProperty, string>> {
  const values: Partial<Record<TrackedProperty, string>> = {};
  if (index.size === 0) return values;
  const tag = localName(element.name);
  const id = attribute(element, "id");
  const classes = [...new Set((attribute(element, "class") ?? "").split(/\s+/)), null];
  const winning: Partial<Record<TrackedProperty, number>> = {};
  // Every simple selector that can match: each part either names the element's own value or is absent.
  for (const selectorTag of [tag, null]) {
    for (const selectorId of id === null ? [null] : [id, null]) {
      for (const className of classes) {
        const entry = index.get(selectorKey(selectorTag, className, selectorId));
        if (entry === undefined) continue;
        for (const [property, candidate] of entry) {
          if (candidate.order > (winning[property] ?? 0)) {
            winning[property] = candidate.order;
            values[property] = candidate.value;
          }
        }
      }
    }
  }
  return values;
}

function parseAlpha(value: string | null): number | null {
  if (value === null) return null;
  const number = Number.parseFloat(value);
  if (Number.isNaN(number)) return null;
  return value.endsWith("%") ? number / 100 : number;
}

function isInvisiblePaint(value: string | null): boolean {
  if (value === null) return false;
  return (
    value === "none" ||
    value === "transparent" ||
    /^(?:rgba|hsla)\([^)]*[,/]\s*0(?:\.0+)?%?\s*\)$/.test(value) ||
    /^#(?:[0-9a-f]{3}0|[0-9a-f]{6}00)$/.test(value)
  );
}

/** Font size in user units, or null when unknown or relative. */
function parseFontSize(value: string | null): number | null {
  const match = value === null ? null : FONT_SIZE.exec(value);
  if (match === null) return null;
  const size = Number(match[1]);
  return match[2]?.toLowerCase() === "pt" ? (size * 4) / 3 : size;
}

function firstNumber(value: string | null): number | null {
  const match = value === null ? null : FIRST_NUMBER.exec(value.slice(0, MAX_VALUE_CHARS));
  return match === null ? null : Number(match[0]);
}

/** Everything about an element that decides whether text inside it can be seen. Computed once per element. */
interface Presentation {
  /** Why this element and all of its content is not painted (display, opacity, scale), if so. */
  suppressed: string | null;
  visibility: string | null;
  fill: string | null;
  fillAlpha: number | null;
  stroke: string | null;
  strokeAlpha: number | null;
  fontSize: number | null;
  insideText: boolean;
  /** Start position set by the nearest text positioning element, in user units. */
  x: number | null;
  y: number | null;
  /** Sum of every translate() from the root down. */
  dx: number;
  dy: number;
  /** Nearest enclosing defs-like container, and whether anything references the content. */
  container: string | null;
  containerReferenced: boolean;
}

const ROOT_PRESENTATION: Presentation = {
  suppressed: null,
  visibility: null,
  fill: null,
  fillAlpha: null,
  stroke: null,
  strokeAlpha: null,
  fontSize: null,
  insideText: false,
  x: null,
  y: null,
  dx: 0,
  dy: 0,
  container: null,
  containerReferenced: false,
};

interface HiddenContext {
  rules: RuleIndex;
  referenced: ReadonlySet<string>;
  view: ViewBox;
  /** Device pixels per user unit. */
  scale: number;
  cache: Map<SvgElement, Presentation>;
}

/** Cascade for one element: inline style beats stylesheet rules, which beat presentation attributes. */
function ownProperties(element: SvgElement, rules: RuleIndex): Partial<Record<TrackedProperty, string>> {
  const inline = parseDeclarations(attribute(element, "style") ?? "");
  const fromSheet = sheetValues(element, rules);
  const own: Partial<Record<TrackedProperty, string>> = {};
  for (const property of TRACKED_PROPERTIES) {
    const value = inline.get(property) ?? fromSheet[property] ?? attribute(element, property)?.trim().toLowerCase();
    // Oversized values are not real presentation values; ignoring them keeps every later regex cheap.
    if (value !== undefined && value !== "inherit" && value.length <= MAX_VALUE_CHARS) own[property] = value;
  }
  return own;
}

function presentationOf(element: SvgElement, ctx: HiddenContext): Presentation {
  const cached = ctx.cache.get(element);
  if (cached !== undefined) return cached;
  // Recursion is bounded by MAX_DEPTH: deeper elements are never tokenised.
  const parent = element.parent === null ? ROOT_PRESENTATION : presentationOf(element.parent, ctx);
  const own = ownProperties(element, ctx.rules);
  const name = localName(element.name);
  const transform = (attribute(element, "transform") ?? "").slice(0, 4 * MAX_VALUE_CHARS);

  let suppressed = parent.suppressed;
  if (suppressed === null) {
    const alpha = parseAlpha(own.opacity ?? null);
    const scale = SCALE.exec(transform);
    if (own.display === "none") suppressed = "display:none";
    else if (alpha !== null && alpha <= INVISIBLE_ALPHA) suppressed = "opacity 0";
    else if (scale !== null && Math.abs(Number(scale[1])) < INVISIBLE_ALPHA) suppressed = "scaled to nothing";
  }

  let dx = parent.dx;
  let dy = parent.dy;
  for (const match of transform.matchAll(TRANSLATE)) {
    dx += Number(match[1]);
    dy += match[2] === undefined ? 0 : Number(match[2]);
  }

  const positions = TEXT_POSITIONING.has(name);
  const id = attribute(element, "id");
  const isReferenced = id !== null && ctx.referenced.has(id);
  const startsContainer = REFERENCE_ONLY.has(name);

  const presentation: Presentation = {
    suppressed,
    visibility: own.visibility ?? parent.visibility,
    fill: own.fill ?? parent.fill,
    fillAlpha: parseAlpha(own["fill-opacity"] ?? null) ?? parent.fillAlpha,
    stroke: own.stroke ?? parent.stroke,
    strokeAlpha: parseAlpha(own["stroke-opacity"] ?? null) ?? parent.strokeAlpha,
    fontSize: parseFontSize(own["font-size"] ?? null) ?? parent.fontSize,
    insideText: parent.insideText || name === "text",
    x: (positions ? firstNumber(attribute(element, "x")) : null) ?? parent.x,
    y: (positions ? firstNumber(attribute(element, "y")) : null) ?? parent.y,
    dx,
    dy,
    container: startsContainer ? name : parent.container,
    containerReferenced: startsContainer ? isReferenced : parent.containerReferenced || isReferenced,
  };
  ctx.cache.set(element, presentation);
  return presentation;
}

function hiddenReason(p: Presentation, ctx: HiddenContext): string | null {
  if (!p.insideText) return "outside any <text> element";
  if (p.container !== null && !p.containerReferenced) return `inside an unreferenced <${p.container}>`;
  if (p.suppressed !== null) return p.suppressed;
  if (p.visibility === "hidden" || p.visibility === "collapse") return "visibility:hidden";

  const fillInvisible = (p.fillAlpha !== null && p.fillAlpha <= INVISIBLE_ALPHA) || isInvisiblePaint(p.fill);
  if (fillInvisible) {
    // Outlined lettering (no fill, visible stroke) is a legitimate style, not hidden text.
    const strokeVisible = p.stroke !== null && !isInvisiblePaint(p.stroke) && (p.strokeAlpha ?? 1) > INVISIBLE_ALPHA;
    if (!strokeVisible) return "transparent fill";
  }
  if (p.fontSize !== null && p.fontSize * ctx.scale < MIN_LEGIBLE_PX) return "unreadably small font";

  const x = (p.x ?? 0) + p.dx;
  const y = (p.y ?? 0) + p.dy;
  const { view } = ctx;
  const outside =
    x < view.x - view.width ||
    x > view.x + view.width * 1.1 ||
    y < view.y - view.height * 0.1 ||
    y > view.y + view.height * 1.1;
  return outside ? "positioned outside the canvas" : null;
}

function referencedIds(doc: SvgDocument): Set<string> {
  const ids = new Set<string>();
  for (const element of doc.elements) {
    for (const [name, value] of element.attributes) {
      if (localName(name) === "href" && value.trim().startsWith("#")) ids.add(value.trim().slice(1));
      for (const match of value.matchAll(/url\(\s*['"]?#([^'")\s]+)/g)) ids.add(match[1]);
    }
  }
  return ids;
}

/**
 * Text that is present in the file but that a person looking at the rendered image would not
 * see. Such text has no design purpose; its only audience is a machine reading the markup.
 */
export function findHiddenText(doc: SvgDocument, rendered: { width: number; height: number }): HiddenText[] {
  const view: ViewBox = (doc.root === null ? null : parseViewBox(attribute(doc.root, "viewbox"))) ?? {
    x: 0,
    y: 0,
    width: rendered.width,
    height: rendered.height,
  };
  const ctx: HiddenContext = {
    rules: styleRuleIndex(doc),
    referenced: referencedIds(doc),
    view,
    scale: rendered.width / view.width,
    cache: new Map(),
  };

  const hidden: HiddenText[] = [];
  for (const chunk of doc.texts) {
    const text = chunk.text.trim();
    if (text === "" || nonRenderedContainer(chunk.owner) !== null) continue;
    const presentation = chunk.owner === null ? ROOT_PRESENTATION : presentationOf(chunk.owner, ctx);
    const reason = hiddenReason(presentation, ctx);
    if (reason !== null) hidden.push({ text, reason });
  }
  return hidden;
}
