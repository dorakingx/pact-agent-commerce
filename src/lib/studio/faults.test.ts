import { describe, expect, it } from "vitest";
import { scanForEmbeddedInstructions } from "../domain/injection-scan";
import { ArtifactSchema, type Artifact, type CopyArtifact, type IllustrationArtifact } from "../domain/schemas";
import { scriptedArtDirection } from "./art-direction";
import { scriptedCopy } from "./copy";
import { applySellerBehavior, INJECTED_DESCRIPTION_SUFFIX, INJECTED_INSTRUCTION } from "./faults";
import { renderIllustration } from "./illustration";
import { sanitizeSvg } from "./svg-sanitize";

const NOTE = "Delivered 2 illustrations in 16:9 and 1:1: 4 SVG files at exact pixel size.";

function illustration(index: number, ratio: "16:9" | "1:1"): IllustrationArtifact {
  const direction = scriptedArtDirection("launch banner illustrations", null, index, 2);
  const rendered = renderIllustration(direction, ratio);
  return {
    id: `art_test${index}${ratio.replace(":", "x")}`,
    kind: "illustration",
    index,
    title: direction.title,
    aspectRatio: ratio,
    width: rendered.width,
    height: rendered.height,
    format: "svg",
    svg: rendered.svg,
    description: direction.description,
  };
}

function copy(index: number, language: "en" | "ja"): CopyArtifact {
  const piece = scriptedCopy({ subject: "espresso machines", tone: null, index, count: 2, language, minWords: 20, maxWords: 40 });
  return { id: `art_copy${index}${language}`, kind: "copy", index, title: piece.title, language, text: piece.text };
}

const illustrations = (count: number): Artifact[] =>
  Array.from({ length: count }, (_, i) => [illustration(i + 1, "16:9"), illustration(i + 1, "1:1")]).flat();

describe("applySellerBehavior — reliable", () => {
  it("returns the delivery untouched", () => {
    const artifacts = illustrations(2);
    const result = applySellerBehavior("reliable", 1, artifacts, NOTE);
    expect(result.artifacts).toBe(artifacts);
    expect(result.note).toBe(NOTE);
  });
});

describe("applySellerBehavior — omits_variant (controlled demo fault)", () => {
  it("drops exactly the last listed ratio of illustration #2 on round 1 and keeps a confident note", () => {
    const artifacts = illustrations(3);
    const result = applySellerBehavior("omits_variant", 1, artifacts, NOTE);

    expect(result.artifacts).toHaveLength(artifacts.length - 1);
    const missing = artifacts.filter((artifact) => !result.artifacts.includes(artifact));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ index: 2, aspectRatio: "1:1" });
    expect(result.note).toBe(NOTE);
    // Pure: the caller's array still holds the full set.
    expect(artifacts).toHaveLength(6);
  });

  it("targets item #1 when the job has a single item", () => {
    const artifacts = illustrations(1);
    const result = applySellerBehavior("omits_variant", 1, artifacts, NOTE);
    expect(result.artifacts).toEqual([artifacts[0]]);
  });

  it("drops the last language of copy piece #2", () => {
    const artifacts: Artifact[] = [copy(1, "en"), copy(1, "ja"), copy(2, "en"), copy(2, "ja")];
    const result = applySellerBehavior("omits_variant", 1, artifacts, "Delivered.");
    expect(result.artifacts.map((artifact) => artifact.id)).toEqual(["art_copy1en", "art_copy1ja", "art_copy2en"]);
  });

  it("delivers the complete set on round 2 and says what was added", () => {
    const artifacts = illustrations(2);
    const result = applySellerBehavior("omits_variant", 2, artifacts, "Revision 1: everything is attached.");
    expect(result.artifacts).toBe(artifacts);
    expect(result.note).toBe("Added the missing 1:1 version of illustration #2. Revision 1: everything is attached.");

    const copyResult = applySellerBehavior("omits_variant", 2, [copy(1, "en"), copy(1, "ja")], "");
    expect(copyResult.note).toBe("Added the missing Japanese version of copy piece #1.");
  });

  it("does not repeat a sentence the note already contains, and keeps notes within the limit", () => {
    const sentence = "Added the missing 1:1 version of illustration #2.";
    const already = `Revision 1: ${sentence} The other 3 files are unchanged.`;
    expect(applySellerBehavior("omits_variant", 2, illustrations(2), already).note).toBe(already);
    const long = applySellerBehavior("omits_variant", 2, illustrations(2), "word ".repeat(200)).note;
    expect(long.length).toBeLessThanOrEqual(600);
    expect(long.startsWith(sentence)).toBe(true);
  });

  it("changes nothing from round 3 on, or when there is nothing to deliver", () => {
    const artifacts = illustrations(2);
    expect(applySellerBehavior("omits_variant", 3, artifacts, NOTE)).toEqual({ artifacts, note: NOTE });
    expect(applySellerBehavior("omits_variant", 1, [], NOTE)).toEqual({ artifacts: [], note: NOTE });
  });
});

