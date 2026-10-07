/**
 * Deterministic measurements of delivered copy: word counts and a language heuristic.
 *
 * These exist so that "each piece is 80–120 words" is checked by arithmetic rather than by
 * asking a model, and so that a seller's CLAIMED language label is never taken at face value.
 */
import type { Language } from "./schemas";

/** Used when the caller gives no (or an unusable) locale, so counts do not depend on the host's locale. */
const DEFAULT_SEGMENTER_LOCALE = "en";

function wordSegmenter(language: string | undefined): Intl.Segmenter {
  if (language !== undefined) {
    try {
      return new Intl.Segmenter(language, { granularity: "word" });
    } catch {
      // A malformed tag (seller-supplied labels are untrusted) falls back to the default locale.
    }
  }
  return new Intl.Segmenter(DEFAULT_SEGMENTER_LOCALE, { granularity: "word" });
}

/**
 * Number of words in `text`. Uses ICU word segmentation, so languages written without spaces
 * (Japanese) are counted by dictionary words rather than as one giant token.
 */
export function countWords(text: string, language?: string): number {
  let words = 0;
  for (const segment of wordSegmenter(language).segment(text)) {
    if (segment.isWordLike) words += 1;
  }
  return words;
}

type LatinLanguage = Exclude<Language, "ja">;

/** Frequent function words per language. Words shared between languages are filtered out below. */
const COMMON_WORDS: Record<LatinLanguage, readonly string[]> = {
  en: [
    "the", "and", "of", "to", "in", "is", "that", "for", "with", "on", "are", "this", "it", "you", "your",
    "our", "from", "by", "as", "at", "be", "or", "an", "we", "can", "will", "has", "have", "not", "every",
    "each", "more", "its", "into", "than", "when", "which", "their", "all",
  ],
  es: [
    "el", "la", "los", "las", "de", "del", "que", "y", "en", "un", "una", "es", "para", "con", "por", "su",
    "sus", "se", "lo", "como", "más", "pero", "al", "nuestro", "nuestra", "tu", "cada", "este", "esta",
    "son", "sin", "muy", "todo", "desde", "hasta", "cuando",
  ],
  fr: [
    "le", "la", "les", "des", "du", "de", "et", "en", "un", "une", "est", "pour", "avec", "que", "qui",
    "dans", "sur", "au", "aux", "ce", "cette", "vous", "votre", "nos", "notre", "plus", "pas", "par",
    "chaque", "sont", "sans", "très", "tout", "où", "à",
  ],
  de: [
    "der", "die", "das", "und", "ist", "mit", "für", "von", "den", "dem", "ein", "eine", "zu", "im", "auf",
    "nicht", "sie", "wir", "ihr", "ihre", "sich", "auch", "bei", "wird", "oder", "aus", "jede", "jeder",
    "unser", "unsere", "des", "einen", "einem", "durch", "nach",
  ],
};

/** Characters that are common in one language and rare in the others; each counts like a stop word. */
const DIACRITIC_HINTS: Record<LatinLanguage, RegExp | null> = {
  en: null,
  es: /[\u00f1\u00bf\u00a1]/g,
  fr: /[\u00e7\u0153\u00e8\u00ea\u00e0\u00f9]/g,
  de: /[\u00e4\u00f6\u00fc\u00df]/g,
};

const LATIN_LANGUAGES = ["en", "es", "fr", "de"] as const satisfies readonly LatinLanguage[];

/**
 * Only words that belong to exactly one language count as evidence: "la", "de" or "un" say
 * "Romance language" but cannot tell Spanish from French.
 */
function distinctiveWords(language: LatinLanguage): ReadonlySet<string> {
  const others = LATIN_LANGUAGES.filter((other) => other !== language).flatMap((other) => COMMON_WORDS[other]);
  return new Set(COMMON_WORDS[language].filter((word) => !others.includes(word)));
}

const STOP_WORDS: Record<LatinLanguage, ReadonlySet<string>> = {
  en: distinctiveWords("en"),
  es: distinctiveWords("es"),
  fr: distinctiveWords("fr"),
  de: distinctiveWords("de"),
};

const KANA = /[\u3040-\u30ff\uff66-\uff9f]/g;
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/g;
const LATIN_LETTER = /[A-Za-z\u00c0-\u024f]/g;
const LATIN_WORD = /[a-z\u00c0-\u024f]+/g;

