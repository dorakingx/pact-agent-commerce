import { describe, expect, it } from "vitest";
import type { CopyArtifact, CopySpec, IllustrationSpec, Submission } from "@/lib/domain/schemas";
import { runDeterministicChecks } from "@/lib/domain/verification";
import {
  checkForMissingSlot,
  copyPieces,
  decisionBanner,
  deliveryGrid,
  deliverySummary,
  evidenceTarget,
  illustrationGroups,
  isCoverageCheck,
  missingVariantEvidence,
  notDeliveredLabel,
  selectedRound,
  submissionLabel,
  tallyChecks,
} from "./deal-derive-delivery";
import { contractOf, illustration, report, submission } from "./deal-derive.fixtures";

const SPEC: IllustrationSpec = { kind: "illustration", count: 2, aspectRatios: ["16:9", "1:1"], subject: "launch banners", style: null };

function withFiles(base: Submission, artifacts: Submission["artifacts"]): Submission {
  return { ...base, artifacts };
}

describe("submissionLabel", () => {
  it("names the first delivery and every revision after it", () => {
    expect(submissionLabel(1)).toBe("Delivery 1");
    expect(submissionLabel(2)).toBe("Revision 1");
    expect(submissionLabel(4)).toBe("Revision 3");
  });
});

describe("illustrationGroups", () => {
  it("lays a complete delivery out as one filled slot per contracted variant", () => {
    const groups = illustrationGroups(SPEC, submission(2));
    expect(groups.map((group) => group.index)).toEqual([1, 2]);
    expect(groups.every((group) => group.missing === 0)).toBe(true);
    expect(groups[1].slots.map((slot) => [slot.ratio, slot.artifact?.id, slot.required])).toEqual([
      ["16:9", "art_2w", true],
      ["1:1", "art_2s", true],
    ]);
  });

  it("shows the omitted 1:1 of illustration #2 as an empty required slot", () => {
    const groups = illustrationGroups(SPEC, submission(1));
    expect(groups[0].missing).toBe(0);
    expect(groups[1].missing).toBe(1);
    const missing = groups[1].slots.find((slot) => slot.artifact === null);
    expect(missing).toMatchObject({ key: "1:2:1:1", index: 2, ratio: "1:1", required: true, evidence: "1:1 missing on illustration #2" });
  });

  it("describes a missing variant in exactly the words the verifier uses", () => {
    const contract = contractOf(2800).contract;
    const checks = runDeterministicChecks(contract, submission(1));
    const coverage = checks.find((check) => check.kind === "aspect_ratio_coverage");
    expect(coverage?.result).toBe("fail");
    const missing = illustrationGroups(SPEC, submission(1))
      .flatMap((group) => group.slots)
      .filter((slot) => slot.artifact === null);
    expect(missing).toHaveLength(1);
    expect(coverage?.evidence).toBe(missing[0].evidence);
    expect(missingVariantEvidence("1:1", 2)).toBe(coverage?.evidence);
  });

  it("agrees with the verifier about which variants are missing, whatever is left out", () => {
    const contract = contractOf(2800).contract;
    const full = submission(2).artifacts;
    for (let dropped = 0; dropped < full.length; dropped += 1) {
      const partial = withFiles(submission(1), full.filter((_, index) => index !== dropped));
      const coverage = runDeterministicChecks(contract, partial).find((check) => check.kind === "aspect_ratio_coverage");
      const evidence = illustrationGroups(SPEC, partial)
        .flatMap((group) => group.slots)
        .filter((slot) => slot.artifact === null)
        .map((slot) => slot.evidence);
      expect(evidence).toHaveLength(1);
      expect(coverage?.evidence).toBe(evidence[0]);
    }
  });

  it("matches by real dimensions, not by the seller's label", () => {
    // A square file labelled 16:9 fills the 1:1 slot and leaves 16:9 missing.
    const mislabelled = withFiles(submission(1), [illustration("a", 1, 1200, 1200, "16:9")]);
    const [first] = illustrationGroups({ ...SPEC, count: 1 }, mislabelled);
    expect(first.slots.map((slot) => [slot.ratio, slot.artifact?.id ?? null])).toEqual([
      ["16:9", null],
      ["1:1", "a"],
    ]);
  });

  it("accepts the verifier's 1% tolerance and refuses anything beyond it", () => {
    const within = withFiles(submission(1), [illustration("a", 1, 1010, 1000, "1:1")]);
    const beyond = withFiles(submission(1), [illustration("a", 1, 1030, 1000, "1:1")]);
    const spec: IllustrationSpec = { ...SPEC, count: 1, aspectRatios: ["1:1"] };
    expect(illustrationGroups(spec, within)[0].slots[0].artifact?.id).toBe("a");
    const slots = illustrationGroups(spec, beyond)[0].slots;
    expect(slots[0].artifact).toBeNull();
    // The file is still shown, as something the contract did not ask for.
    expect(slots[1]).toMatchObject({ required: false, ratio: "1:1" });
    expect(slots[1].artifact?.id).toBe("a");
  });

  it("uses one file per slot, so a duplicate does not hide a gap", () => {
    const duplicate = withFiles(submission(1), [illustration("a", 1, 1600, 900, "16:9"), illustration("b", 1, 1600, 900, "16:9")]);
    const [group] = illustrationGroups({ ...SPEC, count: 1 }, duplicate);
    expect(group.slots.map((slot) => [slot.ratio, slot.artifact?.id ?? null, slot.required])).toEqual([
      ["16:9", "a", true],
      ["1:1", null, true],
      ["16:9", "b", false],
    ]);
    expect(group.missing).toBe(1);
  });

  it("keeps a whole missing illustration visible as empty slots", () => {
    const onlyFirst = withFiles(submission(1), [illustration("a", 1, 1600, 900, "16:9"), illustration("b", 1, 1200, 1200, "1:1")]);
    const groups = illustrationGroups(SPEC, onlyFirst);
    expect(groups).toHaveLength(2);
    expect(groups[1]).toMatchObject({ index: 2, title: null, missing: 2 });
  });

  it("appends files beyond the contracted count as extras", () => {
    const extra = withFiles(submission(2), [...submission(2).artifacts, illustration("x", 3, 1000, 1500, "portrait")]);
    const groups = illustrationGroups(SPEC, extra);
    expect(groups).toHaveLength(3);
    expect(groups[2].slots).toEqual([expect.objectContaining({ required: false, ratio: "portrait", evidence: null })]);
  });

  it("without a spec lists what was sent and reports nothing as missing", () => {
    const groups = illustrationGroups(null, submission(1));
    expect(groups.flatMap((group) => group.slots).every((slot) => !slot.required && slot.artifact !== null)).toBe(true);
    expect(groups.reduce((total, group) => total + group.missing, 0)).toBe(0);
  });
});

