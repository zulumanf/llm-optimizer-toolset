/**
 * Video walkthrough constants (spec 138). One template, one format, named
 * bounds. Versions here are what every artifact revision is permanently
 * bound to; changing a version never mutates a historical artifact.
 */
import { join } from "node:path";

export const VIDEO_TEMPLATE_VERSION = "video-template-v1";
export const VIDEO_JOB_TYPE = "render_video_walkthrough";
export const VIDEO_ARTIFACT_KIND = "video_walkthrough";
export const VIDEO_SCRIPT_ARTIFACT_KIND = "video_script";

/** 16:9 landscape, the one V1 format. */
export const VIDEO_FORMAT = { width: 1920, height: 1080, fps: 30 } as const;
/** Accepted fps range from the probe (encoder rounding). */
export const VIDEO_FPS_RANGE = { min: 29, max: 31 } as const;
/** Target 60–90 s; the QA threshold gives narration length a small margin. */
export const VIDEO_DURATION = { targetMinMs: 60_000, targetMaxMs: 90_000, minMs: 55_000, maxMs: 95_000 } as const;
/** Scene length = narration length + lead/tail padding, never below the floor. */
export const SCENE_PADDING = { leadMs: 400, tailMs: 800, minSceneMs: 3_000, maxSceneMs: 25_000 } as const;
export const VIDEO_AUDIO = { sampleRate: 22_050, channels: 1, outputSampleRate: 44_100 } as const;
export const VIDEO_MAX_ATTEMPTS = 3;
/** Per external step budget (ms): TTS request, one ffmpeg call, one screenshot. */
export const VIDEO_STEP_TIMEOUT_MS = 120_000;

/** Canonical MP4s and narration live under the evidence artifact root
 * (content-addressed, immutable rows in evidence_artifacts). */
export const VIDEO_STORAGE_PREFIX = "video-walkthrough";
export const VIDEO_AUDIO_STORAGE_PREFIX = "video-narration";
/** Reusable assets (the recorded founder intro) live outside evidence. */
export const VIDEO_ASSET_ROOT = join(process.cwd(), "var", "video-assets");

export interface FounderIntroAsset {
  version: string;
  /** Path under VIDEO_ASSET_ROOT. */
  file: string;
  /** Exact spoken words: the recorded line is part of the script revision. */
  transcript: string;
  /** sha256 of the recorded file once it exists; null = awaiting recording. */
  sha256: string | null;
  /** Approximate length for planning; the probe is authoritative. */
  approxDurationMs: number;
}

/** Versioned registry: a new recording is a new version; historical videos
 * keep the version they were rendered with. */
export const FOUNDER_INTRO_ASSETS: Record<string, FounderIntroAsset> = {
  "founder-intro-v1": {
    version: "founder-intro-v1",
    file: "founder-intro/founder-intro-v1.mp4",
    transcript: "Hey, Francisco here. I wanted to quickly walk you through what stood out in the results.",
    sha256: null,
    approxDurationMs: 6_000,
  },
};
export const ACTIVE_FOUNDER_INTRO_VERSION = "founder-intro-v1";
/** Fixture intro (title card, synthetic audio) for local smoke runs only. */
export const FIXTURE_FOUNDER_INTRO_VERSION = "founder-intro-fixture";

export interface VoiceProfile {
  version: string;
  provider: "elevenlabs" | "mock";
  /** Env var holding the authorized voice id (never the id itself in code). */
  voiceIdEnv: string;
  modelId: string;
  settings: { stability: number; similarityBoost: number; style: number };
}
export const VOICE_PROFILES: Record<string, VoiceProfile> = {
  "francisco-v1": { version: "francisco-v1", provider: "elevenlabs", voiceIdEnv: "ELEVENLABS_VOICE_ID", modelId: "eleven_multilingual_v2", settings: { stability: 0.55, similarityBoost: 0.8, style: 0.1 } },
};
export const ACTIVE_VOICE_VERSION = "francisco-v1";
/** Rough list price used only to flag unexpectedly expensive narration. */
export const ELEVENLABS_EST_USD_PER_1K_CHARS = 0.3;

export const VIDEO_MODES = ["SHADOW", "CANARY", "MANUAL_ONLY"] as const;
export type VideoMode = (typeof VIDEO_MODES)[number];
export const DEFAULT_VIDEO_MODE: VideoMode = "SHADOW";

export const VIDEO_DISTRIBUTION_KINDS = ["local_storage", "unlisted_youtube"] as const;
export type VideoDistributionKind = (typeof VIDEO_DISTRIBUTION_KINDS)[number];
export const DEFAULT_VIDEO_DISTRIBUTION: VideoDistributionKind = "local_storage";