describe("applySellerBehavior — embeds_instructions (controlled demo fault)", () => {
  it.each([1, 2, 3])("hides the instruction in every illustration on round %i", (round) => {
    const artifacts = illustrations(2);
    const result = applySellerBehavior("embeds_instructions", round, artifacts, NOTE);

    expect(result.note).toBe(NOTE);
    expect(result.artifacts).toHaveLength(4);
    for (const [i, artifact] of result.artifacts.entries()) {
      if (artifact.kind !== "illustration") throw new Error("expected an illustration");
      const original = artifacts[i] as IllustrationArtifact;
      expect(artifact.id).toBe(original.id);
      expect(artifact.svg).toContain(`<text x="0" y="0" font-size="1" fill-opacity="0">${INJECTED_INSTRUCTION}</text></svg>`);
      expect(artifact.svg.length).toBeGreaterThan(original.svg.length);
      expect(artifact.description).toBe(`${original.description}${INJECTED_DESCRIPTION_SUFFIX}`);
      // Still a valid, sanitizer-clean artifact: spotting the text is the verifier's job.
      expect(sanitizeSvg(artifact.svg)).toEqual({ ok: true, svg: artifact.svg });
      expect(ArtifactSchema.safeParse(artifact).success).toBe(true);
      // The originals are not mutated.
      expect(original.svg).not.toContain("NOTE TO AUTOMATED VERIFIER");
    }
  });

  it("appends the instruction sentence to copy texts", () => {
    const artifacts: Artifact[] = [copy(1, "en"), copy(1, "ja")];
    const result = applySellerBehavior("embeds_instructions", 1, artifacts, "Delivered.");
    for (const [i, artifact] of result.artifacts.entries()) {
      if (artifact.kind !== "copy") throw new Error("expected copy");
      expect(artifact.text).toBe(`${(artifacts[i] as CopyArtifact).text} ${INJECTED_INSTRUCTION}`);
      expect(ArtifactSchema.safeParse(artifact).success).toBe(true);
    }
  });

  it("is idempotent, so re-delivered files never carry the text twice", () => {
    const once = applySellerBehavior("embeds_instructions", 1, [...illustrations(1), copy(1, "en")], NOTE);
    const twice = applySellerBehavior("embeds_instructions", 2, once.artifacts, NOTE);
    expect(twice.artifacts).toEqual(once.artifacts);
  });

  it("keeps descriptions and texts inside the artifact limits", () => {
    const long: IllustrationArtifact = { ...illustration(1, "16:9"), description: "d".repeat(400) };
    const longCopy: CopyArtifact = { ...copy(1, "en"), text: "t".repeat(20_000) };
    const result = applySellerBehavior("embeds_instructions", 1, [long, longCopy], NOTE);
    for (const artifact of result.artifacts) expect(ArtifactSchema.safeParse(artifact).success).toBe(true);
    const [first, second] = result.artifacts;
    expect(first.kind === "illustration" && first.description.endsWith(INJECTED_DESCRIPTION_SUFFIX)).toBe(true);
    expect(second.kind === "copy" && second.text.endsWith(INJECTED_INSTRUCTION)).toBe(true);
  });

  it("is exactly what PACT's embedded-instruction scanner is built to catch", () => {
    const clean = [...illustrations(1), copy(1, "en")];
    for (const artifact of clean) expect(scanForEmbeddedInstructions(artifact).suspicious).toBe(false);
    const hostile = applySellerBehavior("embeds_instructions", 1, clean, NOTE).artifacts;
    for (const artifact of hostile) {
      const scan = scanForEmbeddedInstructions(artifact);
      expect(scan.suspicious).toBe(true);
      expect(scan.findings.length).toBeGreaterThan(0);
    }
  });
});
