/**
 * Delivery verification: the deterministic checks, and the decision rule that turns a set of
 * checks (deterministic + AI) into capture / revision / human review / reject.
 *
 * The AI verifier only contributes CHECKS. Whether money may move is decided here, by rules
 * that are biased to fail closed: a rule nobody evaluated can never pass, a low-confidence
 * result goes to a human, and any sign of manipulation stops automation entirely.
 */
import {
  assertNever,
  deliverableCountLabel,
  formatDuration,
  formatUtcTimestamp,
  joinList,
  parseTimestamp,
  plural,
  singleLine,
  truncate,
} from "./format";
import { scanForEmbeddedInstructions, scanText } from "./injection-scan";
import {
  ASPECT_RATIOS,
  VerificationReportSchema,
  type Artifact,
  type AspectRatio,
  type CheckResult,
  type Contract,
  type CopyArtifact,
  type CopySpec,
  type DeliverableSpec,
  type IllustrationArtifact,
  type IllustrationSpec,
  type SignedContract,
  type Submission,
  type VerificationCheck,
  type VerificationDecision,
  type VerificationReport,
  type VerificationRule,
  type VerificationRuleKind,
} from "./schemas";
import { parseSvg, svgDimensionProblems, svgSafetyProblems } from "./svg-inspect";
import { countWords, detectLanguage } from "./text-metrics";

export { scanForEmbeddedInstructions } from "./injection-scan";
export { countWords, detectLanguage } from "./text-metrics";

/** Relative tolerance when matching real dimensions to a contracted aspect ratio (1%). */
export const RATIO_TOLERANCE = 0.01;
/**
 * 1010/1000 is exactly 1% off 1:1, but evaluates to 0.010000000000000009 in binary floating
 * point. This slack keeps the documented boundary ("within 1%, inclusive") true in practice.
 */
const RATIO_SLACK = 1e-9;

const EVIDENCE_MAX = 400;
const EXPLANATION_MAX = 600;
const SUMMARY_MAX = 400;
/** Findings quoted in the evidence line; the rest are counted. */
const MAX_QUOTED_FINDINGS = 3;

/* -------------------------------------------------------------------------- */
/*  Aspect ratios                                                              */
/* -------------------------------------------------------------------------- */

/** "16:9" -> 1.777…; null when the label is not two positive numbers separated by a colon. */
export function parseAspectRatio(label: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(label);
  if (match === null) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : null;
}

function ratioMatches(width: number, height: number, ratio: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  return Math.abs(width / height - ratio) / ratio <= RATIO_TOLERANCE + RATIO_SLACK;
}

/**
 * Whether real pixel dimensions satisfy a contracted ratio. Always computed from the measured
 * width and height — never from the label the seller attached to the file.
 */
export function matchesAspectRatio(width: number, height: number, label: AspectRatio): boolean {
  const ratio = parseAspectRatio(label);
  return ratio !== null && ratioMatches(width, height, ratio);
}

/* -------------------------------------------------------------------------- */
/*  Deterministic checks                                                       */
/* -------------------------------------------------------------------------- */

interface Outcome {
  result: CheckResult;
  evidence: string;
  explanation: string;
  artifactIds: string[];
}

function isIllustration(artifact: Artifact): artifact is IllustrationArtifact {
  return artifact.kind === "illustration";
}

function isCopy(artifact: Artifact): artifact is CopyArtifact {
  return artifact.kind === "copy";
}

/** Seller-supplied language labels are untrusted; only echo ones that look like a language tag. */
function languageTag(artifact: CopyArtifact): string {
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(artifact.language) ? artifact.language.toLowerCase() : "unlabelled";
}

function artifactLabel(artifact: Artifact): string {
  switch (artifact.kind) {
    case "illustration":
      return `illustration #${artifact.index}`;
    case "copy":
      return `piece #${artifact.index} (${languageTag(artifact)})`;
    default:
      return assertNever(artifact);
  }
}

function notEvaluated(explanation: string): Outcome {
  return { result: "uncertain", evidence: "not evaluated", explanation, artifactIds: [] };
}

