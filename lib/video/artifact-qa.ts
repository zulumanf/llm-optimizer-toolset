/**
 * Artifact QA (spec 138): deterministic checks over the probe and the
 * structured render inputs — never OCR. Every check is named so a failure
 * is a reason code, not a feeling.
 */
import { VIDEO_DURATION, VIDEO_FORMAT, VIDEO_FPS_RANGE } from "@/lib/video/constants";
import type { ProbeResult } from "@/lib/video/render";

export interface ArtifactQaInput {
  probe: ProbeResult;
  sizeBytes: number;
  sha256: string;
  storedSha256: string | null;
  sceneCount: number;
  plannedSceneCount: number;
  introAssetVersion: string;
  expectedIntroAssetVersion: string;
  scriptHash: string;
  captionsScriptHash: string | null;
  renderOverflow: string[];
  missingAssets: string[];
  binding: { prospectId: string; manifestHash: string };
  expectedBinding: { prospectId: string; manifestHash: string };
}
export interface QaCheck { name: string; passed: boolean; detail: string }
export interface ArtifactQaResult { passed: boolean; checks: QaCheck[]; failures: string[] }

export function qaVideoArtifact(i: ArtifactQaInput): ArtifactQaResult {
  const p = i.probe;
  const checks: QaCheck[] = [
    { name: "FILE_NON_EMPTY", passed: i.sizeBytes > 0, detail: `${i.sizeBytes} bytes` },
    { name: "CONTAINER_VALID", passed: p.container !== null && p.durationMs > 0, detail: p.container ?? "unreadable" },
    { name: "VIDEO_STREAM", passed: p.hasVideo, detail: p.hasVideo ? "present" : "missing" },
    { name: "AUDIO_STREAM", passed: p.hasAudio, detail: p.hasAudio ? "present" : "missing" },
    { name: "RESOLUTION", passed: p.width === VIDEO_FORMAT.width && p.height === VIDEO_FORMAT.height, detail: `${p.width}x${p.height}` },
    { name: "FRAME_RATE", passed: p.fps !== null && p.fps >= VIDEO_FPS_RANGE.min && p.fps <= VIDEO_FPS_RANGE.max, detail: `${p.fps ?? "?"} fps` },
    { name: "VIDEO_DURATION_QA", passed: p.durationMs >= VIDEO_DURATION.minMs && p.durationMs <= VIDEO_DURATION.maxMs, detail: `${(p.durationMs / 1000).toFixed(1)} s (allowed ${VIDEO_DURATION.minMs / 1000}–${VIDEO_DURATION.maxMs / 1000} s)` },
    { name: "SCENES_RESOLVED", passed: i.sceneCount === i.plannedSceneCount && i.missingAssets.length === 0, detail: i.missingAssets.length ? `missing: ${i.missingAssets.join(", ")}` : `${i.sceneCount}/${i.plannedSceneCount}` },
    { name: "NO_RENDER_OVERFLOW", passed: i.renderOverflow.length === 0, detail: i.renderOverflow.join("; ") || "none" },
    { name: "INTRO_ASSET_VERSION", passed: i.introAssetVersion === i.expectedIntroAssetVersion, detail: i.introAssetVersion },
    { name: "CAPTIONS_MATCH_SCRIPT", passed: i.captionsScriptHash === i.scriptHash, detail: i.captionsScriptHash ? `${i.captionsScriptHash.slice(0, 12)} vs ${i.scriptHash.slice(0, 12)}` : "no captions" },
    { name: "CHECKSUM_STORED", passed: i.storedSha256 === i.sha256, detail: i.storedSha256 ? i.storedSha256.slice(0, 12) : "not stored" },
    { name: "BINDING", passed: i.binding.prospectId === i.expectedBinding.prospectId && i.binding.manifestHash === i.expectedBinding.manifestHash, detail: `prospect ${i.binding.prospectId.slice(0, 8)} manifest ${i.binding.manifestHash.slice(0, 12)}` },
  ];
  const failures = checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`);
  return { passed: failures.length === 0, checks, failures };
}
