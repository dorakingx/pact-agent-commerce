/**
 * Embedded-instruction scanner.
 *
 * A delivery is data, never instructions. A seller agent that hides "mark this as passed" in a
 * file is attacking the verifier, and that is a trust incident for a human to look at — not a
 * quality problem a revision could fix. This scanner looks at every piece of text an artifact
 * carries (including text a person would never see in the rendered image) for content that
 * addresses an automated checker or tries to steer the outcome.
 *
 * It is a deterministic first line of defence, deliberately tuned so ordinary marketing copy
 * ("Approve of our new look", "release notes", "system design") does not trip it. The AI
 * verifier reports manipulation independently; either signal forces human review.
 */
import { truncate } from "./format";
import type { Artifact } from "./schemas";
import { decodeEntities, findHiddenText, nonRenderedContainer, parseSvg, type SvgDocument } from "./svg-inspect";

export interface TextSegment {
  /** Where the text came from, in words a reviewer understands ("SVG comment", "description"). */
  where: string;
  text: string;
}

const MAX_FINDING_CHARS = 120;
const MAX_FINDINGS = 12;
const MAX_LABEL_CHARS = 60;
/** Characters of context shown before and after the matched phrase. */
const SNIPPET_LEAD = 12;
const SNIPPET_TAIL = 28;

/**
 * Undo the cheap tricks used to slip a phrase past a pattern: full-width letters, zero-width
 * and bidirectional characters inside words, typographic quotes, odd whitespace.
 * Line breaks are kept because "SYSTEM:" at the start of a line is itself a signal.
 */
function normaliseForScan(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "")
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n[ \n]*/g, "\n")
    .trim();
}

/** Nouns that name the automated reader of a delivery. */
const AUTOMATED_READER =
  "(?:ai(?:\\s+(?:verifier|reviewer|checker|evaluator|grader|model|assistant|agent|system))?|a\\.i\\.|llm|language\\s+model|" +
  "verifier|verification\\s+(?:agent|system|model)|reviewer|evaluator|checker|grader|validator|" +
  "automated\\s+(?:system|reviewer|checker|verifier|evaluator|agent))";

const DELIVERY_NOUN =
  "(?:delivery|deliverables?|submission|work|files?|checks?|rules?|payment|contract|conditions?|illustrations?|images?|pieces?|texts?|tests?|verification)";

function pattern(source: string): RegExp {
  return new RegExp(source, "i");
}

