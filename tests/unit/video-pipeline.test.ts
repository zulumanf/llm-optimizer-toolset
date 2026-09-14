/**
 * Spec 138 — the video pipeline's pure parts: scene text safety (30), TTS
 * cache/retry/credentials (20–24), captions bound to the script (34–36),
 * artifact QA (25–29, 31), versioning identity (37–40), state machine,
 * failure classes, distribution labels (46–49).
 */
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClassifiedError } from "@/lib/errors";
import { compileVideoWalkthrough, type VideoScene } from "@/lib/prospects/video-walkthrough-contract";
import { canVideoTransition, classifyVideoFailure, introProbeIssue, resolveIntroAsset, videoGenerationKey, VIDEO_TRANSITIONS, resolveVideoConfig, CURRENT_GENERATION_VERSIONS } from "@/lib/prospects/video-walkthrough";
import { qaVideoArtifact } from "@/lib/video/artifact-qa";
import { buildCaptions, captionsScriptHash } from "@/lib/video/captions";
import { VIDEO_DURATION, VIDEO_FORMAT } from "@/lib/video/constants";
import { distributionAdapter } from "@/lib/video/distribution";
import { fitFontSize, FIT, renderSceneHtml, sceneLayoutIssues } from "@/lib/video/scenes";
import { elevenLabsProvider, mockTtsProvider, narrationCacheKey, pcmToWav, spokenForm, synthesizeCached, ttsFailureClass, wavDurationMs } from "@/lib/video/tts";
import { MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";
import { manifestFor } from "../fixtures/fact-manifest";

const voice = { version: "francisco-v1", provider: "elevenlabs" as const, voiceIdEnv: "ELEVENLABS_VOICE_ID", modelId: "m", settings: { stability: 0.5, similarityBoost: 0.8, style: 0 } };

describe("scenes: responsive text safety (30)", () => {
  it("long names, teams, values and three-digit counts fit by rule; the impossible is flagged, never silently overflowed", () => {
    const longName = "The Extraordinarily Long Real Estate Team Name of Greater Metropolitan Grand Rapids and Surrounding Lakeshore Communities Group";
    expect(fitFontSize(longName, FIT.title)).toBeLessThan(fitFontSize("Blu House", FIT.title));
    expect(fitFontSize("$1,234,567,890 closed", FIT.bigNumber)).toBeLessThan(FIT.bigNumber.maxPx);
    const scene: VideoScene = { kind: "RecommendationComparisonScene", prospectName: longName, prospectRecommendations: "112", competitorName: longName, competitorRecommendations: "256", denominator: "256", recommendationMultiple: "2.3x as often" };
    expect(sceneLayoutIssues(scene, 3)).toEqual([]);
    const absurd = { ...scene, prospectName: "x".repeat(400) };
    expect(sceneLayoutIssues(absurd, 3).map((i) => i.field)).toContain("prospectName");
    const html = renderSceneHtml(scene);
    expect(html).toContain(`width:${VIDEO_FORMAT.width}px`);
    expect(html).toContain("data-fit");
    expect(renderSceneHtml({ kind: "ExampleEvidenceScene", exampleId: "r1", question: "<script>alert(1)</script>", quote: "a & b" })).not.toContain("<script>alert");
  });
});

describe("tts: canonical script in, cached audio out (20–24)", () => {
  const root = mkdtempSync(join(tmpdir(), "video-tts-"));
  it("20/21: the same script revision + voice + segment is synthesized once; a retry or second worker reuses the WAV", async () => {
    const calls: string[] = [];
    const p = mockTtsProvider({ onCall: (t) => calls.push(t) });
    const key = narrationCacheKey({ scriptHash: "s1", voiceVersion: "francisco-v1", segmentIndex: 1, text: "Ryan, here is what stood out." });
    const a = await synthesizeCached(p, root, "narr", { key, text: "Ryan, here is what stood out.", voice, voiceId: "mock" });
    const b = await synthesizeCached(p, root, "narr", { key, text: "Ryan, here is what stood out.", voice, voiceId: "mock" });
    expect(calls.length).toBe(1);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(b.sha256).toBe(a.sha256);
    expect(readdirSync(join(root, "narr")).length).toBe(2);
    // A different script revision is a different narration.
    expect(narrationCacheKey({ scriptHash: "s2", voiceVersion: "francisco-v1", segmentIndex: 1, text: "Ryan, here is what stood out." })).not.toBe(key);
    expect(wavDurationMs(pcmToWav(Buffer.alloc(22_050 * 2), 22_050))).toBe(1000);
  });
  it("22/23/24: a timeout is retryable, missing credentials fail safely, and no key ever reaches a result or an error", async () => {
    expect(ttsFailureClass(new ClassifiedError("timeout", "x"))).toBe("RETRYABLE");
    expect(ttsFailureClass(new ClassifiedError("provider_rate_limit", "x"))).toBe("RETRYABLE");
    expect(ttsFailureClass(new ClassifiedError("provider_auth", "x"))).toBe("REVIEW_REQUIRED");
    const noKey = elevenLabsProvider({});
    await expect(noKey.synthesize({ text: "hi", voice, voiceId: "v" })).rejects.toMatchObject({ kind: "provider_auth" });
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init!.headers as Record<string, string> });
      return new Response(JSON.stringify({ audio_base64: Buffer.alloc(44_100).toString("base64"), alignment: { characters: ["h", "i"], character_start_times_seconds: [0, 0.5], character_end_times_seconds: [0.5, 1] } }), { status: 200 });
    }) as typeof fetch;
    const r = await elevenLabsProvider({ ELEVENLABS_API_KEY: "sk-secret-123" }, fetchImpl).synthesize({ text: "hi", voice, voiceId: "voice-abc" });
    expect(r.durationMs).toBe(1000);
    expect(r.alignment?.endsMs).toEqual([500, 1000]);
    expect(JSON.stringify(r)).not.toContain("sk-secret-123");
    expect(seen[0]!.headers["xi-api-key"]).toBe("sk-secret-123");
    expect(seen[0]!.url).not.toContain("sk-secret-123");
    const limited = elevenLabsProvider({ ELEVENLABS_API_KEY: "k" }, (async () => new Response("", { status: 429 })) as typeof fetch);
    await expect(limited.synthesize({ text: "hi", voice, voiceId: "v" })).rejects.toMatchObject({ kind: "provider_rate_limit" });
  });
});

