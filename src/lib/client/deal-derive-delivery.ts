/**
 * Pure view logic for deliveries and their verification: which contracted files arrived, which
 * are missing, and how a verification row points at the files it is about.
 *
 * The delivery grid and the verifier must tell the same story. Ratios are therefore matched with
 * the verifier's own function (real pixel dimensions, never the seller's label), and a missing
 * variant is described with the verifier's own wording.
 */
import { languageName, plural, singleLine, truncate } from "@/lib/domain/format";
import {
  ASPECT_RATIOS,
  LANGUAGES,
  type Artifact,
  type AspectRatio,
  type CheckResult,
  type CopyArtifact,
  type CopySpec,
  type DeliverableSpec,
  type IllustrationArtifact,
  type IllustrationSpec,
  type Language,
  type Submission,
  type VerificationCheck,
  type VerificationReport,
  type VerificationRuleKind,
} from "@/lib/domain/schemas";
import { countWords, detectLanguage } from "@/lib/domain/text-metrics";
import { matchesAspectRatio } from "@/lib/domain/verification";

/* -------------------------------------------------------------------------- */
/*  Rounds                                                                     */
/* -------------------------------------------------------------------------- */

/** "Delivery 1" for the first submission, "Revision 1" for the second, and so on. */
export function submissionLabel(round: number): string {
  return round <= 1 ? "Delivery 1" : `Revision ${round - 1}`;
}

/* -------------------------------------------------------------------------- */
/*  Illustrations                                                              */
/* -------------------------------------------------------------------------- */

export interface IllustrationSlot {
  /** Stable within the page: `<round>:<index>:<ratio>`. Used to link a slot to a verification row. */
  key: string;
  index: number;
  /** The contracted ratio for required slots; the measured (or claimed) one for extras. */
  ratio: string;
  /** Null when the contract requires this variant and it was not delivered. */
  artifact: IllustrationArtifact | null;
  /** False for files the contract did not ask for. */
  required: boolean;
  /** For a missing variant: the verifier's wording, e.g. "1:1 missing on illustration #2". */
  evidence: string | null;
}

export interface IllustrationGroup {
  index: number;
  title: string | null;
  slots: IllustrationSlot[];
  missing: number;
}

function isIllustration(artifact: Artifact): artifact is IllustrationArtifact {
  return artifact.kind === "illustration";
}

function isCopy(artifact: Artifact): artifact is CopyArtifact {
  return artifact.kind === "copy";
}

/** Same sentence the verifier writes into its evidence, so the grid and the report read alike. */
export function missingVariantEvidence(ratio: string, index: number): string {
  return `${ratio} missing on illustration #${index}`;
}

/** The label on a missing tile. */
export function notDeliveredLabel(variant: string): string {
  return `${variant} — not delivered`;
}

function measuredRatio(artifact: IllustrationArtifact): string {
  const known: AspectRatio | undefined = ASPECT_RATIOS.find((ratio) =>
    matchesAspectRatio(artifact.width, artifact.height, ratio),
  );
  if (known !== undefined) return known;
  // The claimed label is seller text: keep it short and on one line.
  const claimed = truncate(singleLine(artifact.aspectRatio), 12);
  return claimed === "" ? "Other" : claimed;
}

/**
 * The delivery as a grid: one group per contracted illustration, one slot per contracted ratio.
 * A slot is filled by a file whose real dimensions match the ratio. Files that fill no slot are
 * appended as extras so nothing the seller sent is hidden.
 */
export function illustrationGroups(spec: IllustrationSpec | null, submission: Submission): IllustrationGroup[] {
  const files = submission.artifacts.filter(isIllustration);
  const highestIndex = files.reduce((max, file) => Math.max(max, file.index), 0);
  const count = Math.max(spec?.count ?? 0, highestIndex);
  const ratios: readonly AspectRatio[] = spec?.aspectRatios ?? [];
  const groups: IllustrationGroup[] = [];

  for (let index = 1; index <= count; index += 1) {
    const own = files.filter((file) => file.index === index);
    const used = new Set<string>();
    const contracted = spec !== null && index <= spec.count;
    const slots: IllustrationSlot[] = [];

    if (contracted) {
      for (const ratio of ratios) {
        const match = own.find((file) => !used.has(file.id) && matchesAspectRatio(file.width, file.height, ratio));
        if (match) used.add(match.id);
        slots.push({
          key: `${submission.round}:${index}:${ratio}`,
          index,
          ratio,
          artifact: match ?? null,
          required: true,
          evidence: match ? null : missingVariantEvidence(ratio, index),
        });
      }
    }
    for (const file of own) {
      if (used.has(file.id)) continue;
      slots.push({
        key: `${submission.round}:${index}:extra:${file.id}`,
        index,
        ratio: measuredRatio(file),
        artifact: file,
        required: false,
        evidence: null,
      });
    }
    if (slots.length === 0) continue;
    const titled = own.find((file) => file.title.trim() !== "");
    groups.push({
      index,
      title: titled ? singleLine(titled.title) : null,
      slots,
      missing: slots.filter((slot) => slot.artifact === null).length,
    });
  }
  return groups;
}