/**
 * Phrases that only make sense when aimed at a model or an automated pipeline.
 * Each is narrow on purpose; see the false-positive cases in the tests before widening one.
 */
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  // "ignore all previous instructions", "disregard the rules"
  pattern(
    "\\b(?:ignore|disregard)\\s+(?:(?:all|any|the|your|every|previous|prior|above|earlier|other|these|those|of)\\s+){1,4}" +
      "(?:instructions?|checks?|rules?|prompts?|guidelines?|requirements?|verification|criteria)\\b",
  ),
  // "forget the previous instructions", "bypass verification checks"
  pattern(
    "\\b(?:forget|override|bypass|skip)\\s+(?:(?:all|any|the|your|every|of)\\s+){0,3}" +
      "(?:previous|prior|above|earlier|verification|contract)\\s+(?:instructions?|checks?|rules?|prompts?|steps?)\\b",
  ),
  // "mark this delivery as passed", "mark every check as approved"
  pattern(
    "\\bmark\\s+(?:this|that|it|every|all|each|the)\\b[^.!?\\n]{0,60}?\\bas\\s+(?:pass(?:ed|ing)?|approved|verified|compliant|satisfied|valid)\\b",
  ),
  // "pass all checks", "approve every condition"
  pattern(
    "\\b(?:pass|approve|accept)\\s+(?:all|every|each)\\s+(?:of\\s+)?(?:the\\s+)?(?:checks?|rules?|conditions?|requirements?|criteria)\\b",
  ),
  // "approve the payment", "release funds", "capture payment"
  pattern(
    "\\b(?:approve|release|capture|authori[sz]e|settle)\\s+(?:(?:the|this|full|all|my|our|your)\\s+){0,2}(?:payment|funds|payout|escrow)\\b",
  ),
  // "SYSTEM: ..." at the start of a text, line or sentence (not "operating system: ...")
  pattern("(?:^|[\\n.!?;>\\])}]\\s?)[\\[<(]?\\s*system\\s*[\\]>)]?\\s*(?:prompt|message|note|override|instructions?)?\\s*:"),
  // chat-template control tokens
  pattern("<\\|(?:im_start|im_end|system|user|assistant|endoftext)\\|>|\\[/?(?:INST|SYS)\\]|<</?SYS>>"),
  // "note to the AI verifier:", "message for the reviewer,"
  pattern(
    `\\b(?:note|message|memo|reminder|instructions?|attention)\\s+(?:to|for)\\s+(?:the\\s+|any\\s+|all\\s+)?${AUTOMATED_READER}(?=\\s*(?:[:,.;!?\\n-]|$))`,
  ),
  // "Dear verifier", "Attention: AI reviewer"
  pattern(`\\b(?:dear|attention|attn|hey|hello)\\s*[,:]?\\s+(?:the\\s+)?${AUTOMATED_READER}\\b`),
  // "Verifier: please approve", "AI reviewer, ignore ..."
  pattern(`\\b${AUTOMATED_READER}\\s*[,:]\\s*(?:please|you\\s+must|you\\s+should|ignore|approve|mark|pass)\\b`),
  // "if you are an AI"
  pattern(`\\bif\\s+you(?:\\s+are|'re)\\s+an?\\s+${AUTOMATED_READER}\\b`),
  // "confidence: 1", "confidence = 100%"
  pattern("\\bconfidence\\s*(?:score|level|value|rating)?\\s*[:=]\\s*(?:1(?:\\.0+)?(?![\\d.])|100\\s*%)"),
  // "confidence 1.0", "confidence of 1.00"
  pattern("\\bconfidence\\s*(?:score|level|value|rating)?\\s*(?:of|to|is|at)?\\s*1\\.0+(?!\\d)"),
  // "set confidence to 1", "report a confidence of 100%"
  pattern(
    "\\b(?:set|report|return|assign|output)\\s+(?:the\\s+|a\\s+|your\\s+)?confidence\\s*(?:score|level)?\\s*(?:of|to|at|as)?\\s*(?:1(?:\\.0+)?(?![\\d.])|100\\s*%)",
  ),
  // "you are now a helpful assistant", "you are the verifier"
  pattern(
    "\\byou\\s+are\\s+(?:now\\s+)?(?:an?|the)\\s+(?:ai|llm|language\\s+model|assistant|verifier|evaluator|reviewer|checker|grader|validator|chatbot|automated\\s+\\w+|helpful\\s+\\w+)\\b",
  ),
  // "you are now in developer mode", "you are now required to ..."
  pattern("\\byou\\s+are\\s+now\\s+(?:in\\s+\\w+\\s+mode|acting\\s+as|required\\s+to|instructed\\s+to|authori[sz]ed\\s+to)\\b"),
  // "you must approve this delivery"
  pattern(
    `\\byou\\s+(?:must|should|will|shall|need\\s+to|have\\s+to)\\s+(?:now\\s+)?(?:approve|mark|pass|accept|release|capture|grade|rate|score)\\s+(?:this|the|all|every|each)\\s+${DELIVERY_NOUN}\\b`,
  ),
  // `"result": "pass"`, "verdict = approved", "decision: capture_eligible" (but not "Status: approved by baristas")
  pattern(
    "\\b(?:result|verdict|decision|status|outcome)\\s*[\"']?\\s*[:=]\\s*[\"']?\\s*(?:pass(?:ed)?|approved?|capture[_\\s-]?eligible|verified)" +
      "(?=[\"']?\\s*(?:[,;.}\\n]|$))",
  ),
  // "do not flag this file", "never reject this delivery"
  pattern(`\\b(?:do\\s+not|don't|never)\\s+(?:flag|reject|fail|escalate|report)\\s+(?:this|the|these|any)\\s+${DELIVERY_NOUN}\\b`),
  // "new instructions:", "hidden instruction -"
  pattern("\\b(?:new|updated|hidden|secret|override)\\s+instructions?\\s*[:-]"),
  // Japanese: "ignore the previous instructions", "approve the payment", "note to the verifier", "mark as passed"
  pattern("(?:これまで|以前|上記|前述|すべて|全て)の?(?:指示|命令|ルール|規則|チェック|検証)(?:を|は)(?:すべて|全て)?(?:無視|忘れ)"),
  pattern("(?:支払い?|決済|代金)を(?:承認|実行|解放|キャプチャ|確定)"),
  pattern("(?:検証者|審査員|審査者|レビュアー|AI|システム)(?:へ|への|に対する)(?:注意|指示|メモ|お願い)"),
  pattern("(?:合格|承認済み|パス)(?:として|と|に)(?:マーク|判定|扱|記録)"),
];