describe("captions derive from the approved script (34–36)", () => {
  it("34/35: cues are the script's words with narration timing; the VTT names its script revision", () => {
    const seg = { text: "Ryan, here is what stood out in the Grand Rapids results.", offsetMs: 6_400, durationMs: 3_600, alignment: null };
    const c = buildCaptions([seg], "abc".padEnd(64, "0"));
    expect(c.cues[0]!.text).toContain("Ryan, here is what stood out");
    expect(c.cues[0]!.startMs).toBe(6_400);
    expect(c.vtt.startsWith("WEBVTT")).toBe(true);
    expect(captionsScriptHash(c.vtt)).toBe("abc".padEnd(64, "0"));
  });
  it("36: captions from an older script revision cannot pass artifact QA against newer narration", () => {
    const probe = { durationMs: 70_000, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, container: "mov,mp4" };
    const base = { probe, sizeBytes: 10, sha256: "h", storedSha256: "h", sceneCount: 8, plannedSceneCount: 8, introAssetVersion: "founder-intro-v1", expectedIntroAssetVersion: "founder-intro-v1", scriptHash: "new", captionsScriptHash: "old", renderOverflow: [], missingAssets: [], binding: { prospectId: "p", manifestHash: "m" }, expectedBinding: { prospectId: "p", manifestHash: "m" } };
    expect(qaVideoArtifact(base).failures.some((f) => f.startsWith("CAPTIONS_MATCH_SCRIPT"))).toBe(true);
    expect(qaVideoArtifact({ ...base, captionsScriptHash: "new" }).passed).toBe(true);
  });
});

