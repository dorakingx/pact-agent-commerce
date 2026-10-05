import { afterEach, describe, expect, it, vi } from "vitest";
import { AiUnavailableError, type CallStructured } from "../ai/gateway";
import type { DeliveryContext } from "../ai/types";
import {
  ArtifactSchema,
  type Artifact,
  type CopyArtifact,
  type CopySpec,
  type IllustrationArtifact,
  type IllustrationSpec,
} from "../domain/schemas";
import { countWords } from "../domain/text-metrics";
import { runDeterministicChecks } from "../domain/verification";
import { INJECTED_DESCRIPTION_SUFFIX, INJECTED_INSTRUCTION } from "./faults";
import {
  produceDelivery,
  RATIO_DIMENSIONS,
  readArtSignature,
  renderIllustration,
  sanitizeSvg,
  svgToDataUri,
} from "./index";
import {
  failedCheck,
  firstDelivery,
  revision,
  seller,
  stubCall,
  submissionOf,
  TEST_MODEL,
} from "./test-support";

const LANDING: IllustrationSpec = {
  kind: "illustration",
  count: 3,
  aspectRatios: ["16:9", "1:1"],
  subject: "landing-page hero illustrations",
  style: null,
};
const BANNERS: IllustrationSpec = {
  kind: "illustration",
  count: 2,
  aspectRatios: ["16:9", "1:1"],
  subject: "launch banner illustrations for our product update",
  style: null,
};
const DESCRIPTIONS: CopySpec = {
  kind: "copy",
  count: 6,
  languages: ["en", "ja"],
  minWords: 80,
  maxWords: 120,
  subject: "our new espresso machine lineup",
  tone: null,
};

/** A model that must never be reached. */
const forbiddenCall: CallStructured = async () => {
  throw new Error("the scripted studio must not call a model");
};
const scriptedDeps = { mode: "scripted", call: forbiddenCall } as const;

function illustrations(artifacts: Artifact[]): IllustrationArtifact[] {
  return artifacts.map((artifact) => {
    if (artifact.kind !== "illustration") throw new Error("expected an illustration");
    return artifact;
  });
}

function texts(artifacts: Artifact[]): CopyArtifact[] {
  return artifacts.map((artifact) => {
    if (artifact.kind !== "copy") throw new Error("expected copy");
    return artifact;
  });
}

function signature(artifact: IllustrationArtifact) {
  const found = readArtSignature(artifact.svg);
  if (found === null) throw new Error(`artifact ${artifact.id} is not a studio illustration`);
  return found;
}