function checkDeliverableCount(spec: DeliverableSpec, submission: Submission): Outcome {
  const wanted = spec.count;
  const matching = submission.artifacts.filter((artifact) => artifact.kind === spec.kind);
  const inRange = matching.filter((artifact) => artifact.index >= 1 && artifact.index <= wanted);
  const present = new Set(inRange.map((artifact) => artifact.index));
  const missing: number[] = [];
  for (let index = 1; index <= wanted; index += 1) {
    if (!present.has(index)) missing.push(index);
  }
  const extras = new Set(matching.filter((artifact) => artifact.index > wanted).map((artifact) => artifact.index)).size;
  const supplied = `${present.size} of ${wanted} supplied`;
  const label = deliverableCountLabel(spec.kind, wanted);
  const artifactIds = inRange.map((artifact) => artifact.id);

  if (missing.length === 0) {
    return {
      result: "pass",
      evidence: extras > 0 ? `${supplied} (plus ${extras} beyond the contracted count)` : supplied,
      explanation: `The delivery contains all ${label} the contract requires.`,
      artifactIds,
    };
  }
  return {
    result: "fail",
    evidence: `${supplied}; missing ${joinList(missing.map((index) => `#${index}`))}`,
    explanation: `The contract requires ${label}, and ${missing.length === 1 ? "one was" : `${missing.length} were`} not delivered.`,
    artifactIds,
  };
}

function knownRatioFor(width: number, height: number): AspectRatio | null {
  return ASPECT_RATIOS.find((ratio) => matchesAspectRatio(width, height, ratio)) ?? null;
}

function labelMatchesDimensions(artifact: IllustrationArtifact): boolean {
  const claimed = parseAspectRatio(artifact.aspectRatio);
  return claimed !== null && ratioMatches(artifact.width, artifact.height, claimed);
}

function checkAspectRatios(spec: IllustrationSpec, submission: Submission): Outcome {
  const illustrations = submission.artifacts.filter(isIllustration);
  const missing: Array<{ index: number; ratio: AspectRatio }> = [];
  for (let index = 1; index <= spec.count; index += 1) {
    for (const ratio of spec.aspectRatios) {
      const delivered = illustrations.some(
        (artifact) => artifact.index === index && matchesAspectRatio(artifact.width, artifact.height, ratio),
      );
      if (!delivered) missing.push({ index, ratio });
    }
  }

  const mislabelled = illustrations.filter((artifact) => !labelMatchesDimensions(artifact));
  const mislabelNotes = mislabelled.map((artifact) => {
    const actual = knownRatioFor(artifact.width, artifact.height);
    const label = truncate(singleLine(artifact.aspectRatio), 12) || "nothing";
    return `${artifactLabel(artifact)} file labelled ${label} measures ${artifact.width}×${artifact.height}${actual === null ? "" : ` (${actual})`}`;
  });
  const required = spec.count * spec.aspectRatios.length;

  if (missing.length === 0) {
    return {
      result: "pass",
      evidence: [`${required} of ${required} required variants supplied`, ...mislabelNotes].join("; "),
      explanation: `Ratios were computed from each file's real dimensions. Every illustration is present in ${joinList(spec.aspectRatios)}.`,
      artifactIds: illustrations.filter((artifact) => artifact.index <= spec.count).map((artifact) => artifact.id),
    };
  }
  const incomplete = new Set(missing.map((gap) => gap.index));
  const offending = illustrations.filter((artifact) => incomplete.has(artifact.index) || mislabelled.includes(artifact));
  return {
    result: "fail",
    evidence: [...missing.map((gap) => `${gap.ratio} missing on illustration #${gap.index}`), ...mislabelNotes].join("; "),
    explanation: `Ratios are computed from each file's real dimensions, not from the seller's labels. ${plural(
      missing.length,
      "required variant",
    )} ${missing.length === 1 ? "is" : "are"} missing.`,
    artifactIds: offending.map((artifact) => artifact.id),
  };
}

function formatProblems(artifact: Artifact): string[] {
  if (!isIllustration(artifact)) return ["is not an SVG illustration"];
  // The type says "svg", but this value was read back from storage: check it anyway.
  if ((artifact.format as string) !== "svg") return ["is not in SVG format"];
  const doc = parseSvg(artifact.svg);
  return [...svgSafetyProblems(doc), ...svgDimensionProblems(doc, artifact, RATIO_TOLERANCE + RATIO_SLACK)];
}