describe("artifact QA is structural, never OCR (25–29, 31)", () => {
  const ok = { durationMs: 72_000, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, container: "mov,mp4" };
  const base = { probe: ok, sizeBytes: 1, sha256: "h", storedSha256: "h", sceneCount: 8, plannedSceneCount: 8, introAssetVersion: "founder-intro-v1", expectedIntroAssetVersion: "founder-intro-v1", scriptHash: "s", captionsScriptHash: "s", renderOverflow: [] as string[], missingAssets: [] as string[], binding: { prospectId: "p", manifestHash: "m" }, expectedBinding: { prospectId: "p", manifestHash: "m" } };
  it("passes a well-formed 72 s 1080p30 file and names every failure", () => {
    expect(qaVideoArtifact(base).passed).toBe(true);
    type Probe = typeof ok extends infer T ? { [K in keyof T]: T[K] | null } : never;
    const f = (over: Partial<Omit<typeof base, "probe">> & { probe?: Partial<Probe> }) => qaVideoArtifact({ ...base, ...over, probe: { ...ok, ...(over.probe ?? {}) } as typeof ok }).failures.map((x) => x.split(":")[0]);
    expect(f({ probe: { durationMs: 112_000 } })).toEqual(["VIDEO_DURATION_QA"]);
    expect(f({ probe: { durationMs: VIDEO_DURATION.minMs - 1 } })).toEqual(["VIDEO_DURATION_QA"]);
    expect(f({ probe: { hasAudio: false } })).toEqual(["AUDIO_STREAM"]);
    expect(f({ probe: { hasVideo: false, width: null, height: null, fps: null } })).toEqual(["VIDEO_STREAM", "RESOLUTION", "FRAME_RATE"]);
    expect(f({ probe: { width: 1280, height: 720 } })).toEqual(["RESOLUTION"]);
    expect(f({ sizeBytes: 0 })).toEqual(["FILE_NON_EMPTY"]);
    expect(f({ missingAssets: ["scene 5 has no narration"] })).toEqual(["SCENES_RESOLVED"]);
    expect(f({ renderOverflow: ["scene 1: fitted element 0 overflows horizontally"] })).toEqual(["NO_RENDER_OVERFLOW"]);
    expect(f({ introAssetVersion: "founder-intro-v2" })).toEqual(["INTRO_ASSET_VERSION"]);
    expect(f({ storedSha256: "other" })).toEqual(["CHECKSUM_STORED"]);
    expect(f({ expectedBinding: { prospectId: "p", manifestHash: "superseded" } })).toEqual(["BINDING"]);
  });
});