/* -------------------------------------------------------------------------- */
/*  Copy                                                                       */
/* -------------------------------------------------------------------------- */

export interface CopyVariant {
  key: string;
  index: number;
  /** Language tag as contracted, or as the seller labelled an extra text. */
  language: string;
  languageLabel: string;
  artifact: CopyArtifact | null;
  /** Counted the way the verifier counts: by the language the text is actually written in. */
  words: number;
  required: boolean;
}

export interface CopyPiece {
  index: number;
  title: string | null;
  variants: CopyVariant[];
  missing: number;
}

function languageLabel(tag: string): string {
  const known = (LANGUAGES as readonly string[]).includes(tag) ? (tag as Language) : null;
  if (known !== null) return languageName(known);
  const clean = truncate(singleLine(tag), 8);
  return clean === "" ? "Unlabelled" : clean.toUpperCase();
}

function wordsIn(text: string): number {
  const detected = detectLanguage(text).language;
  return countWords(text, detected === "unknown" ? undefined : detected);
}

/** One entry per contracted copy piece, one variant per contracted language. */
export function copyPieces(spec: CopySpec | null, submission: Submission): CopyPiece[] {
  const texts = submission.artifacts.filter(isCopy);
  const highestIndex = texts.reduce((max, text) => Math.max(max, text.index), 0);
  const count = Math.max(spec?.count ?? 0, highestIndex);
  const languages: readonly string[] = spec?.languages ?? [];
  const pieces: CopyPiece[] = [];

  for (let index = 1; index <= count; index += 1) {
    const own = texts.filter((text) => text.index === index);
    const used = new Set<string>();
    const contracted = spec !== null && index <= spec.count;
    const variants: CopyVariant[] = [];

    if (contracted) {
      for (const language of languages) {
        const match = own.find((text) => !used.has(text.id) && text.language.toLowerCase() === language);
        if (match) used.add(match.id);
        variants.push({
          key: `${submission.round}:${index}:${language}`,
          index,
          language,
          languageLabel: languageLabel(language),
          artifact: match ?? null,
          words: match ? wordsIn(match.text) : 0,
          required: true,
        });
      }
    }
    for (const text of own) {
      if (used.has(text.id)) continue;
      variants.push({
        key: `${submission.round}:${index}:extra:${text.id}`,
        index,
        language: text.language,
        languageLabel: languageLabel(text.language.toLowerCase()),
        artifact: text,
        words: wordsIn(text.text),
        required: false,
      });
    }
    if (variants.length === 0) continue;
    const titled = variants.find((variant) => variant.artifact !== null && variant.artifact.title.trim() !== "");
    pieces.push({
      index,
      title: titled?.artifact ? singleLine(titled.artifact.title) : null,
      variants,
      missing: variants.filter((variant) => variant.artifact === null).length,
    });
  }
  return pieces;
}

/* -------------------------------------------------------------------------- */
/*  Summary of one submission                                                  */
/* -------------------------------------------------------------------------- */

export interface DeliveryGrid {
  kind: DeliverableSpec["kind"];
  illustrations: IllustrationGroup[];
  copy: CopyPiece[];
  delivered: number;
  missing: number;
  /** Keys of every required slot that is empty. */
  missingKeys: string[];
}

export function deliveryGrid(spec: DeliverableSpec | null, submission: Submission): DeliveryGrid {
  // Without a spec (never the case once a contract exists) fall back to what the files say they are.
  const kind = spec?.kind ?? (submission.artifacts.some(isCopy) ? "copy" : "illustration");
  const illustrations = kind === "illustration" ? illustrationGroups(spec?.kind === "illustration" ? spec : null, submission) : [];
  const copy = kind === "copy" ? copyPieces(spec?.kind === "copy" ? spec : null, submission) : [];
  const missingKeys = [
    ...illustrations.flatMap((group) => group.slots.filter((slot) => slot.artifact === null).map((slot) => slot.key)),
    ...copy.flatMap((piece) => piece.variants.filter((variant) => variant.artifact === null).map((variant) => variant.key)),
  ];
  return {
    kind,
    illustrations,
    copy,
    delivered: submission.artifacts.length,
    missing: missingKeys.length,
    missingKeys,
  };
}

