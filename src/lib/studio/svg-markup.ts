/**
 * Low-level SVG serialisation shared by the illustration engine (which writes markup) and the
 * sanitizer (which re-writes untrusted markup). Both go through the same escaping rules, so
 * anything the studio renders is already in the sanitizer's canonical form.
 */

/** XML 1.0 `Char` production: everything else cannot legally appear in a document. */
function isXmlChar(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

/** Drop control characters and lone surrogates that would make the document ill-formed. */
export function stripInvalidXmlChars(value: string): string {
  let out = "";
  for (const ch of value) {
    if (isXmlChar(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out;
}

export function escapeText(value: string): string {
  return stripInvalidXmlChars(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Attribute values are always written inside double quotes. */
export function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

/**
 * Compact number formatting: one decimal is below a device pixel at the sizes we render,
 * and it keeps every illustration well under its byte budget.
 */
export function num(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`cannot serialise a non-finite number into SVG: ${value}`);
  }
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  // Avoid "-0", which is valid but noisy and breaks byte-for-byte determinism checks.
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

export type AttrValue = string | number | null | undefined | false;
export type Attrs = Readonly<Record<string, AttrValue>>;

/** Fractions (opacities, gradient offsets) need a finer grain than pixel coordinates do. */
function decimalsFor(attribute: string): number {
  return attribute.includes("opacity") || attribute === "offset" ? 2 : 1;
}

/** Serialise one element. Attributes whose value is null/undefined/false are omitted. */
export function el(name: string, attrs: Attrs, children?: string | readonly string[]): string {
  let out = `<${name}`;
  for (const [key, raw] of Object.entries(attrs)) {
    if (raw === null || raw === undefined || raw === false) continue;
    out += ` ${key}="${typeof raw === "number" ? num(raw, decimalsFor(key)) : escapeAttr(raw)}"`;
  }
  const inner = children === undefined ? "" : typeof children === "string" ? children : children.join("");
  return inner === "" ? `${out}/>` : `${out}>${inner}</${name}>`;
}
