/**
 * The seller studio: what a seller agent actually hands over.
 *
 * `produceDelivery` turns a signed contract into finished artifacts — illustrations rendered as
 * sanitized SVG at the exact pixel size of every contracted aspect ratio, or copy inside the
 * contracted word range in every contracted language. A model may propose the art direction or
 * the wording; rendering, sizing, counting and sanitising are deterministic.
 *
 * On a revision round the studio keeps every file of the previous submission that was fine
 * (same artifact id, same bytes) and only adds or reworks what the verification report found,
 * so a revision visibly answers the report instead of replacing the whole delivery.
 *
 * Server-only (it reaches the model gateway). Client components that only need to display an
 * artifact import from "./data-uri", "./illustration" or "./svg-sanitize" directly.
 */
import "server-only";
import { AiUnavailableError, callStructured, type CallStructured } from "../ai/gateway";
import type { AgentMeta, DeliveryContext } from "../ai/types";
import { getAiMode } from "../config";
import { joinList, plural } from "../domain/format";
import { newId } from "../domain/ids";
import {
  ArtifactSchema,
  type AgentSource,
  type Artifact,
  type AspectRatio,
  type CopyArtifact,
  type CopySpec,
  type IllustrationArtifact,
  type IllustrationSpec,
  type Language,
  type VerificationReport,
  type VerificationRuleKind,
} from "../domain/schemas";
import { countWords } from "../domain/text-metrics";
import { log } from "../observability/logger";
import { aiArtDirection, describeMotif, motifOrder, scriptedArtDirection, seedFor } from "./art-direction";
import { aiCopy, scriptedCopy } from "./copy";
import { languageName } from "./copy-packs";
import { addedVariantSentence, applySellerBehavior, INJECTED_DESCRIPTION_SUFFIX } from "./faults";
import { RATIO_DIMENSIONS, readArtSignature, renderIllustration, type ArtDirection, type Motif } from "./illustration";
import { sanitizeSvg } from "./svg-sanitize";
import { clampText, singleLine } from "./text";

export { svgToDataUri } from "./data-uri";
export { applySellerBehavior, INJECTED_DESCRIPTION_SUFFIX, INJECTED_INSTRUCTION } from "./faults";
export {
  MOTIFS,
  PALETTES,
  RATIO_DIMENSIONS,
  readArtSignature,
  renderIllustration,
  type ArtDirection,
  type Motif,
  type PaletteName,
} from "./illustration";
export { MAX_SVG_CHARS, sanitizeSvg, type SanitizeResult } from "./svg-sanitize";
export { aiArtDirection, scriptedArtDirection } from "./art-direction";
export { aiCopy, scriptedCopy } from "./copy";

export interface StudioDeps {
  /** Replaces the model gateway (tests inject a stub). */
  call?: CallStructured;
  /** Overrides PACT_AI_MODE. "scripted" never calls a model. */
  mode?: "ai" | "scripted";
}

const MAX_TITLE_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 400;
const MAX_NOTE_CHARS = 600;
const MAX_FEEDBACK_CHARS = 400;

/** Rules whose failure is about the content of specific files (as opposed to files that are absent). */
const CONTENT_RULES: ReadonlySet<VerificationRuleKind> = new Set<VerificationRuleKind>([
  "brief_adherence",
  "valid_format",
  "word_count",
  "no_embedded_instructions",
]);

/** How the creative part of a delivery was authored; becomes AgentMeta. */
interface Authoring {
  source: AgentSource;
  model: string | null;
  degradedReason: string | null;
}

const SCRIPTED: Authoring = { source: "scripted", model: null, degradedReason: null };

interface Studio {
  call: CallStructured;
  mode: "ai" | "scripted";
}

type SlotState =
  /** The previous file is fine: deliver it again unchanged, under the same id. */
  | "keep"
  /** No usable previous file: produce it so that it matches its kept siblings. */
  | "add"
  /** The verification report objected to it: produce a new take. */
  | "rework";

interface Produced<T extends Artifact> {
  artifacts: T[];
  note: string;
  authoring: Authoring;
}

/* -------------------------------------------------------------------------- */
/*  Shared                                                                     */
/* -------------------------------------------------------------------------- */

/** One line telling the studio's model why the previous delivery was sent back. */
function revisionFeedback(report: VerificationReport | null): string | null {
  if (report === null) return null;
  const failed = report.checks.filter((check) => check.result === "fail");
  const findings = failed.length > 0 ? failed : report.checks.filter((check) => check.result === "uncertain");
  const line =
    findings.length > 0
      ? findings.map((check) => `${check.condition}: ${check.evidence}`).join("; ")
      : report.summary;
  const text = clampText(singleLine(line), MAX_FEEDBACK_CHARS);
  return text === "" ? null : text;
}