function checkValidFormat(submission: Submission): Outcome {
  const { artifacts } = submission;
  if (artifacts.length === 0) {
    return {
      result: "fail",
      evidence: "no files supplied",
      explanation: "There is nothing to validate because the delivery contains no files.",
      artifactIds: [],
    };
  }
  const invalid = artifacts
    .map((artifact) => ({ artifact, problems: formatProblems(artifact) }))
    .filter((entry) => entry.problems.length > 0);

  if (invalid.length === 0) {
    return {
      result: "pass",
      evidence: `${artifacts.length} of ${artifacts.length} files are well-formed SVG with consistent dimensions and no active content`,
      explanation: "Every file is a static, self-contained SVG whose declared size matches the delivery record.",
      artifactIds: artifacts.map((artifact) => artifact.id),
    };
  }
  return {
    result: "fail",
    evidence: invalid.map(({ artifact, problems }) => `${artifactLabel(artifact)} ${problems.join(", ")}`).join("; "),
    explanation: `${plural(invalid.length, "file")} of ${artifacts.length} ${invalid.length === 1 ? "is" : "are"} not valid, safe SVG. Files must be well-formed, declare their real size, and contain no scripts, event handlers or external references.`,
    artifactIds: invalid.map(({ artifact }) => artifact.id),
  };
}

function checkDeadline(contract: Contract, submission: Submission): Outcome {
  const submittedMs = parseTimestamp(submission.submittedAt);
  const deadlineMs = parseTimestamp(contract.deadline);
  if (submittedMs === null || deadlineMs === null) {
    return notEvaluated("The submission time or the contract deadline is not a valid timestamp, so lateness could not be determined.");
  }
  const explanation = `Submitted at ${formatUtcTimestamp(submission.submittedAt)}; the contract deadline is ${formatUtcTimestamp(contract.deadline)}.`;
  if (submittedMs > deadlineMs) {
    return {
      result: "fail",
      evidence: `delivered ${formatDuration(submittedMs - deadlineMs)} after the deadline`,
      explanation,
      artifactIds: [],
    };
  }
  return {
    result: "pass",
    evidence:
      submittedMs === deadlineMs
        ? "delivered exactly at the deadline"
        : `delivered ${formatDuration(deadlineMs - submittedMs)} before the deadline`,
    explanation,
    artifactIds: [],
  };
}

function checkWordCount(spec: CopySpec, submission: Submission): Outcome {
  const texts = submission.artifacts.filter(isCopy);
  const range = `${spec.minWords}–${spec.maxWords}`;
  if (texts.length === 0) {
    return {
      result: "fail",
      evidence: "no copy texts supplied",
      explanation: `The contract requires each piece to be ${range} words, but the delivery contains no text.`,
      artifactIds: [],
    };
  }
  const measured = texts.map((artifact) => {
    // Segment by the language the text is actually written in, not the one the seller claims.
    const detected = detectLanguage(artifact.text, { ignore: [spec.subject] }).language;
    return { artifact, words: countWords(artifact.text, detected === "unknown" ? undefined : detected) };
  });
  const outOfRange = measured.filter(({ words }) => words < spec.minWords || words > spec.maxWords);

  if (outOfRange.length === 0) {
    const counts = measured.map(({ words }) => words);
    return {
      result: "pass",
      evidence: `all ${plural(texts.length, "text")} within ${range} words (shortest ${Math.min(...counts)}, longest ${Math.max(...counts)})`,
      explanation: `Words were counted in every delivered text; each is within the contracted ${range}.`,
      artifactIds: texts.map((artifact) => artifact.id),
    };
  }
  return {
    result: "fail",
    evidence: `${joinList(
      outOfRange.map(({ artifact, words }) => `${artifactLabel(artifact)} has ${plural(words, "word")}`),
    )}; contract requires ${range}`,
    explanation: `${plural(outOfRange.length, "text")} of ${texts.length} ${outOfRange.length === 1 ? "is" : "are"} outside the contracted length of ${range} words.`,
    artifactIds: outOfRange.map(({ artifact }) => artifact.id),
  };
}