describe("versioning identity, state machine, failure classes, distribution (37–40, 46–49)", () => {
  const snapshot: MismatchEvidenceSnapshot = {
    templateVersion: "competitive_mismatch_reply_v1", runId: "run-1", provider: "openai", answerCount: 256, modelCount: 1, capturedAt: null, completedAt: null, scopeCopy: "", audiences: [],
    prospect: { companyId: "p", prospectId: null, name: "Blu House Properties", recommendationCount: 2, productionSignalId: "rp", productionSourceUrl: "", productionYear: 2025, productionValue: 56_900_000, productionDisplay: "$56.9M closed" },
    competitor: { companyId: "c", prospectId: null, name: "Harbor View Group", recommendationCount: 25, productionSignalId: "rc", productionSourceUrl: "", productionYear: 2025, productionValue: 24_900_000, productionDisplay: "$24.9M closed", productionRatio: 0.44, recommendationGap: 23 },
    metricType: "closed_volume", thresholds: MISMATCH_THRESHOLDS,
  };
  it("37–40: a new manifest, intro version or voice version is a NEW generation key; the same inputs are the same key", () => {
    const m1 = manifestFor(snapshot);
    const m2 = manifestFor({ ...snapshot, competitor: { ...snapshot.competitor, recommendationCount: 29 } });
    const k = (manifestHash: string, intro = "founder-intro-v1", voice = "francisco-v1") => videoGenerationKey({ prospectId: "p1", manifestHash, introAssetVersion: intro, voiceVersion: voice });
    expect(k(m1.manifestHash)).toBe(k(m1.manifestHash));
    expect(k(m2.manifestHash)).not.toBe(k(m1.manifestHash));
    expect(k(m1.manifestHash, "founder-intro-v2")).not.toBe(k(m1.manifestHash));
    expect(k(m1.manifestHash, "founder-intro-v1", "francisco-v2")).not.toBe(k(m1.manifestHash));
    // Pre-production review: every effective version participates. The
    // evidence hash and manifest version ride inside the manifest hash.
    const base = { prospectId: "p1", manifestHash: m1.manifestHash, introAssetVersion: "founder-intro-v1", voiceVersion: "francisco-v1" };
    expect(videoGenerationKey(base)).toBe(videoGenerationKey(base, CURRENT_GENERATION_VERSIONS));
    for (const field of ["contract", "scriptTemplate", "videoTemplate", "connective"] as const) {
      expect(videoGenerationKey(base, { ...CURRENT_GENERATION_VERSIONS, [field]: "v-next" }), field).not.toBe(videoGenerationKey(base));
    }
    const sameFacts = manifestFor(snapshot);
    expect(sameFacts.manifestHash).toBe(m1.manifestHash);
    const newEvidence = manifestFor({ ...snapshot, runId: "run-2" });
    expect(newEvidence.evidenceHash).not.toBe(m1.evidenceHash);
    expect(videoGenerationKey({ ...base, manifestHash: newEvidence.manifestHash })).not.toBe(videoGenerationKey(base));
    const a = compileVideoWalkthrough({ prospect: { name: "Blu House Properties", firstName: "Ryan", entityType: "team" }, market: "Reno", evidencePackageId: m1.evidenceHash, factManifestId: "x", manifest: m1, approvedExamples: [], approvedFirstAction: null, reportArtifact: { artifactId: "a", revision: 1 }, templateVersion: "video-template-v1", introAssetVersion: "founder-intro-v1", voiceVersion: "francisco-v1" });
    expect(a.scriptHash).toHaveLength(64);
  });
  it("state machine: no direct queued → published; stale and review_required are sinks except requeue", () => {
    expect(canVideoTransition("queued", "published")).toBe(false);
    expect(canVideoTransition("queued", "input_validating")).toBe(true);
    expect(canVideoTransition("artifact_qa", "ready")).toBe(true);
    expect(canVideoTransition("artifact_qa", "review_required")).toBe(true);
    expect(VIDEO_TRANSITIONS.stale).toEqual([]);
    expect(VIDEO_TRANSITIONS.review_required).toEqual(["queued"]);
    expect(canVideoTransition("release_ready", "stale")).toBe(true);
  });
  it("failure classes: provider timeout retryable; auth/quota/bad input review; forbidden terminal", () => {
    expect(classifyVideoFailure(new ClassifiedError("timeout", "x"))).toBe("RETRYABLE");
    expect(classifyVideoFailure(new ClassifiedError("provider_quota_exhausted", "x"))).toBe("REVIEW_REQUIRED");
    expect(classifyVideoFailure(new ClassifiedError("validation", "x"))).toBe("REVIEW_REQUIRED");
    expect(classifyVideoFailure(new ClassifiedError("forbidden", "x"))).toBe("TERMINAL");
    expect(classifyVideoFailure(new Error("socket hang up"))).toBe("RETRYABLE");
  });
  it("46–49: local storage is ACCESS_GATED; unlisted YouTube is SHAREABLE_BY_LINK (never 'private') and refuses without corrupting the MP4", async () => {
    const local = await distributionAdapter("local_storage").publish({ artifactId: "a", storageKey: "video-walkthrough/h/k.mp4", sha256: "h", path: "/x" }, {});
    expect(local).toEqual({ kind: "local_storage", visibility: "ACCESS_GATED", reference: "video-walkthrough/h/k.mp4", url: null });
    const yt = distributionAdapter("unlisted_youtube");
    expect(yt.visibility).toBe("SHAREABLE_BY_LINK");
    expect(yt.configured({})).toBe(false);
    await expect(yt.publish({ artifactId: "a", storageKey: "k", sha256: "h", path: "/x" }, {})).rejects.toMatchObject({ kind: "validation" });
  });
  it("config: SHADOW by default; mock TTS and the fixture intro are refused in production", () => {
    expect(resolveVideoConfig({})).toMatchObject({ mode: "SHADOW", killSwitch: false, releaseKillSwitch: false, distribution: "local_storage", ttsProvider: "elevenlabs", introAssetVersion: "founder-intro-v1" });
    expect(resolveVideoConfig({ VIDEO_TTS_PROVIDER: "mock", VIDEO_ALLOW_FIXTURE_INTRO: "true" })).toMatchObject({ ttsProvider: "mock", introAssetVersion: "founder-intro-fixture" });
    expect(resolveVideoConfig({ VIDEO_TTS_PROVIDER: "mock", VIDEO_ALLOW_FIXTURE_INTRO: "true", NODE_ENV: "production" })).toMatchObject({ ttsProvider: "elevenlabs", introAssetVersion: "founder-intro-v1" });
    expect(resolveVideoConfig({ VIDEO_WALKTHROUGH_MODE: "canary", VIDEO_WALKTHROUGH_KILL_SWITCH: "true" })).toMatchObject({ mode: "CANARY", killSwitch: true });
  });
});