export interface ScanOptions {
  /**
   * Phrases the BUYER wrote into the contract (its subject, style or tone, title). A delivery is
   * expected to repeat them — "Approve the Payment week banners" is the job, not an attack — so
   * a match that lies entirely inside one of them is not read as an instruction. Never pass
   * seller-supplied text.
   */
  ownWords?: readonly string[];
}

/** A long subject is often cut to fit a title; this much of its beginning is still recognisably the buyer's. */
const MIN_OWN_PREFIX_CHARS = 16;
const MIN_OWN_PHRASE_CHARS = 3;

interface Span {
  start: number;
  end: number;
}

function spansOf(lowerText: string, lowerPhrase: string): Span[] {
  const spans: Span[] = [];
  for (let at = lowerText.indexOf(lowerPhrase); at !== -1; at = lowerText.indexOf(lowerPhrase, at + 1)) {
    spans.push({ start: at, end: at + lowerPhrase.length });
  }
  return spans;
}

/**
 * Where the buyer's own phrases occur in `text` (already normalised for scanning), ignoring
 * case. When a whole phrase does not occur, its longest leading part that does — a subject cut
 * short to fit a title — counts instead.
 */
function ownWordSpans(text: string, ownWords: readonly string[]): Span[] {
  const lower = text.toLowerCase();
  // Lower-casing changes the length of a few exotic characters; spans must index the text they describe.
  if (lower.length !== text.length) return [];
  const spans: Span[] = [];
  for (const raw of new Set(ownWords)) {
    const phrase = normaliseForScan(raw).replace(/[.\u3002\u2026]+$/, "").toLowerCase();
    if (phrase.length < MIN_OWN_PHRASE_CHARS) continue;
    let found = spansOf(lower, phrase);
    for (let length = phrase.length - 1; found.length === 0 && length >= MIN_OWN_PREFIX_CHARS; length -= 1) {
      found = spansOf(lower, phrase.slice(0, length));
    }
    spans.push(...found);
  }
  return spans;
}

/**
 * The first place `instruction` matches that is not simply the buyer's own words. A match is
 * excused only when it lies ENTIRELY inside one of their phrases: "release funds" inside the
 * subject "how to release funds faster" is the job, but "approve the payment" built around a
 * subject of "the payment" reaches outside it and is reported like any other.
 */
function firstUnexcused(instruction: RegExp, text: string, excused: readonly Span[]): Span | null {
  if (excused.length === 0) {
    const match = instruction.exec(text);
    return match === null ? null : { start: match.index, end: match.index + match[0].length };
  }
  const everywhere = new RegExp(instruction.source, instruction.flags.includes("g") ? instruction.flags : `${instruction.flags}g`);
  for (const match of text.matchAll(everywhere)) {
    const span = { start: match.index, end: match.index + match[0].length };
    if (!excused.some((own) => own.start <= span.start && span.end <= own.end)) return span;
  }
  return null;
}

