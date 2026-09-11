/**
 * Spec 138 smoke: render ONE fixture walkthrough with the REAL renderer
 * (Playwright Chromium + ffmpeg) and mock narration, no database, no
 * prospect, no provider spend. Prints the probe, QA and timings.
 *
 *   npx tsx scripts/video-walkthrough-smoke.ts [outDir]
 */
import "dotenv/config";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { assertVideoScriptReleasable, compileVideoWalkthrough, narrationSegments, type VideoWalkthroughInput } from "@/lib/prospects/video-walkthrough-contract";
import { MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";
import { qaVideoArtifact } from "@/lib/video/artifact-qa";
import { buildCaptions, captionsScriptHash } from "@/lib/video/captions";
import { FOUNDER_INTRO_ASSETS, ACTIVE_FOUNDER_INTRO_VERSION, SCENE_PADDING, VIDEO_FORMAT } from "@/lib/video/constants";
import { realRenderDeps, renderVideo, rendererAvailability, type PlannedScene } from "@/lib/video/render";
import { renderSceneHtml, sceneLayoutIssues } from "@/lib/video/scenes";
import { mockTtsProvider, narrationCacheKey, synthesizeCached, type NarrationFile } from "@/lib/video/tts";
import type { CaptionSegmentInput } from "@/lib/video/captions";
import { manifestFor } from "../tests/fixtures/fact-manifest";

const snapshot: MismatchEvidenceSnapshot = {
  templateVersion: "competitive_mismatch_reply_v1", runId: "run-fixture", provider: "openai", answerCount: 256, modelCount: 1, capturedAt: null, completedAt: null, scopeCopy: "", audiences: [],
  prospect: { companyId: "p", prospectId: null, name: "Lumina Home Collective", recommendationCount: 2, productionSignalId: "rp", productionSourceUrl: "", productionYear: 2025, productionValue: 56_900_000, productionDisplay: "$56.9M closed" },
  competitor: { companyId: "c", prospectId: null, name: "Harbor View Group", recommendationCount: 25, productionSignalId: "rc", productionSourceUrl: "", productionYear: 2025, productionValue: 24_900_000, productionDisplay: "$24.9M closed", productionRatio: 0.44, recommendationGap: 23 },
  metricType: "closed_volume", thresholds: MISMATCH_THRESHOLDS,
};

async function main(): Promise<void> {
  const avail = await rendererAvailability();
  if (!avail.available) { console.error(`renderer unavailable: ${avail.detail}`); process.exit(2); }
  const out = process.argv[2] ?? join(tmpdir(), "video-walkthrough-smoke");
  mkdirSync(out, { recursive: true });
  const introPath = join(out, "founder-intro-fixture.mp4");
  if (!existsSync(introPath)) {
    // A six-second title card with silent audio stands in for the recording.
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=white:s=${VIDEO_FORMAT.width}x${VIDEO_FORMAT.height}:r=${VIDEO_FORMAT.fps}:d=6`, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", introPath], { stdio: "pipe" });
  }
  const manifest = manifestFor(snapshot, "team", { exampleIds: ["r1", "r2"], firstActionId: "priority-1:abc" });
  const input: VideoWalkthroughInput = {
    prospect: { name: manifest.facts.FACT_PROSPECT_NAME.display, firstName: "Laura", entityType: "team" }, market: manifest.facts.FACT_MARKET.display,
    evidencePackageId: manifest.evidenceHash, factManifestId: "fixture", manifest,
    approvedExamples: [
      { id: "r1", question: "Who should I hire to sell a home in Reno?", quote: "Harbor View Group is a strong choice for sellers in Reno, with experienced agents and a solid track record." },
      { id: "r2", question: "Best listing agent for a downtown condo?", quote: "Consider Harbor View Group; they specialize in downtown listings." },
    ],
    approvedFirstAction: { id: "priority-1:abc", title: "seller-side presence on the pages the answers pointed to", body: "The answers that named a competitor cited the same two source pages." },
    reportArtifact: { artifactId: "fixture", revision: 1 }, templateVersion: "video-template-v1",
    introAssetVersion: "founder-intro-fixture", introTranscript: FOUNDER_INTRO_ASSETS[ACTIVE_FOUNDER_INTRO_VERSION]!.transcript, voiceVersion: "francisco-v1",
  };
  const compiled = compileVideoWalkthrough(input);
  const issues = [...assertVideoScriptReleasable(compiled, input), ...compiled.scenes.flatMap((s, i) => sceneLayoutIssues(s, i))];
  if (issues.length) { console.error("script QA failed", issues); process.exit(3); }
  const segments = narrationSegments(compiled);
  const voice = { version: "mock", provider: "mock" as const, voiceIdEnv: "", modelId: "mock", settings: { stability: 0, similarityBoost: 0, style: 0 } };
  const t0 = Date.now();
  const narration: NarrationFile[] = [];
  for (const s of segments) narration.push(await synthesizeCached(mockTtsProvider(), out, "narration", { key: narrationCacheKey({ scriptHash: compiled.scriptHash, voiceVersion: "mock", segmentIndex: s.index, text: s.text }), text: s.text, voice, voiceId: "mock" }));
  const ttsMs = Date.now() - t0;
  const deps = realRenderDeps();
  const intro = await deps.probe.probe(introPath);
  const scenes: PlannedScene[] = [];
  const captionSegments: CaptionSegmentInput[] = [];
  let offset = 0;
  compiled.scenes.forEach((scene, index) => {
    if (scene.kind === "FounderIntroScene") { scenes.push({ index, kind: scene.kind, html: null, audioWavPath: null, introClipPath: introPath, durationMs: intro.durationMs }); offset += intro.durationMs; return; }
    const k = segments.findIndex((s) => s.sceneIndex === index);
    const n = narration[k]!;
    const durationMs = Math.max(SCENE_PADDING.minSceneMs, SCENE_PADDING.leadMs + n.durationMs + SCENE_PADDING.tailMs);
    scenes.push({ index, kind: scene.kind, html: renderSceneHtml(scene), audioWavPath: n.wavPath, introClipPath: null, durationMs });
    captionSegments.push({ text: segments[k]!.text, offsetMs: offset + SCENE_PADDING.leadMs, durationMs: n.durationMs, alignment: n.alignment });
    offset += durationMs;
  });
  const captions = buildCaptions(captionSegments, compiled.scriptHash);
  writeFileSync(join(out, "walkthrough.vtt"), captions.vtt);
  const r = await renderVideo(deps, { scenes, width: VIDEO_FORMAT.width, height: VIDEO_FORMAT.height, fps: VIDEO_FORMAT.fps }, join(out, "walkthrough.mp4"), join(out, "work"));
  const qa = qaVideoArtifact({
    probe: r.probe, sizeBytes: r.sizeBytes, sha256: r.sha256, storedSha256: r.sha256, sceneCount: scenes.length, plannedSceneCount: compiled.scenes.length,
    introAssetVersion: input.introAssetVersion, expectedIntroAssetVersion: input.introAssetVersion, scriptHash: compiled.scriptHash, captionsScriptHash: captionsScriptHash(captions.vtt),
    renderOverflow: r.overflow, missingAssets: [], binding: { prospectId: "fixture", manifestHash: manifest.manifestHash }, expectedBinding: { prospectId: "fixture", manifestHash: manifest.manifestHash },
  });
  console.log(JSON.stringify({ out: r.outPath, sizeBytes: r.sizeBytes, probe: r.probe, ttsMs, renderMs: r.renderMs, overflow: r.overflow, qa: { passed: qa.passed, failures: qa.failures }, script: compiled.script.map((l) => l.text) }, null, 2));
  process.exit(qa.passed ? 0 : 1);
}
main().catch((err) => { console.error(err); process.exit(1); });