/** Ids of previous artifacts whose CONTENT the report objected to. */
function objectedArtifactIds(report: VerificationReport | null): ReadonlySet<string> {
  if (report === null) return new Set();
  const content = report.checks.filter((check) => CONTENT_RULES.has(check.kind));
  const failed = content.filter((check) => check.result === "fail");
  const findings = failed.length > 0 ? failed : content.filter((check) => check.required && check.result === "uncertain");
  return new Set(findings.flatMap((check) => check.artifactIds));
}

/**
 * Decide what happens to every contracted slot on a revision.
 *  - a slot with a sound previous file is kept, unless the report objected to it;
 *  - an objection reworks the whole item (all its variants), so variants stay the same piece;
 *  - when the report names nothing fixable at all, the revision reworks everything rather than
 *    resubmitting an identical delivery.
 */
function planSlots<K extends string>(
  indexes: readonly number[],
  variants: readonly K[],
  previousOf: (index: number, variant: K) => { id: string; sound: boolean } | null,
  objected: ReadonlySet<string>,
): Map<string, SlotState> {
  const states = new Map<string, SlotState>();
  const reworked = new Set<number>();
  for (const index of indexes) {
    for (const variant of variants) {
      const previous = previousOf(index, variant);
      const state: SlotState = previous === null || !previous.sound ? "add" : objected.has(previous.id) ? "rework" : "keep";
      if (state === "rework") reworked.add(index);
      states.set(slotKey(index, variant), state);
    }
  }
  const nothingToFix = [...states.values()].every((state) => state === "keep");
  for (const index of indexes) {
    if (!nothingToFix && !reworked.has(index)) continue;
    for (const variant of variants) states.set(slotKey(index, variant), "rework");
  }
  return states;
}

/** On a first delivery there is nothing to keep: every slot is produced. */
function firstDeliverySlots(indexes: readonly number[], variants: readonly string[]): Map<string, SlotState> {
  const states = new Map<string, SlotState>();
  for (const index of indexes) {
    for (const variant of variants) states.set(slotKey(index, variant), "rework");
  }
  return states;
}

function slotKey(index: number, variant: string): string {
  return `${index}|${variant}`;
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i + 1);
}

/** Delivery note of a revision round: what was added, what was reworked, what is unchanged. */
function revisionNote(
  round: number,
  added: readonly Artifact[],
  reworked: readonly string[],
  kept: number,
  noun: string,
): string {
  const parts: string[] = [];
  if (added.length === 1) parts.push(addedVariantSentence(added[0]));
  else if (added.length > 1) {
    const labels = added.map((artifact) => `#${artifact.index} in ${artifact.kind === "illustration" ? artifact.aspectRatio : languageName(artifact.language)}`);
    parts.push(`Added the missing versions: ${joinList(labels)}.`);
  }
  if (reworked.length > 0) {
    parts.push(`Reworked ${noun}${reworked.length === 1 ? "" : "s"} ${joinList(reworked)} in response to the verification report.`);
  }
  if (kept > 0) parts.push(`The other ${plural(kept, "file")} ${kept === 1 ? "is" : "are"} unchanged from the previous round.`);
  return clampText(`Revision ${round - 1}: ${parts.join(" ")}`, MAX_NOTE_CHARS);
}

/* -------------------------------------------------------------------------- */
/*  Illustrations                                                              */
/* -------------------------------------------------------------------------- */

function buildIllustration(direction: ArtDirection, index: number, ratio: AspectRatio): IllustrationArtifact {
  const rendered = renderIllustration(direction, ratio);
  const clean = sanitizeSvg(rendered.svg);
  if (!clean.ok) {
    throw new Error(`The studio rendered an SVG that its own sanitizer rejects (${direction.motif}, ${ratio}): ${clean.reason}`);
  }
  return {
    id: newId("art"),
    kind: "illustration",
    index,
    title: clampText(direction.title, MAX_TITLE_CHARS),
    aspectRatio: ratio,
    width: rendered.width,
    height: rendered.height,
    format: "svg",
    svg: clean.svg,
    description: clampText(direction.description, MAX_DESCRIPTION_CHARS),
  };
}