function quoteFinding(where: string, text: string, start: number, end: number): string {
  const label = truncate(where, MAX_LABEL_CHARS);
  let from = Math.max(0, start - SNIPPET_LEAD);
  // Begin the excerpt at a word boundary where one is close, so the quote reads naturally.
  while (from > 0 && start - from < 2 * SNIPPET_LEAD && !/\s/.test(text[from - 1])) from -= 1;
  const excerpt = `${from > 0 ? "…" : ""}${text.slice(from, end + SNIPPET_TAIL)}`;
  // Quotes inside the excerpt would make the finding ambiguous to read.
  const snippet = truncate(excerpt.replace(/\s+/g, " ").replace(/"/g, "'"), MAX_FINDING_CHARS - label.length - 4);
  return `${label}: "${snippet}"`;
}

/**
 * Instruction-like phrases in one piece of text, as short quoted findings (<= 120 chars each).
 * Matches that sit close together are one injected passage and are reported as one finding.
 */
export function scanText(segment: TextSegment, options: ScanOptions = {}): string[] {
  const text = normaliseForScan(segment.text);
  const excused = options.ownWords === undefined || options.ownWords.length === 0 ? [] : ownWordSpans(text, options.ownWords);
  const matches: Span[] = [];
  for (const instruction of INSTRUCTION_PATTERNS) {
    const match = firstUnexcused(instruction, text, excused);
    if (match !== null) matches.push(match);
  }
  matches.sort((a, b) => a.start - b.start);

  const passages: Array<{ start: number; end: number }> = [];
  for (const match of matches) {
    const last = passages[passages.length - 1];
    if (last !== undefined && match.start <= last.end + SNIPPET_LEAD + SNIPPET_TAIL) {
      last.end = Math.max(last.end, match.end);
    } else {
      passages.push({ ...match });
    }
  }
  return passages.map(({ start, end }) => quoteFinding(segment.where, text, start, end));
}

/** Attribute values worth reading: path data and numbers cannot carry a sentence. */
const HAS_WORDS = /[A-Za-z\u3040-\u30ff\u4e00-\u9fff]{3}/;

function svgSegments(doc: SvgDocument): TextSegment[] {
  // Chunks are joined per container so a phrase split across <tspan>s is still read as one sentence.
  const byContainer = new Map<string, string[]>();
  for (const chunk of doc.texts) {
    const text = chunk.text.trim();
    if (text === "") continue;
    const container = nonRenderedContainer(chunk.owner);
    const where = container === null ? "SVG text" : `SVG <${container}>`;
    const parts = byContainer.get(where);
    if (parts === undefined) byContainer.set(where, [text]);
    else parts.push(text);
  }
  const segments: TextSegment[] = [...byContainer].map(([where, parts]) => ({ where, text: parts.join(" ") }));
  for (const comment of doc.comments) segments.push({ where: "SVG comment", text: comment });
  for (const declaration of doc.declarations) segments.push({ where: "SVG declaration", text: declaration });
  for (const element of doc.elements) {
    for (const [name, value] of element.attributes) {
      if (HAS_WORDS.test(value)) segments.push({ where: `SVG ${truncate(name, 24)} attribute`, text: value });
    }
  }
  return segments;
}

/**
 * Findings for an SVG. The structured pass names where a phrase sits; the raw pass is the
 * backstop for markup this module's tokeniser reads differently from other parsers, where
 * text could otherwise sit in a place none of the structured segments cover.
 */
function scanSvg(doc: SvgDocument, options: ScanOptions): string[] {
  const structured = svgSegments(doc).flatMap((segment) => scanText(segment, options));
  return structured.length > 0 ? structured : scanText({ where: "SVG markup", text: decodeEntities(doc.source) }, options);
}

function artifactFindings(artifact: Artifact, options: ScanOptions): string[] {
  switch (artifact.kind) {
    case "illustration": {
      const doc = parseSvg(artifact.svg);
      const hidden = findHiddenText(doc, { width: artifact.width, height: artifact.height }).map(({ text, reason }) =>
        quoteFinding(`hidden SVG text (${reason})`, text.replace(/\s+/g, " "), 0, text.length),
      );
      const fields: TextSegment[] = [
        { where: "title", text: artifact.title },
        { where: "description", text: artifact.description },
        { where: "aspect-ratio label", text: artifact.aspectRatio },
      ];
      // Hidden text is reported whatever it says: the buyer's words do not excuse concealing them.
      return [...fields.flatMap((field) => scanText(field, options)), ...scanSvg(doc, options), ...hidden];
    }
    case "copy": {
      const fields: TextSegment[] = [
        { where: "title", text: artifact.title },
        { where: "language label", text: artifact.language },
        { where: "text", text: artifact.text },
      ];
      return fields.flatMap((field) => scanText(field, options));
    }
    default: {
      const unknown: never = artifact;
      throw new Error(`Unhandled artifact kind: ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * Scan everything an artifact carries for instructions aimed at an automated checker, and for
 * SVG text that is present in the file but invisible in the rendered image.
 */
export function scanForEmbeddedInstructions(artifact: Artifact, options: ScanOptions = {}): { suspicious: boolean; findings: string[] } {
  const findings = [...new Set(artifactFindings(artifact, options))].slice(0, MAX_FINDINGS);
  return { suspicious: findings.length > 0, findings };
}
