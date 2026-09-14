/**
 * Narration (spec 138): a TTS provider is a RENDERER of the approved script,
 * never a source of copy. ElevenLabs is called over HTTPS with the
 * authorized voice profile; credentials stay in env and never enter a
 * result, a log line or an artifact row. Narration is content-addressed
 * (script revision + voice + segment), so a retried worker finds the audio
 * it already paid for.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { ClassifiedError } from "@/lib/errors";
import { writeImmutable } from "@/lib/storage/content-addressed";
import { ELEVENLABS_EST_USD_PER_1K_CHARS, VIDEO_AUDIO, VIDEO_STEP_TIMEOUT_MS, type VoiceProfile } from "@/lib/video/constants";

export interface CharAlignment { characters: string[]; startsMs: number[]; endsMs: number[] }

export interface TtsResult {
  /** 16-bit signed little-endian mono PCM. */
  pcm: Buffer;
  sampleRate: number;
  durationMs: number;
  characters: number;
  alignment: CharAlignment | null;
  provider: string;
  model: string;
}

export interface TtsProvider {
  name: string;
  synthesize(req: { text: string; voice: VoiceProfile; voiceId: string }): Promise<TtsResult>;
}

/** Retryable = transient provider trouble; the job backs off. Everything
 * else (auth, quota, bad input) is a review, not a loop. */
export function ttsFailureClass(err: unknown): "RETRYABLE" | "REVIEW_REQUIRED" {
  if (err instanceof ClassifiedError) return err.kind === "provider_rate_limit" || err.kind === "timeout" || err.kind === "internal" ? "RETRYABLE" : "REVIEW_REQUIRED";
  return "RETRYABLE";
}

export function pcmDurationMs(pcmBytes: number, sampleRate: number): number {
  return Math.round((pcmBytes / 2 / sampleRate) * 1000);
}

/** Minimal RIFF/WAVE wrapper for 16-bit mono PCM. */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function wavDurationMs(wav: Buffer): number {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF") throw new ClassifiedError("validation", "Not a WAV file.");
  const sampleRate = wav.readUInt32LE(24);
  const channels = wav.readUInt16LE(22);
  const bits = wav.readUInt16LE(34);
  const dataLen = wav.readUInt32LE(40);
  return Math.round((dataLen / (channels * (bits / 8)) / sampleRate) * 1000);
}

