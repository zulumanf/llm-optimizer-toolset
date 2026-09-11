/**
 * Spec 137 — video-ready contract (tests 39–44): scenes and script come only
 * from the manifest, derived values are precomputed, factual lines cite
 * fact ids, the artifact traces to evidence + template + intro + voice
 * versions, and a superseded manifest invalidates a pending video.
 */
import { describe, expect, it } from "vitest";
import { assertVideoMatchesManifest, compileVideoWalkthrough, videoArtifactStale, type VideoWalkthroughInput } from "@/lib/prospects/video-walkthrough-contract";
import { MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";
import { manifestFor } from "../fixtures/fact-manifest";

const snapshot: MismatchEvidenceSnapshot = {
  templateVersion: "competitive_mismatch_reply_v1", runId: "run-1", provider: "openai", answerCount: 256, modelCount: 1,
  capturedAt: null, completedAt: null, scopeCopy: "", audiences: [],
  prospect: { companyId: "p", prospectId: null, name: "Blu House Properties", recommendationCount: 2, productionSignalId: "rp", productionSourceUrl: "", productionYear: 2025, productionValue: 56_900_000, productionDisplay: "$56.9M closed" },
  competitor: { companyId: "c", prospectId: null, name: "Harbor View Group", recommendationCount: 25, productionSignalId: "rc", productionSourceUrl: "", productionYear: 2025, productionValue: 24_900_000, productionDisplay: "$24.9M closed", productionRatio: 0.44, recommendationGap: 23 },
  metricType: "closed_volume", thresholds: MISMATCH_THRESHOLDS,
};
const manifest = manifestFor(snapshot, "team", { exampleIds: ["r1", "r2"], firstActionId: "priority-1:abc" });
const input: VideoWalkthroughInput = {
  prospect: { name: "Blu House Properties", firstName: "Ryan", entityType: "team" },
  market: "Grand Rapids", evidencePackageId: manifest.evidenceHash, factManifestId: "manifest-row-1", manifest,
  approvedExamples: [{ id: "r1", question: "Who should I hire to sell in East Grand Rapids?", quote: "Harbor View Group is a strong choice." }, { id: "r2", question: "Best listing agent downtown?", quote: "Consider Harbor View Group." }],
  approvedFirstAction: { id: "priority-1:abc", title: "Seller-side presence", body: "Check what the answers pointed to." },
  reportArtifact: { artifactId: "art-1", revision: 1 }, templateVersion: "video-script-v1", introAssetVersion: "intro-2026-09", voiceVersion: "elevenlabs:francisco:v1",
};

describe("video-ready contract", () => {
  it("39/40: scenes carry precomputed manifest displays only; every numeric scene passes the manifest check", () => {
    const v = compileVideoWalkthrough(input);
    expect(v.scenes.map((s) => s.kind)).toEqual(["FounderIntroScene", "ProspectTitleScene", "ProductionComparisonScene", "RecommendationComparisonScene", "ExampleEvidenceScene", "ExampleEvidenceScene", "FirstActionScene", "ClosingScene"]);
    const rec = v.scenes[3];
    expect(rec).toMatchObject({ kind: "RecommendationComparisonScene", recommendationMultiple: "12.5x as often", denominator: "256" });
    expect(v.scenes[2]).toMatchObject({ productionRatio: "roughly 44%" });
    expect(assertVideoMatchesManifest(v, manifest, input)).toEqual([]);
    expect(v.videoFactManifest.manifestHash).toBe(manifest.manifestHash);
  });
  it("41: a scene that states a figure the manifest does not license fails machine QA (no OCR needed)", () => {
    const v = compileVideoWalkthrough(input);
    const tampered = { ...v, scenes: v.scenes.map((s) => (s.kind === "RecommendationComparisonScene" ? { ...s, competitorRecommendations: "26" } : s)) };
    expect(assertVideoMatchesManifest(tampered, manifest, input).map((i) => i.check)).toContain("unmanifested_number");
    const leak = { ...v, scenes: [...v.scenes, { kind: "ProspectTitleScene", prospectName: "x", market: "y", runId: "r" } as never] };
    expect(assertVideoMatchesManifest(leak, manifest, input).map((i) => i.check)).toContain("internal_field_rendered");
  });
  it("42: every factual script line cites fact ids; an unapproved example is rejected", () => {
    const v = compileVideoWalkthrough(input);
    for (const line of v.script) if (/\d/.test(line.text)) expect(line.factIds.length + line.approvedIds.length, line.text).toBeGreaterThan(0);
    const bad = { ...input, approvedExamples: [...input.approvedExamples, { id: "r9", question: "?", quote: "x" }] };
    expect(assertVideoMatchesManifest(compileVideoWalkthrough(bad), manifest, bad).map((i) => i.check)).toContain("unapproved_example");
  });
  it("43/44: the content hash traces evidence + script + versions; a superseded manifest makes the pending video stale", () => {
    const a = compileVideoWalkthrough(input);
    expect(compileVideoWalkthrough(input).contentHash).toBe(a.contentHash);
    expect(compileVideoWalkthrough({ ...input, voiceVersion: "v2" }).contentHash).not.toBe(a.contentHash);
    expect(compileVideoWalkthrough({ ...input, introAssetVersion: "intro-2026-10" }).contentHash).not.toBe(a.contentHash);
    const corrected = manifestFor({ ...snapshot, competitor: { ...snapshot.competitor, recommendationCount: 29 } }, "team", { exampleIds: ["r1", "r2"], firstActionId: "priority-1:abc" });
    expect(videoArtifactStale({ manifestHash: a.videoFactManifest.manifestHash }, corrected)).toEqual({ stale: true, reason: "fact manifest superseded" });
    expect(videoArtifactStale({ manifestHash: a.videoFactManifest.manifestHash }, manifest).stale).toBe(false);
  });
});