function isSoundIllustration(artifact: IllustrationArtifact, ratio: AspectRatio): boolean {
  const { width, height } = RATIO_DIMENSIONS[ratio];
  return artifact.width === width && artifact.height === height && sanitizeSvg(artifact.svg).ok;
}

/** The direction a previously delivered file was drawn with, when it is one of the studio's own. */
function directionOf(artifact: IllustrationArtifact): ArtDirection | null {
  const signature = readArtSignature(artifact.svg);
  if (signature === null) return null;
  const description = artifact.description.endsWith(INJECTED_DESCRIPTION_SUFFIX)
    ? artifact.description.slice(0, -INJECTED_DESCRIPTION_SUFFIX.length)
    : artifact.description;
  return { ...signature, title: artifact.title, description };
}

/** Base directions for the whole set: from the model when allowed and reachable, otherwise scripted. */
async function directSet(
  spec: IllustrationSpec,
  feedback: string | null,
  studio: Studio,
): Promise<{ directions: ArtDirection[]; authoring: Authoring }> {
  const scripted = (): ArtDirection[] =>
    range(spec.count).map((index) => scriptedArtDirection(spec.subject, spec.style, index, spec.count));
  if (studio.mode === "scripted") return { directions: scripted(), authoring: SCRIPTED };
  try {
    const result = await aiArtDirection(
      { subject: spec.subject, style: spec.style, count: spec.count, revisionFeedback: feedback },
      { call: studio.call },
    );
    return { directions: result.directions, authoring: { source: "ai", model: result.model, degradedReason: null } };
  } catch (error) {
    if (!(error instanceof AiUnavailableError)) throw error;
    log.warn("studio.fallback", { task: "art_direction", reason: error.reason });
    return { directions: scripted(), authoring: { source: "scripted", model: null, degradedReason: error.reason } };
  }
}

async function deliverIllustrations(
  ctx: DeliveryContext,
  spec: IllustrationSpec,
  studio: Studio,
): Promise<Produced<IllustrationArtifact>> {
  const indexes = range(spec.count);
  const ratios = spec.aspectRatios;
  const previous = new Map<string, IllustrationArtifact>();
  for (const artifact of ctx.previousSubmission?.artifacts ?? []) {
    if (artifact.kind !== "illustration") continue;
    const key = slotKey(artifact.index, artifact.aspectRatio);
    if (!previous.has(key)) previous.set(key, artifact);
  }
  const isRevision = ctx.round > 1 && ctx.previousSubmission !== null;

  const states = isRevision
    ? planSlots(
        indexes,
        ratios,
        (index, ratio) => {
          const artifact = previous.get(slotKey(index, ratio));
          return artifact === undefined ? null : { id: artifact.id, sound: isSoundIllustration(artifact, ratio) };
        },
        objectedArtifactIds(ctx.previousReport),
      )
    : firstDeliverySlots(indexes, ratios);
  const stateOf = (index: number, ratio: AspectRatio): SlotState => states.get(slotKey(index, ratio)) ?? "rework";

  // An illustration whose kept variant tells us how it was drawn can get its other variants back
  // exactly; everything else needs a (new) direction.
  const locked = new Map<number, ArtDirection>();
  const retired = new Set<Motif>();
  for (const index of indexes) {
    for (const ratio of ratios) {
      const artifact = previous.get(slotKey(index, ratio));
      const direction = artifact === undefined ? null : directionOf(artifact);
      if (direction === null) continue;
      if (stateOf(index, ratio) === "keep") locked.set(index, locked.get(index) ?? direction);
      // A reworked illustration should not come back as the same scene.
      if (stateOf(index, ratio) === "rework") retired.add(direction.motif);
    }
  }
  const undirected = indexes.filter((index) => !locked.has(index) && ratios.some((ratio) => stateOf(index, ratio) !== "keep"));
  for (const index of undirected) {
    // Without a known direction a single variant cannot be matched to its siblings: redo them together.
    for (const ratio of ratios) states.set(slotKey(index, ratio), "rework");
  }

  let authoring: Authoring = isRevision
    ? { source: ctx.previousSubmission?.source ?? "scripted", model: ctx.previousSubmission?.model ?? null, degradedReason: null }
    : SCRIPTED;
  const directions = new Map<number, ArtDirection>(locked);
  if (undirected.length > 0) {
    const base = await directSet(spec, isRevision ? revisionFeedback(ctx.previousReport) : null, studio);
    authoring = base.authoring;
    const setPalette = [...locked.values()][0]?.palette ?? base.directions[0]?.palette;
    const used = new Set<Motif>([...locked.values()].map((direction) => direction.motif));
    const order = motifOrder(spec.subject);
    for (const index of undirected) {
      const proposed = base.directions[index - 1] ?? scriptedArtDirection(spec.subject, spec.style, index, spec.count);
      const clash = used.has(proposed.motif) || retired.has(proposed.motif);
      const motif = clash
        ? (order.find((candidate) => !used.has(candidate) && !retired.has(candidate)) ??
          order.find((candidate) => !used.has(candidate)) ??
          proposed.motif)
        : proposed.motif;
      used.add(motif);
      directions.set(index, {
        ...proposed,
        ...(motif === proposed.motif ? {} : { motif, ...describeMotif(motif, spec.subject, index, spec.count) }),
        palette: setPalette ?? proposed.palette,
        seed: isRevision ? seedFor(spec.subject, index, ctx.round) : proposed.seed,
      });
    }
  }

  const artifacts: IllustrationArtifact[] = [];
  const added: IllustrationArtifact[] = [];
  const reworked = new Set<number>();
  let kept = 0;
  for (const index of indexes) {
    const direction = directions.get(index);
    for (const ratio of ratios) {
      const state = stateOf(index, ratio);
      const existing = previous.get(slotKey(index, ratio));
      if (state === "keep" && existing !== undefined) {
        artifacts.push(existing);
        kept += 1;
        continue;
      }
      if (direction === undefined) {
        throw new Error(`The studio has no art direction for illustration #${index}`);
      }
      const artifact = buildIllustration(direction, index, ratio);
      artifacts.push(artifact);
      if (state === "add") added.push(artifact);
      else reworked.add(index);
    }
  }

  const sizes = ratios.map((ratio) => `${RATIO_DIMENSIONS[ratio].width}×${RATIO_DIMENSIONS[ratio].height}`);
  const note = isRevision
    ? revisionNote(ctx.round, added, [...reworked].map((index) => `#${index}`), kept, "illustration")
    : clampText(
        `Delivered ${plural(spec.count, "illustration")} in ${joinList([...ratios])}: ${plural(artifacts.length, "SVG file")} at exact pixel size (${joinList(sizes)}), drawn as one set in a shared palette.`,
        MAX_NOTE_CHARS,
      );
  return { artifacts, note, authoring };
}