/** ElevenLabs over fetch: PCM with character timestamps. */
export function elevenLabsProvider(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): TtsProvider {
  return {
    name: "elevenlabs",
    async synthesize({ text, voice, voiceId }) {
      const apiKey = env.ELEVENLABS_API_KEY;
      if (!apiKey) throw new ClassifiedError("provider_auth", "ELEVENLABS_API_KEY is not configured.");
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), VIDEO_STEP_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=pcm_${VIDEO_AUDIO.sampleRate}`, {
          method: "POST",
          headers: { "xi-api-key": apiKey, "content-type": "application/json" },
          body: JSON.stringify({ text, model_id: voice.modelId, voice_settings: { stability: voice.settings.stability, similarity_boost: voice.settings.similarityBoost, style: voice.settings.style } }),
          signal: ctl.signal,
        });
      } catch (err) {
        const aborted = (err as Error).name === "AbortError";
        throw new ClassifiedError(aborted ? "timeout" : "internal", aborted ? "ElevenLabs request timed out." : "ElevenLabs request failed.");
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 429) throw new ClassifiedError("provider_rate_limit", "ElevenLabs rate limited.");
      if (res.status === 401 || res.status === 403) throw new ClassifiedError("provider_auth", "ElevenLabs rejected the credentials.");
      if (res.status === 402) throw new ClassifiedError("provider_quota_exhausted", "ElevenLabs quota exhausted.");
      if (res.status >= 500) throw new ClassifiedError("internal", `ElevenLabs ${res.status}.`);
      if (!res.ok) throw new ClassifiedError("validation", `ElevenLabs refused the request (${res.status}).`);
      const body = (await res.json()) as { audio_base64?: string; alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } | null };
      if (!body.audio_base64) throw new ClassifiedError("internal", "ElevenLabs returned no audio.");
      const pcm = Buffer.from(body.audio_base64, "base64");
      const a = body.alignment ?? null;
      return {
        pcm, sampleRate: VIDEO_AUDIO.sampleRate, durationMs: pcmDurationMs(pcm.length, VIDEO_AUDIO.sampleRate), characters: text.length,
        alignment: a ? { characters: a.characters, startsMs: a.character_start_times_seconds.map((s) => Math.round(s * 1000)), endsMs: a.character_end_times_seconds.map((s) => Math.round(s * 1000)) } : null,
        provider: "elevenlabs", model: voice.modelId,
      };
    },
  };
}

/** Deterministic silent narration (~65 ms per character, a real pace) with
 * proportional alignment: tests and local smoke renders never spend money. */
export function mockTtsProvider(opts: { msPerChar?: number; fail?: () => Error | null; onCall?: (text: string) => void } = {}): TtsProvider {
  const msPerChar = opts.msPerChar ?? 65;
  return {
    name: "mock",
    async synthesize({ text, voice }) {
      opts.onCall?.(text);
      const failure = opts.fail?.() ?? null;
      if (failure) throw failure;
      const durationMs = Math.max(500, Math.round(text.length * msPerChar));
      const samples = Math.round((durationMs / 1000) * VIDEO_AUDIO.sampleRate);
      const pcm = Buffer.alloc(samples * 2);
      const chars = [...text];
      const per = durationMs / Math.max(1, chars.length);
      return {
        pcm, sampleRate: VIDEO_AUDIO.sampleRate, durationMs, characters: text.length,
        alignment: { characters: chars, startsMs: chars.map((_, i) => Math.round(i * per)), endsMs: chars.map((_, i) => Math.round((i + 1) * per)) },
        provider: "mock", model: voice.modelId,
      };
    },
  };
}

export function narrationCacheKey(i: { scriptHash: string; voiceVersion: string; segmentIndex: number; text: string; pronunciationVersion?: string }): string {
  return createHash("sha256").update([i.scriptHash, i.voiceVersion, String(i.segmentIndex), i.text, ...(i.pronunciationVersion ? [i.pronunciationVersion] : [])].join("\n")).digest("hex");
}

/** The text the provider hears: canonical text with whole-word aliases
 * substituted (longest alias first, deterministic). Never used for display. */
export function spokenForm(text: string, aliases: Readonly<Record<string, string>>): string {
  let out = text;
  for (const from of Object.keys(aliases).sort((a, b) => b.length - a.length || a.localeCompare(b))) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu"), aliases[from]!);
  }
  return out;
}

export interface NarrationFile { key: string; wavPath: string; durationMs: number; characters: number; alignment: CharAlignment | null; provider: string; model: string; cached: boolean; sha256: string; estCostUsd: number; spokenDiffers?: boolean }

/** Synthesize once per cache key: an existing WAV + sidecar is reused
 * (worker crashed after the provider charged us; a second worker; a retry). */
export async function synthesizeCached(
  provider: TtsProvider, root: string, prefix: string,
  seg: { key: string; text: string; voice: VoiceProfile; voiceId: string }
): Promise<NarrationFile> {
  // Aliases change what is spoken, never what is displayed or captioned.
  // Character alignment from the provider indexes the SPOKEN string, so it
  // is dropped when the two differ (captions fall back to proportional timing).
  const spoken = spokenForm(seg.text, seg.voice.pronunciation?.aliases ?? {});
  const spokenDiffers = spoken !== seg.text;
  const wavKey = `${prefix}/${seg.key}.wav`;
  const metaKey = `${prefix}/${seg.key}.json`;
  const { resolveStoragePath } = await import("@/lib/storage/content-addressed");
  const wavPath = resolveStoragePath(root, wavKey);
  const metaPath = resolveStoragePath(root, metaKey);
  if (existsSync(wavPath) && existsSync(metaPath)) {
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as Omit<NarrationFile, "cached" | "wavPath" | "key">;
    return { ...meta, key: seg.key, wavPath, cached: true };
  }
  const r = await provider.synthesize({ text: spoken, voice: seg.voice, voiceId: seg.voiceId });
  const wav = pcmToWav(r.pcm, r.sampleRate);
  const w = await writeImmutable(root, wavKey, wav);
  const estCostUsd = r.provider === "elevenlabs" ? (r.characters / 1000) * ELEVENLABS_EST_USD_PER_1K_CHARS : 0;
  const meta = { durationMs: r.durationMs, characters: r.characters, alignment: spokenDiffers ? null : r.alignment, provider: r.provider, model: r.model, sha256: w.sha256, estCostUsd, spokenDiffers };
  await writeImmutable(root, metaKey, Buffer.from(JSON.stringify(meta)));
  return { ...meta, key: seg.key, wavPath: w.path, cached: w.alreadyExisted };
}