/**
 * What the buyer's side wrote into the contract and a delivery is expected to echo: the title
 * and each deliverable's subject and style or tone. A brief about "how to release funds faster"
 * must not make an honest delivery look like an attempt to steer the verifier. Only the buyer
 * side writes these fields, so a seller cannot use them to smuggle text past the scan.
 */
export function contractOwnWords(contract: Contract): string[] {
  const words = [contract.title];
  for (const spec of contract.deliverables) {
    words.push(spec.subject);
    const manner = spec.kind === "illustration" ? spec.style : spec.tone;
    if (manner !== null) words.push(manner);
  }
  return words;
}

function checkEmbeddedInstructions(contract: Contract, submission: Submission): Outcome {
  const options = { ownWords: contractOwnWords(contract) };
  const flagged = submission.artifacts
    .map((artifact) => ({ artifact, findings: scanForEmbeddedInstructions(artifact, options).findings }))
    .filter((entry) => entry.findings.length > 0);
  // The delivery note is read by the same verifier, so it gets the same scrutiny as the files.
  const noteFindings = scanText({ where: "delivery note", text: submission.note }, options);
  const findings = [
    ...flagged.flatMap(({ artifact, findings: found }) => found.map((finding) => `${artifactLabel(artifact)} ${finding}`)),
    ...noteFindings,
  ];

  if (findings.length === 0) {
    return {
      result: "pass",
      evidence: `no instruction-like or hidden text in ${plural(submission.artifacts.length, "file")} or the delivery note`,
      explanation: "All text carried by the delivery was scanned, including text that is not visible when the files are rendered.",
      artifactIds: [],
    };
  }
  const quoted = findings.slice(0, MAX_QUOTED_FINDINGS).join("; ");
  const more = findings.length - MAX_QUOTED_FINDINGS;
  return {
    result: "fail",
    evidence: more > 0 ? `${quoted} (+${more} more)` : quoted,
    explanation:
      "The delivery contains text that addresses an automated checker or is hidden from human view. Deliverables are data, never instructions, so this is escalated to a human instead of being sent back for revision.",
    artifactIds: flagged.map(({ artifact }) => artifact.id),
  };
}

function evaluateRule(kind: VerificationRuleKind, contract: Contract, spec: DeliverableSpec, submission: Submission): Outcome {
  const wrongDeliverable = notEvaluated(
    `This condition does not apply to ${spec.kind} deliverables, so it could not be checked automatically.`,
  );
  switch (kind) {
    case "deliverable_count":
      return checkDeliverableCount(spec, submission);
    case "aspect_ratio_coverage":
      return spec.kind === "illustration" ? checkAspectRatios(spec, submission) : wrongDeliverable;
    case "valid_format":
      return spec.kind === "illustration" ? checkValidFormat(submission) : wrongDeliverable;
    case "word_count":
      return spec.kind === "copy" ? checkWordCount(spec, submission) : wrongDeliverable;
    case "deadline":
      return checkDeadline(contract, submission);
    case "no_embedded_instructions":
      return checkEmbeddedInstructions(contract, submission);
    case "language_coverage":
    case "brief_adherence":
      return notEvaluated("This condition needs judgement and has no deterministic evaluator.");
    default:
      return assertNever(kind);
  }
}

/**
 * Evaluate every rule the contract assigns to the deterministic evaluator.
 * Returns exactly one check per such rule; pass and fail carry confidence 1.
 */
export function runDeterministicChecks(contract: Contract, submission: Submission): VerificationCheck[] {
  const spec = contract.deliverables[0];
  if (spec === undefined) throw new Error(`Contract ${contract.contractId} has no deliverable to verify`);
  return contract.verificationRules
    .filter((rule) => rule.evaluator === "deterministic")
    .map((rule) => {
      const outcome = evaluateRule(rule.kind, contract, spec, submission);
      return {
        ruleId: rule.id,
        kind: rule.kind,
        condition: rule.description,
        required: rule.required,
        evaluator: "deterministic",
        result: outcome.result,
        // A deterministic evaluator is either certain or it did not evaluate at all.
        confidence: outcome.result === "uncertain" ? 0 : 1,
        evidence: truncate(outcome.evidence, EVIDENCE_MAX),
        explanation: truncate(outcome.explanation, EXPLANATION_MAX),
        artifactIds: outcome.artifactIds,
      };
    });
}