const COPY_SPEC: CopySpec = { kind: "copy", count: 2, languages: ["en", "ja"], minWords: 5, maxWords: 20, subject: "espresso machines", tone: null };

function copy(id: string, index: number, language: string, text: string): CopyArtifact {
  return { id, kind: "copy", index, title: `Piece ${index}`, language, text };
}

describe("copyPieces", () => {
  const delivered: Submission = withFiles(submission(1), [
    copy("c1e", 1, "en", "A compact machine that pulls a rich espresso every single morning."),
    copy("c1j", 1, "ja", "毎朝、濃厚なエスプレッソを抽出するコンパクトなマシンです。"),
    copy("c2e", 2, "EN", "Steam milk like a barista with one simple dial."),
  ]);

  it("gives every contracted piece one variant per contracted language", () => {
    const pieces = copyPieces(COPY_SPEC, delivered);
    expect(pieces.map((piece) => piece.variants.map((variant) => [variant.language, variant.artifact?.id ?? null]))).toEqual([
      [
        ["en", "c1e"],
        ["ja", "c1j"],
      ],
      [
        ["en", "c2e"],
        ["ja", null],
      ],
    ]);
    expect(pieces[1].missing).toBe(1);
    expect(pieces[1].variants[1]).toMatchObject({ languageLabel: "Japanese", words: 0, required: true });
  });

  it("counts words the way the verifier does, including text without spaces", () => {
    const [first] = copyPieces(COPY_SPEC, delivered);
    expect(first.variants[0].words).toBe(11);
    expect(first.variants[1].words).toBeGreaterThan(5);
  });

  it("shows a text in an uncontracted language as an extra", () => {
    const withFrench = withFiles(delivered, [...delivered.artifacts, copy("c1f", 1, "fr", "Une machine compacte pour un espresso riche.")]);
    const [first] = copyPieces(COPY_SPEC, withFrench);
    expect(first.variants[2]).toMatchObject({ required: false, languageLabel: "French" });
  });

  it("labels an unknown language tag without trusting its length", () => {
    const odd = withFiles(delivered, [copy("z", 1, "klingon-with-a-very-long-tag", "nuqneH")]);
    const [first] = copyPieces(null, odd);
    expect(first.variants[0].languageLabel.length).toBeLessThanOrEqual(8);
  });
});