/* -------------------------------------------------------------------------- */
/*  Copy                                                                       */
/* -------------------------------------------------------------------------- */

function isSoundCopy(artifact: CopyArtifact, language: Language, spec: CopySpec): boolean {
  const words = countWords(artifact.text, language);
  return artifact.title.trim() !== "" && words >= spec.minWords && words <= Math.max(spec.minWords, spec.maxWords);
}

async function deliverCopy(ctx: DeliveryContext, spec: CopySpec, studio: Studio): Promise<Produced<CopyArtifact>> {
  const indexes = range(spec.count);
  const languages = spec.languages;
  const previous = new Map<string, CopyArtifact>();
  for (const artifact of ctx.previousSubmission?.artifacts ?? []) {
    if (artifact.kind !== "copy") continue;
    const key = slotKey(artifact.index, artifact.language);
    if (!previous.has(key)) previous.set(key, artifact);
  }
  const isRevision = ctx.round > 1 && ctx.previousSubmission !== null;

  const states = isRevision
    ? planSlots(
        indexes,
        languages,
        (index, language) => {
          const artifact = previous.get(slotKey(index, language));
          return artifact === undefined ? null : { id: artifact.id, sound: isSoundCopy(artifact, language, spec) };
        },
        objectedArtifactIds(ctx.previousReport),
      )
    : firstDeliverySlots(indexes, languages);
  const stateOf = (index: number, language: Language): SlotState => states.get(slotKey(index, language)) ?? "rework";
  const needsWriting = [...states.values()].some((state) => state !== "keep");

  // A missing version is written like the first delivery (so it matches its siblings); a reworked
  // piece gets a new take.
  const scripted = (index: number, language: Language): { title: string; text: string } =>
    scriptedCopy({
      subject: spec.subject,
      tone: spec.tone,
      index,
      count: spec.count,
      language,
      minWords: spec.minWords,
      maxWords: spec.maxWords,
      variant: isRevision && stateOf(index, language) === "rework" ? ctx.round - 1 : 0,
    });

  let authoring: Authoring = isRevision
    ? { source: ctx.previousSubmission?.source ?? "scripted", model: ctx.previousSubmission?.model ?? null, degradedReason: null }
    : SCRIPTED;
  let write = scripted;
  if (needsWriting) {
    authoring = SCRIPTED;
    if (studio.mode === "ai") {
      try {
        const result = await aiCopy(
          {
            subject: spec.subject,
            tone: spec.tone,
            count: spec.count,
            languages: [...languages],
            minWords: spec.minWords,
            maxWords: spec.maxWords,
            revisionFeedback: isRevision ? revisionFeedback(ctx.previousReport) : null,
          },
          { call: studio.call },
        );
        const written = new Map(result.pieces.map((piece) => [slotKey(piece.index, piece.language), piece]));
        write = (index, language) => written.get(slotKey(index, language)) ?? scripted(index, language);
        authoring = { source: "ai", model: result.model, degradedReason: null };
      } catch (error) {
        if (!(error instanceof AiUnavailableError)) throw error;
        log.warn("studio.fallback", { task: "copy", reason: error.reason });
        authoring = { source: "scripted", model: null, degradedReason: error.reason };
      }
    }
  }

  const artifacts: CopyArtifact[] = [];
  const added: CopyArtifact[] = [];
  const reworked = new Set<number>();
  let kept = 0;
  for (const index of indexes) {
    for (const language of languages) {
      const state = stateOf(index, language);
      const existing = previous.get(slotKey(index, language));
      if (state === "keep" && existing !== undefined) {
        artifacts.push(existing);
        kept += 1;
        continue;
      }
      const piece = write(index, language);
      const artifact: CopyArtifact = { id: newId("art"), kind: "copy", index, title: piece.title, language, text: piece.text };
      artifacts.push(artifact);
      if (state === "add") added.push(artifact);
      else reworked.add(index);
    }
  }

  const note = isRevision
    ? revisionNote(ctx.round, added, [...reworked].map((index) => `#${index}`), kept, "copy piece")
    : clampText(
        `Delivered ${plural(spec.count, "copy piece")} in ${joinList(languages.map(languageName))}: ${plural(artifacts.length, "text")}, each between ${spec.minWords} and ${spec.maxWords} words.`,
        MAX_NOTE_CHARS,
      );
  return { artifacts, note, authoring };
}