/* -------------------------------------------------------------------------- */
/*  Decision                                                                   */
/* -------------------------------------------------------------------------- */

const SEVERITY: Record<CheckResult, number> = { pass: 0, uncertain: 1, fail: 2 };

function ruleNumber(ruleId: string): number {
  const number = Number.parseInt(ruleId.replace(/^\D+/, ""), 10);
  return Number.isNaN(number) ? Number.MAX_SAFE_INTEGER : number;
}

function clampConfidence(confidence: number): number {
  return Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0;
}

/**
 * When two checks claim the same rule, keep the one that is worse for the seller. Shared with the
 * AI verifier, which collapses a model's duplicate answers for one rule by the same principle.
 */
export function moreConservative(a: VerificationCheck, b: VerificationCheck): VerificationCheck {
  if (SEVERITY[a.result] !== SEVERITY[b.result]) return SEVERITY[a.result] > SEVERITY[b.result] ? a : b;
  // Same result: the confident failure, or the least confident pass / uncertain.
  const preferHigher = a.result === "fail";
  return a.confidence >= b.confidence === preferHigher ? a : b;
}

/**
 * Exactly one check per CONTRACT rule, in rule order. The contract — not the evaluator's output —
 * decides which rules exist, whether they are required and who may evaluate them, so a check
 * cannot downgrade itself to advisory, invent a rule, or let the AI answer a deterministic rule.
 */
function effectiveChecks(contract: Contract, checks: readonly VerificationCheck[]): VerificationCheck[] {
  return [...contract.verificationRules]
    .sort((a, b) => ruleNumber(a.id) - ruleNumber(b.id))
    .map((rule: VerificationRule): VerificationCheck => {
      const candidates = checks.filter((check) => check.ruleId === rule.id && check.evaluator === rule.evaluator);
      const base = {
        ruleId: rule.id,
        kind: rule.kind,
        condition: rule.description,
        required: rule.required,
        evaluator: rule.evaluator,
      };
      if (candidates.length === 0) {
        return {
          ...base,
          result: "uncertain",
          confidence: 0,
          evidence: "not evaluated",
          explanation: "No evaluation was recorded for this condition, so it cannot count as satisfied.",
          artifactIds: [],
        };
      }
      const chosen = candidates.reduce(moreConservative);
      return {
        ...base,
        result: chosen.result,
        confidence: clampConfidence(chosen.confidence),
        evidence: truncate(chosen.evidence, EVIDENCE_MAX),
        explanation: truncate(chosen.explanation, EXPLANATION_MAX),
        artifactIds: [...chosen.artifactIds],
      };
    });
}

function withoutFullStop(text: string): string {
  return text.replace(/[.\s]+$/, "");
}

function failureSummary(failed: readonly VerificationCheck[], suffix: string): string {
  const evidence = failed.map((check) => withoutFullStop(check.evidence)).join("; ");
  return `${plural(failed.length, "condition")} failed${suffix}: ${evidence}.`;
}

export interface VerificationVerdict {
  decision: VerificationDecision;
  /** Lowest confidence among required checks (the weakest link). */
  confidence: number;
  /** Required rules whose result is "fail": the conditions that block payment. */
  failedRuleIds: string[];
  summary: string;
}

/**
 * Turn checks into a settlement decision.
 *
 *  1. A contract rule with no check counts as "uncertain" — a missing evaluation never passes.
 *  2. Suspected manipulation (AI flag or a failed no_embedded_instructions check) -> human_review.
 *  3. A required check that failed with confidence >= humanReviewMinConfidence is an explicit
 *     failure -> revision_required while revisions remain, otherwise reject.
 *  4. A required low-confidence fail, uncertain, or pass below autoCaptureMinConfidence -> human_review.
 *  5. Otherwise capture_eligible. Advisory checks never change the outcome of steps 3–5.
 */
