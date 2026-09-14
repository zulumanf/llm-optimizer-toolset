/**
 * Spec 138 operator review: the facts a human needs before the FIRST real
 * shadow render is released — duration, size, codec/bitrate, the QA ledger,
 * and a few preview frames. No OCR, no vision model; a person looks.
 *
 *   npx tsx scripts/video-walkthrough-review.ts <artifact id | mp4 path> [outDir]
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ffprobeProbe } from "@/lib/video/render";

const PREVIEW_POINTS = [0.08, 0.3, 0.5, 0.7, 0.92];

async function resolveTarget(arg: string): Promise<{ path: string; label: string; meta: Record<string, unknown> | null }> {
  if (existsSync(arg)) return { path: arg, label: arg, meta: null };
  const { getVideoArtifact, reconstructVideoWalkthrough } = await import("@/lib/prospects/video-walkthrough");
  const { artifactPath } = await import("@/lib/evidence/storage");
  const row = await getVideoArtifact(arg);
  if (!row?.meta.render) throw new Error(`artifact ${arg} has no render`);
  const rec = await reconstructVideoWalkthrough(arg);
  return { path: artifactPath(row.meta.render.storageKey), label: `artifact ${row.id} (stage ${row.stage}, status ${row.status})`, meta: { stage: row.stage, status: row.status, reason: row.meta.reason, versions: { intro: row.meta.introAssetVersion, voice: row.meta.voiceVersion, script: row.meta.scriptTemplateVersion, template: row.meta.videoTemplateVersion }, narration: row.meta.narration ? { provider: row.meta.narration.provider, characters: row.meta.narration.totalCharacters, estCostUsd: row.meta.narration.estCostUsd } : null, qa: row.meta.qa, stills: row.meta.render.stills ?? null, introDurationMs: row.meta.render.introDurationMs ?? null, qaRuns: rec?.qaRuns ?? null } };
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) { console.error("usage: video-walkthrough-review <artifact id | mp4 path> [outDir]"); process.exit(2); }
  const t = await resolveTarget(arg);
  const out = process.argv[3] ?? join(process.cwd(), "var", "video-review", arg.replace(/[^a-z0-9-]/gi, "_").slice(0, 40));
  mkdirSync(out, { recursive: true });
  const p = await ffprobeProbe().probe(t.path);
  const frames: string[] = [];
  for (const [i, f] of PREVIEW_POINTS.entries()) {
    const at = ((p.durationMs * f) / 1000).toFixed(2);
    const png = join(out, `frame-${i + 1}-${at}s.png`);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", at, "-i", t.path, "-frames:v", "1", "-vf", "scale=960:540", png]);
    frames.push(png);
  }
  const sizeBytes = execFileSync("stat", [process.platform === "darwin" ? "-f%z" : "-c%s", t.path]).toString().trim();
  console.log(JSON.stringify({
    target: t.label, path: t.path,
    duration: `${(p.durationMs / 1000).toFixed(1)} s`, size: `${(Number(sizeBytes) / 1024).toFixed(0)} KB`,
    video: `${p.videoCodec ?? "?"} ${p.width}x${p.height} @ ${p.fps?.toFixed(2) ?? "?"} fps`, audio: p.audioCodec ?? "?", bitrate: `${p.bitrateKbps ?? "?"} kbps`,
    previewFrames: frames, ledger: t.meta,
    reviewChecklist: ["numbers match the report", "names, market and denominator correct", "intro clip plays with sound", "narration is audible and paced", "no clipped or overflowing text", "captions line up with speech", "nothing internal on screen"],
  }, null, 2));
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