/** Below this share of distinctive words, a text is too short or too unusual to call with confidence. */
const TYPICAL_STOP_WORD_SHARE = 0.15;
/** Japanese prose mixes in Latin brand names; this much kana/kanji is already decisive. */
const JAPANESE_SCRIPT_SHARE = 0.3;

function occurrences(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const UNKNOWN = { language: "unknown", confidence: 0 } as const;

function detectLatinLanguage(text: string): { language: Language | "unknown"; confidence: number } {
  const lower = text.toLowerCase();
  const words = lower.match(LATIN_WORD) ?? [];
  if (words.length === 0) return UNKNOWN;

  const scores = LATIN_LANGUAGES.map((language) => {
    const stopWords = STOP_WORDS[language];
    const hint = DIACRITIC_HINTS[language];
    const score = words.filter((word) => stopWords.has(word)).length + (hint ? occurrences(lower, hint) : 0);
    return { language, score };
  }).sort((a, b) => b.score - a.score);

  const [best, runnerUp] = scores;
  if (best.score === 0 || best.score === runnerUp.score) return UNKNOWN;

  // Confidence needs both a clear lead over the runner-up and enough evidence for the text length.
  const margin = (best.score - runnerUp.score) / best.score;
  const coverage = Math.min(1, best.score / words.length / TYPICAL_STOP_WORD_SHARE);
  return { language: best.language, confidence: round2(margin * coverage) };
}

/** A quoted phrase shorter than this says too little about the text around it to be worth removing. */
const MIN_IGNORED_PHRASE_CHARS = 12;

/**
 * Remove verbatim, case-insensitive occurrences of `phrases` — or, for a phrase that was cut
 * short where it is quoted, of its longest leading part that occurs.
 */
function withoutPhrases(text: string, phrases: readonly string[]): string {
  let remaining = text;
  for (const phrase of phrases) {
    const wanted = phrase.replace(/\s+/g, " ").trim().replace(/[.\u3002\u2026]+$/, "").toLowerCase();
    for (let length = wanted.length; length >= MIN_IGNORED_PHRASE_CHARS; length -= 1) {
      const part = wanted.slice(0, length).trimEnd();
      if (part.length < MIN_IGNORED_PHRASE_CHARS) break;
      if (!remaining.toLowerCase().includes(part)) continue;
      remaining = removeAll(remaining, part);
      break;
    }
  }
  return remaining;
}

/** Every occurrence of `lowerPart` (already lower-cased) replaced by a space, whatever its case in `text`. */
function removeAll(text: string, lowerPart: string): string {
  const lowered = text.toLowerCase();
  // Lower-casing changes the length of a few exotic characters; indices must fit the string they cut.
  const source = lowered.length === text.length ? text : lowered;
  let out = "";
  let from = 0;
  for (let at = lowered.indexOf(lowerPart); at !== -1; at = lowered.indexOf(lowerPart, from)) {
    out += `${source.slice(from, at)} `;
    from = at + lowerPart.length;
  }
  return out + source.slice(from);
}

/**
 * Best-effort language of `text` among the languages PACT contracts can name.
 * Heuristic by design: script share decides Japanese, stop-word frequency decides between the
 * Latin-script languages. Callers must treat a low confidence as "unknown".
 *
 * `ignore` names phrases the text is expected to QUOTE in another language — the contract's own
 * subject, typically. A Japanese tagline that names a long English product would otherwise be
 * measured as mostly Latin letters and called English with full confidence.
 */
export function detectLanguage(
  input: string,
  options: { ignore?: readonly string[] } = {},
): { language: Language | "unknown"; confidence: number } {
  const text = options.ignore === undefined || options.ignore.length === 0 ? input : withoutPhrases(input, options.ignore);
  const kana = occurrences(text, KANA);
  const han = occurrences(text, HAN);
  const latin = occurrences(text, LATIN_LETTER);
  const letters = kana + han + latin;
  if (letters === 0) return UNKNOWN;

  const japaneseShare = (kana + han) / letters;
  if (japaneseShare >= JAPANESE_SCRIPT_SHARE) {
    // Kanji alone could equally be Chinese; kana is what makes text unmistakably Japanese.
    const confidence = kana > 0 ? 0.5 + japaneseShare / 2 : japaneseShare / 2;
    return { language: "ja", confidence: round2(Math.min(1, confidence)) };
  }
  return detectLatinLanguage(text);
}