describe("deliveryGrid", () => {
  it("summarises an incomplete illustration delivery", () => {
    const grid = deliveryGrid(SPEC, submission(1));
    expect(grid).toMatchObject({ kind: "illustration", delivered: 3, missing: 1, missingKeys: ["1:2:1:1"] });
    expect(deliverySummary(grid)).toBe("3 files · 1 missing");
  });
  it("summarises a complete one", () => {
    const grid = deliveryGrid(SPEC, submission(2));
    expect(grid.missing).toBe(0);
    expect(deliverySummary(grid)).toBe("4 files");
    expect(deliverySummary({ delivered: 1, missing: 0 })).toBe("1 file");
  });
  it("falls back to what the files are when there is no spec", () => {
    expect(deliveryGrid(null, submission(1)).kind).toBe("illustration");
    expect(deliveryGrid(null, withFiles(submission(1), [copy("c", 1, "en", "Hello there.")])).kind).toBe("copy");
  });
});

describe("linking a verification row to the delivery", () => {
  const grid = deliveryGrid(SPEC, submission(1));
  const failed = report(1, "revision_required");
  const coverage = failed.checks.find((check) => check.ruleId === "R2");
  if (coverage === undefined) throw new Error("fixture");

  it("a failed coverage row points at the files it names and at the empty slot", () => {
    expect(evidenceTarget(coverage, 1, grid)).toEqual({
      round: 1,
      ruleId: "R2",
      result: "fail",
      artifactIds: ["art_2w"],
      missingKeys: ["1:2:1:1"],
    });
  });

  it("a passing row points at nothing", () => {
    const passing = failed.checks.find((check) => check.ruleId === "R1");
    if (passing === undefined) throw new Error("fixture");
    expect(evidenceTarget(passing, 1, grid)).toBeNull();
  });

  it("a row that is not about coverage never claims the empty slots", () => {
    const hostile = { ruleId: "R6", kind: "no_embedded_instructions" as const, result: "fail" as const, artifactIds: ["art_1w"] };
    expect(evidenceTarget(hostile, 1, grid)).toMatchObject({ artifactIds: ["art_1w"], missingKeys: [] });
  });

  it("a row with nothing to point at is not a link", () => {
    const uncertain = { ruleId: "R5", kind: "brief_adherence" as const, result: "uncertain" as const, artifactIds: [] };
    expect(evidenceTarget(uncertain, 1, grid)).toBeNull();
    expect(evidenceTarget(coverage, 1, null)).toMatchObject({ missingKeys: [] });
  });

  it("finds the row an empty slot belongs to", () => {
    expect(checkForMissingSlot(failed)?.ruleId).toBe("R2");
    expect(checkForMissingSlot(report(2, "capture_eligible"))).toBeNull();
    expect(checkForMissingSlot(null)).toBeNull();
  });

  it("prefers the variant rule over the count rule when both failed", () => {
    const both = {
      checks: failed.checks.map((check) => (check.ruleId === "R1" ? { ...check, result: "fail" as const } : check)),
    };
    expect(checkForMissingSlot(both)?.ruleId).toBe("R2");
    const onlyCount = { checks: both.checks.map((check) => (check.ruleId === "R2" ? { ...check, result: "pass" as const } : check)) };
    expect(checkForMissingSlot(onlyCount)?.ruleId).toBe("R1");
  });

  it("knows which rule kinds are about something being absent", () => {
    expect(isCoverageCheck({ kind: "aspect_ratio_coverage" })).toBe(true);
    expect(isCoverageCheck({ kind: "language_coverage" })).toBe(true);
    expect(isCoverageCheck({ kind: "deliverable_count" })).toBe(true);
    expect(isCoverageCheck({ kind: "deadline" })).toBe(false);
  });
});