/** "3 files · 1 missing" for a delivery tab. */
export function deliverySummary(grid: Pick<DeliveryGrid, "delivered" | "missing">): string {
  const files = plural(grid.delivered, "file");
  return grid.missing > 0 ? `${files} · ${grid.missing} missing` : files;
}

/* -------------------------------------------------------------------------- */
/*  Linking verification rows to the delivery                                  */
/* -------------------------------------------------------------------------- */

/** What a verification row points at in the delivery of the same round. */
export interface EvidenceTarget {
  round: number;
  ruleId: string;
  /** Never "pass": only rows that did not pass point at anything. */
  result: Exclude<CheckResult, "pass">;
  artifactIds: string[];
  /** Keys of the missing slots this row is about. */
  missingKeys: string[];
}

/** Rule kinds whose failure is "something required is not there". */
const COVERAGE_KINDS: readonly VerificationRuleKind[] = ["aspect_ratio_coverage", "language_coverage", "deliverable_count"];

export function isCoverageCheck(check: Pick<VerificationCheck, "kind">): boolean {
  return COVERAGE_KINDS.includes(check.kind);
}

/**
 * A row that did not pass points at the files it names, and — for coverage rules — at the
 * empty slots. A passing row points at nothing: highlighting every file would say nothing.
 */
export function evidenceTarget(
  check: Pick<VerificationCheck, "ruleId" | "kind" | "result" | "artifactIds">,
  round: number,
  grid: Pick<DeliveryGrid, "missingKeys"> | null,
): EvidenceTarget | null {
  if (check.result === "pass") return null;
  const missingKeys = grid !== null && isCoverageCheck(check) ? grid.missingKeys : [];
  if (check.artifactIds.length === 0 && missingKeys.length === 0) return null;
  return { round, ruleId: check.ruleId, result: check.result, artifactIds: check.artifactIds, missingKeys };
}

/** The verification row a missing slot belongs to: the coverage rule of that round that did not pass. */
export function checkForMissingSlot(report: Pick<VerificationReport, "checks"> | null): VerificationCheck | null {
  if (report === null) return null;
  const failing = report.checks.filter((check) => check.result !== "pass" && isCoverageCheck(check));
  return (
    failing.find((check) => check.kind === "aspect_ratio_coverage" || check.kind === "language_coverage") ??
    failing[0] ??
    null
  );
}

/* -------------------------------------------------------------------------- */
/*  Verification report                                                        */
/* -------------------------------------------------------------------------- */

export interface CheckTally {
  total: number;
  passed: number;
  failed: number;
  uncertain: number;
}

export function tallyChecks(checks: readonly Pick<VerificationCheck, "result">[]): CheckTally {
  return {
    total: checks.length,
    passed: checks.filter((check) => check.result === "pass").length,
    failed: checks.filter((check) => check.result === "fail").length,
    uncertain: checks.filter((check) => check.result === "uncertain").length,
  };
}

export interface DecisionBanner {
  /** `hold` (amber): nothing captured, the money stays held while the seller revises. */
  tone: "success" | "hold" | "review" | "danger";
  title: string;
  detail: string;
}

/** The sentence under a verification report: what the result means for the money. */
export function decisionBanner(
  report: Pick<VerificationReport, "decision" | "checks" | "round" | "summary">,
  revisionLimit: number,
): DecisionBanner {
  const tally = tallyChecks(report.checks);
  switch (report.decision) {
    case "capture_eligible":
      return {
        tone: "success",
        title: "All conditions verified — eligible for capture",
        detail: `${tally.passed} of ${plural(tally.total, "condition")} passed. PACT may now capture the held payment.`,
      };
    case "revision_required":
      return {
        tone: "hold",
        title: `Not captured. ${plural(tally.failed, "condition")} failed — sent back for revision (${report.round} of ${revisionLimit} used)`,
        detail: `${report.summary} The funds stay held; nothing moves until a delivery passes.`,
      };
    case "human_review":
      return {
        tone: "review",
        title: "Not captured — a human must decide",
        detail: `${report.summary} The funds stay held until you choose.`,
      };
    case "reject":
      return {
        tone: "danger",
        title: `Rejected. ${plural(tally.failed, "condition")} failed and no revisions remain`,
        detail: `${report.summary} The authorization is voided and the funds go back to the payer.`,
      };
    default: {
      const exhaustive: never = report.decision;
      return exhaustive;
    }
  }
}

/** Which submission tab (or report) is shown: the viewer's pick while it is current, else the latest. */
export function selectedRound(
  rounds: readonly number[],
  pick: { round: number; total: number } | null,
): number | null {
  const latest = rounds[rounds.length - 1];
  if (latest === undefined) return null;
  // A pick made before another round arrived is stale: a live run should show the newest work.
  if (pick !== null && pick.total === rounds.length && rounds.includes(pick.round)) return pick.round;
  return latest;
}