/* -------------------------------------------------------------------------- */
/*  Entry point                                                                */
/* -------------------------------------------------------------------------- */

/** Whatever a seller hands in is sanitized and schema-checked before it leaves the studio. */
function finalise(artifact: Artifact): Artifact {
  let checked = artifact;
  if (artifact.kind === "illustration") {
    const clean = sanitizeSvg(artifact.svg);
    if (!clean.ok) throw new Error(`Illustration #${artifact.index} (${artifact.aspectRatio}) is not a valid SVG: ${clean.reason}`);
    checked = clean.svg === artifact.svg ? artifact : { ...artifact, svg: clean.svg };
  }
  const parsed = ArtifactSchema.safeParse(checked);
  if (!parsed.success) {
    const problem = parsed.error.issues[0];
    throw new Error(`The studio produced an invalid artifact (#${artifact.index}): ${problem?.path.join(".") ?? ""} ${problem?.message ?? ""}`);
  }
  return checked;
}

/**
 * Produce the delivery for `ctx.contract.deliverables[0]`.
 *
 * `meta.source` is "ai" when a model authored the art direction or the wording, "scripted" when
 * the deterministic studio did; `meta.degradedReason` carries the gateway's failure reason when
 * the model was tried and the scripted studio answered instead. The seller's behaviour profile
 * (controlled demo faults) is applied last.
 */
export async function produceDelivery(
  ctx: DeliveryContext,
  deps: StudioDeps = {},
): Promise<{ artifacts: Artifact[]; note: string; meta: AgentMeta }> {
  const started = Date.now();
  const studio: Studio = { call: deps.call ?? callStructured, mode: deps.mode ?? getAiMode() };
  const spec = ctx.contract.deliverables[0];
  if (spec === undefined) throw new Error(`Contract ${ctx.contract.contractId} has no deliverable to produce`);

  const produced: Produced<Artifact> =
    spec.kind === "illustration" ? await deliverIllustrations(ctx, spec, studio) : await deliverCopy(ctx, spec, studio);
  const delivered = applySellerBehavior(ctx.seller.behavior, ctx.round, produced.artifacts, produced.note);

  return {
    artifacts: delivered.artifacts.map(finalise),
    note: clampText(delivered.note, MAX_NOTE_CHARS),
    meta: { ...produced.authoring, latencyMs: Date.now() - started },
  };
}