/** Results of PACT's deterministic verification for a delivery, by rule kind. */
function verify(ctx: DeliveryContext, artifacts: Artifact[]) {
  const checks = runDeterministicChecks(ctx.contract, submissionOf(artifacts, ctx.round));
  return { checks, results: Object.fromEntries(checks.map((check) => [check.kind, check.result])) };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("produceDelivery — illustrations, scripted studio", () => {
  it("delivers every illustration in every contracted ratio, to spec", async () => {
    const ctx = firstDelivery(LANDING, seller("northwind"));
    const { artifacts, note, meta } = await produceDelivery(ctx, scriptedDeps);
    const files = illustrations(artifacts);

    expect(files.map((file) => [file.index, file.aspectRatio])).toEqual([
      [1, "16:9"],
      [1, "1:1"],
      [2, "16:9"],
      [2, "1:1"],
      [3, "16:9"],
      [3, "1:1"],
    ]);
    for (const file of files) {
      expect(ArtifactSchema.safeParse(file).success).toBe(true);
      expect(file.id).toMatch(/^art_[0-9a-z]{12}$/);
      expect({ width: file.width, height: file.height }).toEqual(RATIO_DIMENSIONS[file.aspectRatio as "16:9" | "1:1"]);
      expect(file.svg).toContain(`width="${file.width}" height="${file.height}" viewBox="0 0 ${file.width} ${file.height}"`);
      expect(sanitizeSvg(file.svg)).toEqual({ ok: true, svg: file.svg });
      expect(file.title).not.toBe("");
      expect(file.description).toContain(`illustration ${file.index} of 3`);
    }
    expect(new Set(files.map((file) => file.id)).size).toBe(6);

    // A cohesive set: one palette, a different scene per illustration, the same scene across its ratios.
    expect(new Set(files.map((file) => signature(file).palette)).size).toBe(1);
    expect(new Set(files.map((file) => signature(file).motif)).size).toBe(3);
    for (const index of [1, 2, 3]) {
      const [wide, square] = files.filter((file) => file.index === index);
      expect(signature(wide)).toEqual(signature(square));
      expect(wide.title).toBe(square.title);
      expect(wide.svg).not.toBe(square.svg);
    }

    expect(note).toBe(
      "Delivered 3 illustrations in 16:9 and 1:1: 6 SVG files at exact pixel size (1600×900 and 1200×1200), drawn as one set in a shared palette.",
    );
    expect(meta).toMatchObject({ source: "scripted", model: null, degradedReason: null });
    expect(meta.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("is reproducible: the same contract yields the same files", async () => {
    const ctx = firstDelivery(LANDING, seller("northwind"));
    const a = illustrations((await produceDelivery(ctx, scriptedDeps)).artifacts);
    const b = illustrations((await produceDelivery(ctx, scriptedDeps)).artifacts);
    expect(b.map((file) => file.svg)).toEqual(a.map((file) => file.svg));
    expect(b.map((file) => file.id)).not.toEqual(a.map((file) => file.id));
  });

  it("passes PACT's deterministic verification", async () => {
    const ctx = firstDelivery(LANDING, seller("northwind"));
    const { artifacts } = await produceDelivery(ctx, scriptedDeps);
    expect(verify(ctx, artifacts).results).toEqual({
      deliverable_count: "pass",
      aspect_ratio_coverage: "pass",
      valid_format: "pass",
      deadline: "pass",
      no_embedded_instructions: "pass",
    });
  });

  it("supports every ratio and the largest job the contract schema allows", async () => {
    const spec: IllustrationSpec = { ...LANDING, count: 6, aspectRatios: ["4:3", "4:5", "9:16"] };
    const ctx = firstDelivery(spec, seller("northwind"));
    const { artifacts } = await produceDelivery(ctx, scriptedDeps);
    expect(artifacts).toHaveLength(18);
    expect(new Set(illustrations(artifacts).map((file) => signature(file).motif)).size).toBe(6);
    expect(verify(ctx, artifacts).checks.filter((check) => check.result !== "pass")).toEqual([]);
  });

  it("reads the mode from the environment when none is given", async () => {
    vi.stubEnv("PACT_AI_MODE", "scripted");
    const { meta, artifacts } = await produceDelivery(firstDelivery(BANNERS, seller("northwind")), { call: forbiddenCall });
    expect(meta.source).toBe("scripted");
    expect(artifacts).toHaveLength(4);
  });
});

describe("produceDelivery — copy, scripted studio", () => {
  it("delivers every piece in every contracted language inside the word range", async () => {
    const ctx = firstDelivery(DESCRIPTIONS, seller("lingua"));
    const { artifacts, note, meta } = await produceDelivery(ctx, scriptedDeps);
    const pieces = texts(artifacts);

    expect(pieces.map((piece) => `${piece.index}${piece.language}`)).toEqual(
      [1, 2, 3, 4, 5, 6].flatMap((index) => [`${index}en`, `${index}ja`]),
    );
    for (const piece of pieces) {
      expect(ArtifactSchema.safeParse(piece).success).toBe(true);
      const words = countWords(piece.text, piece.language);
      expect(words).toBeGreaterThanOrEqual(80);
      expect(words).toBeLessThanOrEqual(120);
      expect(piece.title).toContain("espresso machine lineup");
    }
    expect(new Set(pieces.map((piece) => piece.text)).size).toBe(12);
    expect(new Set(pieces.map((piece) => piece.id)).size).toBe(12);
    expect(note).toBe("Delivered 6 copy pieces in English and Japanese: 12 texts, each between 80 and 120 words.");
    expect(meta).toMatchObject({ source: "scripted", model: null, degradedReason: null });

    expect(verify(ctx, artifacts).results).toEqual({
      deliverable_count: "pass",
      word_count: "pass",
      deadline: "pass",
      no_embedded_instructions: "pass",
    });
  });
});

describe("produceDelivery — revisions", () => {
  it("omits one variant on round 1 and adds exactly that variant on round 2, reusing the rest", async () => {
    const first = firstDelivery(BANNERS, seller("quickdraw"));
    const round1 = await produceDelivery(first, scriptedDeps);
    const delivered = illustrations(round1.artifacts);

    expect(delivered.map((file) => [file.index, file.aspectRatio])).toEqual([
      [1, "16:9"],
      [1, "1:1"],
      [2, "16:9"],
    ]);
    // The note is as confident as a complete delivery's.
    expect(round1.note).toContain("4 SVG files");
    const verdict1 = verify(first, round1.artifacts);
    expect(verdict1.results.aspect_ratio_coverage).toBe("fail");
    expect(verdict1.results.valid_format).toBe("pass");

    const second = revision(first, submissionOf(round1.artifacts), verdict1.checks);
    const round2 = await produceDelivery(second, scriptedDeps);
    const redelivered = illustrations(round2.artifacts);

    expect(redelivered.map((file) => [file.index, file.aspectRatio])).toEqual([
      [1, "16:9"],
      [1, "1:1"],
      [2, "16:9"],
      [2, "1:1"],
    ]);
    // Same ids, same bytes for the three files that were fine.
    expect(redelivered.slice(0, 3)).toEqual(delivered);
    const added = redelivered[3];
    expect(delivered.map((file) => file.id)).not.toContain(added.id);
    expect(signature(added)).toEqual(signature(delivered[2]));
    expect(added.title).toBe(delivered[2].title);
    expect({ width: added.width, height: added.height }).toEqual({ width: 1200, height: 1200 });

    expect(round2.note).toBe(
      "Revision 1: Added the missing 1:1 version of illustration #2. The other 3 files are unchanged from the previous round.",
    );
    expect(verify(second, round2.artifacts).checks.filter((check) => check.result !== "pass")).toEqual([]);
    expect(round2.meta).toMatchObject({ source: "scripted", model: null, degradedReason: null });
  });

  it("reworks only the illustration the report objected to, as a different scene", async () => {
    const first = firstDelivery(LANDING, seller("northwind"));
    const round1 = illustrations((await produceDelivery(first, scriptedDeps)).artifacts);
    const objected = round1[0];
    const second = revision(first, submissionOf(round1), [
      failedCheck("brief_adherence", [objected.id], "illustration #1 does not relate to a landing page"),
    ]);
    const round2 = await produceDelivery(second, scriptedDeps);
    const files = illustrations(round2.artifacts);

    expect(files).toHaveLength(6);
    // Illustrations #2 and #3 are carried over untouched.
    expect(files.slice(2)).toEqual(round1.slice(2));
    // Both ratios of #1 are new, still one illustration, and no longer the scene that was rejected.
    const [wide, square] = files;
    expect(round1.map((file) => file.id)).not.toContain(wide.id);
    expect(round1.map((file) => file.id)).not.toContain(square.id);
    expect(signature(wide)).toEqual(signature(square));
    expect(signature(wide).motif).not.toBe(signature(objected).motif);
    expect(files.slice(2).map((file) => signature(file).motif)).not.toContain(signature(wide).motif);
    expect(signature(wide).palette).toBe(signature(objected).palette);
    expect(wide.description).toContain("illustration 1 of 3");

    expect(round2.note).toBe(
      "Revision 1: Reworked illustration #1 in response to the verification report. The other 4 files are unchanged from the previous round.",
    );
    expect(verify(second, round2.artifacts).checks.filter((check) => check.result !== "pass")).toEqual([]);
  });

  it("reworks the whole set when a revision is requested without a specific finding", async () => {
    const first = firstDelivery(BANNERS, seller("northwind"));
    const round1 = illustrations((await produceDelivery(first, scriptedDeps)).artifacts);
    const round2 = await produceDelivery(revision(first, submissionOf(round1), []), scriptedDeps);
    const files = illustrations(round2.artifacts);

    expect(files).toHaveLength(4);
    for (const file of files) expect(round1.map((old) => old.id)).not.toContain(file.id);
    expect(files.map((file) => file.svg)).not.toEqual(round1.map((file) => file.svg));
    expect(round2.note).toBe("Revision 1: Reworked illustrations #1 and #2 in response to the verification report.");
  });

  it("re-renders a file whose real size is wrong, from its sibling's art direction", async () => {
    const first = firstDelivery(BANNERS, seller("northwind"));
    const round1 = illustrations((await produceDelivery(first, scriptedDeps)).artifacts);
    const broken = round1.map((file, i) => (i === 1 ? { ...file, width: 1000, height: 1200 } : file));
    const round2 = await produceDelivery(revision(first, submissionOf(broken), []), scriptedDeps);
    const files = illustrations(round2.artifacts);

    expect(files.map((file) => file.id)).toEqual([round1[0].id, files[1].id, round1[2].id, round1[3].id]);
    expect(files[1].id).not.toBe(round1[1].id);
    expect(files[1].svg).toBe(round1[1].svg);
    expect({ width: files[1].width, height: files[1].height }).toEqual({ width: 1200, height: 1200 });
  });

  it("redraws every variant of an illustration it cannot match to a foreign sibling", async () => {
    const first = firstDelivery(BANNERS, seller("northwind"));
    const round1 = illustrations((await produceDelivery(first, scriptedDeps)).artifacts);
    const foreign: IllustrationArtifact = {
      ...round1[2],
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><rect width="1600" height="900"/></svg>',
    };
    // Illustration #2 arrives as a third-party file in 16:9 only.
    const round2 = await produceDelivery(revision(first, submissionOf([round1[0], round1[1], foreign]), []), scriptedDeps);
    const files = illustrations(round2.artifacts);

    expect(files.slice(0, 2)).toEqual(round1.slice(0, 2));
    expect(files[2].id).not.toBe(foreign.id);
    expect(signature(files[2])).toEqual(signature(files[3]));
    expect(signature(files[2]).motif).not.toBe(signature(files[0]).motif);
  });

  it("rewrites only the copy that is out of range or objected to", async () => {
    const spec: CopySpec = { ...DESCRIPTIONS, count: 3 };
    const first = firstDelivery(spec, seller("lingua"));
    const round1 = texts((await produceDelivery(first, scriptedDeps)).artifacts);
    const previous = round1.map((piece, i) => (i === 1 ? { ...piece, text: "短すぎます。" } : piece));
    const second = revision(first, submissionOf(previous), [failedCheck("brief_adherence", [round1[4].id])]);
    const round2 = await produceDelivery(second, scriptedDeps);
    const pieces = texts(round2.artifacts);

    expect(pieces).toHaveLength(6);
    // #1 en, #2 en and #2 ja are kept; #1 ja is written again; both versions of #3 are reworked.
    expect([pieces[0], pieces[2], pieces[3]]).toEqual([round1[0], round1[2], round1[3]]);
    expect(pieces[1].id).not.toBe(round1[1].id);
    expect(pieces[1].text).toBe(round1[1].text);
    expect(pieces[4].id).not.toBe(round1[4].id);
    expect(pieces[5].id).not.toBe(round1[5].id);
    expect(pieces[4].text).not.toBe(round1[4].text);
    expect(pieces[4].title).toBe(round1[4].title);
    expect(round2.note).toBe(
      "Revision 1: Added the missing Japanese version of copy piece #1. Reworked copy piece #3 in response to the verification report. The other 3 files are unchanged from the previous round.",
    );
    expect(verify(second, round2.artifacts).checks.filter((check) => check.result !== "pass")).toEqual([]);
  });
});

describe("produceDelivery — AI studio", () => {
  const modelDirections = {
    directions: [
      { motif: "growth", palette: "orchid", title: "Momentum", description: "A bar chart whose trend line breaks out as an arrow." },
      { motif: "network", palette: "orchid", title: "Connected", description: "A hub wired to a ring of service tiles." },
      { motif: "launch", palette: "orchid", title: "Lift-off", description: "A rocket lifting off a curved horizon." },
    ],
  };

  it("renders the model's art direction and reports the model", async () => {
    const { call, requests } = stubCall(() => modelDirections);
    const ctx = firstDelivery(LANDING, seller("northwind"));
    const { artifacts, meta } = await produceDelivery(ctx, { mode: "ai", call });
    const files = illustrations(artifacts);

    expect(requests).toHaveLength(1);
    expect(files.map((file) => signature(file).motif)).toEqual(["growth", "growth", "network", "network", "launch", "launch"]);
    expect(new Set(files.map((file) => signature(file).palette))).toEqual(new Set(["orchid"]));
    expect(files[0].title).toBe("Momentum");
    expect(files[5].description).toBe("A rocket lifting off a curved horizon.");
    expect(meta).toMatchObject({ source: "ai", model: TEST_MODEL, degradedReason: null });
    expect(verify(ctx, artifacts).checks.filter((check) => check.result !== "pass")).toEqual([]);
  });

  it("falls back to the scripted studio when the model is unavailable, and says why", async () => {
    const call: CallStructured = async () => {
      throw new AiUnavailableError("timeout", "AI call failed (timeout)");
    };
    const ctx = firstDelivery(LANDING, seller("northwind"));
    const degraded = await produceDelivery(ctx, { mode: "ai", call });
    const scripted = await produceDelivery(ctx, scriptedDeps);

    expect(degraded.meta).toMatchObject({ source: "scripted", model: null, degradedReason: "timeout" });
    expect(illustrations(degraded.artifacts).map((file) => file.svg)).toEqual(
      illustrations(scripted.artifacts).map((file) => file.svg),
    );
  });

  it("does not hide programming errors behind the fallback", async () => {
    const call: CallStructured = async () => {
      throw new TypeError("boom");
    };
    await expect(produceDelivery(firstDelivery(LANDING, seller("northwind")), { mode: "ai", call })).rejects.toThrow("boom");
    await expect(produceDelivery(firstDelivery(DESCRIPTIONS, seller("lingua")), { mode: "ai", call })).rejects.toThrow("boom");
  });

  it("sends the verification findings to the model on a revision and keeps the set cohesive", async () => {
    const { call, requests } = stubCall(() => modelDirections);
    const first = firstDelivery(LANDING, seller("northwind"));
    const round1 = illustrations((await produceDelivery(first, { mode: "ai", call })).artifacts);
    const second = revision(first, submissionOf(round1, 1, "ai"), [
      failedCheck("brief_adherence", [round1[2].id], "illustration #2 shows servers, not a landing page"),
    ]);
    const round2 = await produceDelivery(second, { mode: "ai", call });
    const files = illustrations(round2.artifacts);

    expect(requests).toHaveLength(2);
    expect(requests[1].prompt).toContain("illustration #2 shows servers, not a landing page");
    expect([files[0], files[1], files[4], files[5]]).toEqual([round1[0], round1[1], round1[4], round1[5]]);
    // The model proposed "network" for #2 again; the studio does not redeliver the rejected scene.
    expect(signature(files[2]).motif).not.toBe("network");
    expect(["growth", "launch"]).not.toContain(signature(files[2]).motif);
    expect(signature(files[2]).palette).toBe("orchid");
    expect(round2.meta).toMatchObject({ source: "ai", model: TEST_MODEL });
  });

  it("keeps the previous authorship when a revision needs no new creative work", async () => {
    const { call, requests } = stubCall(() => ({ directions: modelDirections.directions.slice(0, 2) }));
    const first = firstDelivery(BANNERS, seller("quickdraw"));
    const round1 = await produceDelivery(first, { mode: "ai", call });
    const verdict = verify(first, round1.artifacts);
    const round2 = await produceDelivery(revision(first, submissionOf(round1.artifacts, 1, "ai"), verdict.checks), { mode: "ai", call });

    expect(round1.artifacts).toHaveLength(3);
    expect(round2.artifacts).toHaveLength(4);
    // Adding the missing ratio is pure rendering: the model is not asked again.
    expect(requests).toHaveLength(1);
    expect(round2.meta).toMatchObject({ source: "ai", model: TEST_MODEL, degradedReason: null });
    expect(round2.note).toContain("Added the missing 1:1 version of illustration #2.");
  });

  it("writes copy with the model, backfilling slots it got wrong", async () => {
    const spec: CopySpec = { ...DESCRIPTIONS, count: 1, minWords: 10, maxWords: 30 };
    const good = "Every cup starts with fresh beans, steady pressure and water at exactly the right temperature.";
    const { call, requests } = stubCall(() => ({
      pieces: [
        { index: 1, language: "en", title: "A better morning", text: good },
        { index: 1, language: "ja", title: "短い", text: "おいしい。" },
      ],
    }));
    const ctx = firstDelivery(spec, seller("lingua"));
    const { artifacts, meta } = await produceDelivery(ctx, { mode: "ai", call });
    const [english, japanese] = texts(artifacts);

    expect(requests).toHaveLength(1);
    expect(english).toMatchObject({ index: 1, language: "en", title: "A better morning", text: good });
    expect(japanese.language).toBe("ja");
    expect(countWords(japanese.text, "ja")).toBeGreaterThanOrEqual(10);
    expect(countWords(japanese.text, "ja")).toBeLessThanOrEqual(30);
    expect(meta).toMatchObject({ source: "ai", model: TEST_MODEL, degradedReason: null });
    expect(verify(ctx, artifacts).results.word_count).toBe("pass");
  });

  it("falls back to scripted copy when the model is unavailable", async () => {
    const call: CallStructured = async () => {
      throw new AiUnavailableError("rate_limited", "AI call failed (rate_limited)");
    };
    const ctx = firstDelivery(DESCRIPTIONS, seller("lingua"));
    const { artifacts, meta } = await produceDelivery(ctx, { mode: "ai", call });
    expect(artifacts).toHaveLength(12);
    expect(meta).toMatchObject({ source: "scripted", model: null, degradedReason: "rate_limited" });
    expect(verify(ctx, artifacts).results.word_count).toBe("pass");
  });
});

describe("produceDelivery — hostile seller (controlled demo fault)", () => {
  const WEBINAR: IllustrationSpec = {
    kind: "illustration",
    count: 2,
    aspectRatios: ["16:9"],
    subject: "hero illustrations for a security webinar page",
    style: null,
  };

  it("embeds instructions in every file, which stay valid SVG but fail the instruction check", async () => {
    const ctx = firstDelivery(WEBINAR, seller("pixelharbor"));
    const { artifacts, note } = await produceDelivery(ctx, scriptedDeps);
    const files = illustrations(artifacts);

    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(file.svg).toContain(INJECTED_INSTRUCTION);
      expect(file.description.endsWith(INJECTED_DESCRIPTION_SUFFIX)).toBe(true);
      expect(ArtifactSchema.safeParse(file).success).toBe(true);
      expect(sanitizeSvg(file.svg)).toEqual({ ok: true, svg: file.svg });
    }
    expect(signature(files[0]).motif).toBe("security");
    expect(note).not.toMatch(/verifier|instruction/i);
    expect(verify(ctx, artifacts).results).toEqual({
      deliverable_count: "pass",
      aspect_ratio_coverage: "pass",
      valid_format: "pass",
      deadline: "pass",
      no_embedded_instructions: "fail",
    });
  });

  it("embeds them again on a revision, exactly once per file", async () => {
    const first = firstDelivery(WEBINAR, seller("pixelharbor"));
    const round1 = await produceDelivery(first, scriptedDeps);
    const verdict = verify(first, round1.artifacts);
    const round2 = await produceDelivery(revision(first, submissionOf(round1.artifacts), verdict.checks), scriptedDeps);

    for (const file of illustrations(round2.artifacts)) {
      expect(file.svg.split(INJECTED_INSTRUCTION)).toHaveLength(2);
      expect(file.description.split(INJECTED_DESCRIPTION_SUFFIX)).toHaveLength(2);
      expect(round1.artifacts.map((old) => old.id)).not.toContain(file.id);
    }
  });
});

describe("svgToDataUri", () => {
  it("percent-encodes the markup into an image data URI", () => {
    const { svg } = renderIllustration(
      { motif: "abstract", palette: "ember", title: "Ünïcode & <tags> 日本語", description: "100% #1", seed: 7 },
      "1:1",
    );
    const uri = svgToDataUri(svg);
    expect(uri.startsWith("data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D")).toBe(true);
    expect(uri).not.toMatch(/[<>"#\s]/);
    expect(decodeURIComponent(uri.slice(uri.indexOf(",") + 1))).toBe(svg);
  });
});