describe("the grid and the verifier use the same words", () => {
  it("the placeholder label and the evidence line name the same variant", () => {
    expect(notDeliveredLabel("1:1")).toBe("1:1 — not delivered");
    expect(missingVariantEvidence("1:1", 2)).toBe("1:1 missing on illustration #2");
  });
});

describe("tallyChecks and decisionBanner", () => {
  it("counts results", () => {
    expect(tallyChecks(report(1, "revision_required").checks)).toEqual({ total: 6, passed: 5, failed: 1, uncertain: 0 });
    expect(tallyChecks(report(1, "human_review").checks)).toEqual({ total: 6, passed: 5, failed: 0, uncertain: 1 });
    expect(tallyChecks([])).toEqual({ total: 0, passed: 0, failed: 0, uncertain: 0 });
  });

  it("capture eligible is emerald and says capture may happen", () => {
    expect(decisionBanner(report(2, "capture_eligible"), 1)).toMatchObject({
      tone: "success",
      title: "All conditions verified — eligible for capture",
      detail: "6 of 6 conditions passed. PACT may now capture the held payment.",
    });
  });

  it("revision required is amber, says nothing was captured and which revision is used", () => {
    const banner = decisionBanner(report(1, "revision_required"), 1);
    expect(banner.tone).toBe("hold");
    expect(banner.title).toBe("Not captured. 1 condition failed — sent back for revision (1 of 1 used)");
    expect(banner.detail).toContain("1:1 missing on illustration #2");
    expect(banner.detail).toContain("funds stay held");
  });

  it("human review is violet; reject is red and announces the void", () => {
    expect(decisionBanner(report(1, "human_review"), 1)).toMatchObject({ tone: "review", title: "Not captured — a human must decide" });
    const rejected = decisionBanner(report(2, "reject"), 1);
    expect(rejected.tone).toBe("danger");
    expect(rejected.detail).toContain("voided");
  });
});

describe("selectedRound", () => {
  it("shows the latest round by default", () => {
    expect(selectedRound([], null)).toBeNull();
    expect(selectedRound([1], null)).toBe(1);
    expect(selectedRound([1, 2], null)).toBe(2);
  });
  it("honours the viewer's pick while no newer round has arrived", () => {
    expect(selectedRound([1, 2], { round: 1, total: 2 })).toBe(1);
  });
  it("drops a pick made before a newer round arrived, or for a round that does not exist", () => {
    expect(selectedRound([1, 2], { round: 1, total: 1 })).toBe(2);
    expect(selectedRound([1, 2], { round: 7, total: 2 })).toBe(2);
  });
});
