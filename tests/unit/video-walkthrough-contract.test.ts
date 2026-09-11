/**
 * Spec 137 — video-ready contract (tests 39–44): scenes and script come only
 * from the manifest, derived values are precomputed, factual lines cite
 * fact ids, the artifact traces to evidence + template + intro + voice
 * versions, and a superseded manifest invalidates a pending video.
 */
import { describe, expect, it } from "vitest";
import { assertVideoMatchesManifest, assertVideoScriptReleasable, compileVideoWalkthrough, narrationSegments, videoArtifactStale, VIDEO_MAX_EXAMPLES, type VideoWalkthroughInput } from "@/lib/prospects/video-walkthrough-contract";
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
  reportArtifact: { artifactId: "art-1", revision: 1 }, templateVersion: "video-script-v1", introAssetVersion: "intro-2026-09", introTranscript: "Hey, Francisco here.", voiceVersion: "elevenlabs:francisco:v1",
};

describe("video-ready contract", () => {
  it("39/40: scenes carry precomputed manifest displays only; every numeric scene passes the manifest check", () => {
    const v = compileVideoWalkthrough(input);
    expect(v.scenes.map((s) => s.kind)).toEqual(["FounderIntroScene", "ProspectTitleScene", "ProductionComparisonScene", "RecommendationComparisonScene", "MismatchInterpretationScene", "ExampleEvidenceScene", "ExampleEvidenceScene", "FirstActionScene", "ClosingScene"]);
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
    const bad = { ...input, approvedExamples: [...input.approvedExamples, { id: "r0", question: "?", quote: "x" }] };
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

describe("spec 138 script compiler + deterministic script QA (matrix 8–19)", () => {
  const v = compileVideoWalkthrough(input);
  it("8/9/13: every placeholder resolves from the manifest; the denominator, names and market are narrated; the intro is the recorded line", () => {
    expect(assertVideoScriptReleasable(v, input)).toEqual([]);
    const text = v.script.filter((l) => l.narration === "tts").map((l) => l.text).join("\n");
    expect(text).toContain("256 questions");
    expect(text).toContain("the OpenAI model behind ChatGPT");
    expect(text).toContain("$56.9M closed");
    expect(text).toContain("$24.9M closed");
    expect(text).toContain("roughly 44%");
    expect(text).toContain("12.5x as often");
    expect(text).not.toMatch(/\{[a-z_]+\}|undefined|null/i);
    expect(v.script[0]).toMatchObject({ sceneIndex: 0, narration: "recorded", text: "Hey, Francisco here." });
    expect(narrationSegments(v).map((s) => s.sceneIndex)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it("10/11/12: a wrong prospect, competitor or market in the narration is caught", () => {
    const wrongName = { ...v, script: v.script.map((l) => ({ ...l, text: l.text.replace("Ryan", "Laura").replace("Harbor View Group", "Other Group").replace("Reno", "Boise") })) };
    const checks = assertVideoScriptReleasable(wrongName, input).map((i) => i.check);
    expect(checks).toContain("prospect_missing");
    expect(checks).toContain("competitor_missing");
    expect(checks).toContain("market_missing");
  });
  it("14/15: only approved examples (capped, deterministic order) and only the approved first action reach scenes", () => {
    const many = { ...input, approvedExamples: [{ id: "r2", question: "b", quote: "b" }, { id: "r1", question: "a", quote: "a" }, { id: "r0", question: "z", quote: "z" }] };
    const c = compileVideoWalkthrough(many);
    expect(c.scenes.filter((s) => s.kind === "ExampleEvidenceScene").map((s) => (s as { exampleId: string }).exampleId)).toEqual(["r0", "r1"].slice(0, VIDEO_MAX_EXAMPLES));
    expect(assertVideoScriptReleasable(c, many).map((i) => i.check)).toContain("unapproved_example");
    const action = { ...input, approvedFirstAction: { id: "priority-1:zzz", title: "Invented", body: "x" } };
    expect(assertVideoScriptReleasable(compileVideoWalkthrough(action), action).map((i) => i.check)).toContain("unapproved_action");
    const none = { ...input, approvedFirstAction: null };
    expect(compileVideoWalkthrough(none).scenes.some((s) => s.kind === "FirstActionScene")).toBe(false);
  });
  it("16/17/18: pricing, guarantees, hard CTAs, consumer-ChatGPT overclaims and internal terms block deterministically", () => {
    const inject = (extra: string) => ({ ...v, script: v.script.map((l, k) => (k === v.script.length - 1 ? { ...l, text: `${l.text} ${extra}` } : l)) });
    expect(assertVideoScriptReleasable(inject("It is $7,500 per month."), input).map((i) => i.check)).toContain("banned_pricing");
    expect(assertVideoScriptReleasable(inject("I guarantee you will rank #1."), input).map((i) => i.check)).toContain("banned_guarantee");
    expect(assertVideoScriptReleasable(inject("Book a call now."), input).map((i) => i.check)).toContain("banned_hard_cta");
    expect(assertVideoScriptReleasable(inject("ChatGPT recommends them because of reviews."), input).map((i) => i.check)).toContain("banned_consumer_chatgpt");
    expect(assertVideoScriptReleasable(inject("The manifest says so."), input).map((i) => i.check)).toContain("banned_internal_term");
  });
  it("3/4/5/6: a caller cannot override a figure — a tampered count fails; a superseded manifest is stale", () => {
    const tampered = { ...v, script: v.script.map((l) => ({ ...l, text: l.text.replace("recommended 25 times", "recommended 26 times") })) };
    expect(assertVideoScriptReleasable(tampered, input).map((i) => i.check)).toContain("script_unmanifested_number");
    const corrected = manifestFor({ ...snapshot, competitor: { ...snapshot.competitor, recommendationCount: 29 } }, "team", { exampleIds: ["r1", "r2"], firstActionId: "priority-1:abc" });
    expect(assertVideoScriptReleasable(v, input, corrected).map((i) => i.check)).toContain("stale_manifest");
  });
  it("zero prospect recommendations narrates 'not recommended in any', never '0 times'", () => {
    const zero = manifestFor({ ...snapshot, prospect: { ...snapshot.prospect, recommendationCount: 0 } }, "team", { exampleIds: ["r1", "r2"], firstActionId: "priority-1:abc" });
    const c = compileVideoWalkthrough({ ...input, manifest: zero });
    expect(c.script[3]!.text).toContain("your team was not recommended in any of them");
    expect(assertVideoScriptReleasable(c, { ...input, manifest: zero })).toEqual([]);
  });
});
