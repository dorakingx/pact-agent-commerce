/**
 * Small text helpers for everything the studio writes into an artifact or a delivery note.
 * Model output and client-supplied subjects pass through these before they are stored.
 */
import { stripInvalidXmlChars } from "./svg-markup";

/** Collapse all whitespace (including line breaks) to single spaces and drop control characters. */
export function singleLine(text: string): string {
  return stripInvalidXmlChars(text).replace(/\s+/g, " ").trim();
}

/** Keep paragraphs, but normalise spacing inside them and drop control characters. */
export function tidyParagraphs(text: string): string {
  return stripInvalidXmlChars(text)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph !== "")
    .join("\n\n");
}

/**
 * Shorten `text` to at most `max` UTF-16 code units (the unit the domain schemas limit), cutting
 * at a word boundary when one is near and marking the cut with an ellipsis. Never splits a
 * surrogate pair.
 */
export function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  let head = text.slice(0, Math.max(0, max - 1));
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  // Back up to the previous word only when the cut would land inside a word.
  const endsOnWord = /\s/.test(text.charAt(head.length));
  const lastSpace = head.lastIndexOf(" ");
  const cut = !endsOnWord && lastSpace > head.length * 0.6 ? head.slice(0, lastSpace) : head;
  return `${cut.replace(/[\s,;:—–-]+$/, "")}…`;
}