describe("spec 138 hardening: pronunciation (29), intro registry (38/39), deliverability", () => {
  it("29: an alias changes only what the provider hears; canonical text stays for display and captions; the alias table is part of the voice version", async () => {
    const root = mkdtempSync(join(tmpdir(), "video-tts-alias-"));
    const heard: string[] = [];
    const provider = mockTtsProvider({ onCall: (t) => heard.push(t) });
    const aliased = { ...voice, pronunciation: { version: "pronunciation-test", aliases: { Kirsch: "Keersh" } } };
    const text = "Laura, Kirsch Team came in at $56.9M closed.";
    expect(spokenForm(text, aliased.pronunciation.aliases)).toBe("Laura, Keersh Team came in at $56.9M closed.");
    expect(spokenForm("Kirschner Group", aliased.pronunciation.aliases)).toBe("Kirschner Group");
    expect(spokenForm(text, {})).toBe(text);
    const key = narrationCacheKey({ scriptHash: "s", voiceVersion: aliased.version, segmentIndex: 0, text, pronunciationVersion: aliased.pronunciation.version });
    const n = await synthesizeCached(provider, root, "narration", { key, text, voice: aliased, voiceId: "v" });
    expect(heard).toEqual(["Laura, Keersh Team came in at $56.9M closed."]);
    expect(n.spokenDiffers).toBe(true);
    expect(n.alignment).toBeNull(); // alignment indexes the spoken string; captions fall back to proportional timing
    const again = await synthesizeCached(provider, root, "narration", { key, text, voice: aliased, voiceId: "v" });
    expect(again.cached).toBe(true);
    expect(heard).toHaveLength(1);
    expect(narrationCacheKey({ scriptHash: "s", voiceVersion: "v1", segmentIndex: 0, text, pronunciationVersion: "p1" })).not.toBe(narrationCacheKey({ scriptHash: "s", voiceVersion: "v1", segmentIndex: 0, text, pronunciationVersion: "p2" }));
    expect(narrationCacheKey({ scriptHash: "s", voiceVersion: "v1", segmentIndex: 0, text })).toBe(narrationCacheKey({ scriptHash: "s", voiceVersion: "v1", segmentIndex: 0, text }));
  });
  it("38/39: in production a real intro without a registered checksum, or the fixture intro, is refused before any spend; a clip outside the intro bounds is refused too", async () => {
    const root = mkdtempSync(join(tmpdir(), "video-assets-"));
    mkdirSync(join(root, "founder-intro"), { recursive: true });
    writeFileSync(join(root, "founder-intro", "founder-intro-v1.mp4"), "clip");
    writeFileSync(join(root, "founder-intro", "founder-intro-fixture.mp4"), "clip");
    expect(await resolveIntroAsset("founder-intro-v1", root, { production: true })).toMatchObject({ ok: false, reason: expect.stringContaining("FOUNDER_INTRO_UNREGISTERED_CHECKSUM") });
    expect(await resolveIntroAsset("founder-intro-fixture", root, { production: true })).toMatchObject({ ok: false, reason: "FOUNDER_INTRO_FIXTURE_IN_PRODUCTION" });
    expect(await resolveIntroAsset("founder-intro-fixture", root)).toMatchObject({ ok: true });
    expect(await resolveIntroAsset("founder-intro-v1", join(root, "nope"))).toMatchObject({ ok: false, reason: expect.stringContaining("FOUNDER_INTRO_MISSING") });
    expect(await resolveIntroAsset("founder-intro-v9", root)).toMatchObject({ ok: false, reason: expect.stringContaining("FOUNDER_INTRO_UNKNOWN") });
    expect(introProbeIssue({ durationMs: 6_000, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, container: "mp4" })).toBeNull();
    expect(introProbeIssue({ durationMs: 0, width: null, height: null, fps: null, hasVideo: false, hasAudio: false, container: null })).toBe("no video stream");
    expect(introProbeIssue({ durationMs: 45_000, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, container: "mp4" })).toContain("outside");
  });
  it("release: local storage is deliverable outside production, and in production only when the operator asserts a servable durable volume", () => {
    const local = distributionAdapter("local_storage");
    expect(local.deliverable({}).ok).toBe(true);
    expect(local.deliverable({ NODE_ENV: "production" })).toMatchObject({ ok: false, detail: expect.stringContaining("VIDEO_LOCAL_STORAGE_SERVABLE") });
    expect(local.deliverable({ NODE_ENV: "production", VIDEO_LOCAL_STORAGE_SERVABLE: "true" }).ok).toBe(true);
    expect(distributionAdapter("unlisted_youtube").deliverable({ YOUTUBE_OAUTH_REFRESH_TOKEN: "x" }).ok).toBe(false);
  });
});