export function decideVerification(input: {
  contract: Contract;
  checks: VerificationCheck[];
  revisionsUsed: number;
  manipulationSuspected: boolean;
}): VerificationVerdict {
  const { contract, revisionsUsed, manipulationSuspected } = input;
  const { autoCaptureMinConfidence, humanReviewMinConfidence } = contract.settlement;
  const effective = effectiveChecks(contract, input.checks);
  const required = effective.filter((check) => check.required);

  const failed = required.filter((check) => check.result === "fail");
  const explicitFailures = failed.filter((check) => check.confidence >= humanReviewMinConfidence);
  const ambiguous = required.filter(
    (check) =>
      (check.result === "fail" && check.confidence < humanReviewMinConfidence) ||
      check.result === "uncertain" ||
      (check.result === "pass" && check.confidence < autoCaptureMinConfidence),
  );
  const instructionFailure = effective.find(
    (check) => check.kind === "no_embedded_instructions" && check.result === "fail",
  );

  const confidence = required.length === 0 ? 0 : Math.min(...required.map((check) => check.confidence));
  const failedRuleIds = failed.map((check) => check.ruleId);
  const verdict = (decision: VerificationDecision, summary: string): VerificationVerdict => ({
    decision,
    confidence,
    failedRuleIds,
    summary: truncate(summary, SUMMARY_MAX),
  });

  if (manipulationSuspected || instructionFailure !== undefined) {
    // A trust incident is not something a revision fixes, so it outranks every other outcome.
    return verdict(
      "human_review",
      instructionFailure === undefined
        ? "The verifier flagged a possible attempt to manipulate verification, so a human must decide."
        : `Possible attempt to manipulate verification: ${withoutFullStop(instructionFailure.evidence)}.`,
    );
  }
  if (explicitFailures.length > 0) {
    return revisionsUsed < contract.revisionLimit
      ? verdict("revision_required", failureSummary(failed, ""))
      : verdict("reject", failureSummary(failed, " and no revisions remain"));
  }
  if (required.length === 0) {
    // Nothing gates the payment; refusing to automate is the only safe reading of such a contract.
    return verdict("human_review", "The contract has no required conditions, so a human must decide.");
  }
  if (ambiguous.length > 0) {
    return verdict(
      "human_review",
      `${plural(ambiguous.length, "condition")} could not be verified with enough confidence, so a human must decide.`,
    );
  }
  return verdict(
    "capture_eligible",
    required.length === 1 ? "The contract condition was verified." : `All ${required.length} contract conditions verified.`,
  );
}

/**
 * Assemble the verification report for a submission. The report lists one check per contract
 * rule (ordered by rule id, unevaluated rules shown as "not evaluated") and is bound to the
 * contract by its terms hash.
 *
 * @throws Error when the submission belongs to a different deal than the contract.
 */
export function buildReport(input: {
  id: string;
  signed: SignedContract;
  submission: Submission;
  checks: VerificationCheck[];
  revisionsUsed: number;
  manipulationSuspected: boolean;
  degraded: boolean;
  model: string | null;
  now: Date;
}): VerificationReport {
  const { signed, submission } = input;
  const { contract } = signed;
  if (submission.dealId !== contract.dealId) {
    throw new Error(
      `Submission ${submission.id} belongs to deal ${submission.dealId}, not to the contract's deal ${contract.dealId}`,
    );
  }
  const verdict = decideVerification({
    contract,
    checks: input.checks,
    revisionsUsed: input.revisionsUsed,
    manipulationSuspected: input.manipulationSuspected,
  });
  return VerificationReportSchema.parse({
    id: input.id,
    dealId: contract.dealId,
    submissionId: submission.id,
    round: submission.round,
    contractHash: signed.termsHash,
    checks: effectiveChecks(contract, input.checks),
    decision: verdict.decision,
    confidence: verdict.confidence,
    summary: verdict.summary,
    failedRuleIds: verdict.failedRuleIds,
    degraded: input.degraded,
    model: input.model,
    createdAt: input.now.toISOString(),
  } satisfies VerificationReport);
}
