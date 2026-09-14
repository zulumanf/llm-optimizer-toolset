/**
 * Spec 138 runtime checklist, meant to run INSIDE the worker container
 * (Railway: `railway ssh --service worker -- npx tsx scripts/video-runtime-check.ts`).
 * Verifies every dependency the render job needs, then renders the fixture
 * with mock narration and writes the MP4 through the immutable store. No
 * database rows, no prospect, no provider spend, no delivery.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeImmutable } from "@/lib/storage/content-addressed";
import { ACTIVE_FOUNDER_INTRO_VERSION, FOUNDER_INTRO_ASSETS, VIDEO_ASSET_ROOT, VIDEO_FORMAT } from "@/lib/video/constants";
import { playwrightRasterizer, rendererAvailability } from "@/lib/video/render";
import { renderSceneHtml } from "@/lib/video/scenes";
import { mockTtsProvider, pcmToWav, wavDurationMs } from "@/lib/video/tts";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const check = async (name: string, fn: () => Promise<string>): Promise<void> => {
  try { checks.push({ name, ok: true, detail: await fn() }); } catch (err) { checks.push({ name, ok: false, detail: err instanceof Error ? err.message.slice(0, 200) : String(err) }); }
};

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "video-runtime-"));
  await check("ffmpeg resolves", async () => execFileSync("ffmpeg", ["-version"]).toString().split("\n")[0]!);
  await check("ffprobe resolves", async () => execFileSync("ffprobe", ["-version"]).toString().split("\n")[0]!);
  await check("renderer availability", async () => { const a = await rendererAvailability(); if (!a.available) throw new Error(a.detail); return a.detail; });
  await check("chromium launches + fonts render", async () => {
    const r = playwrightRasterizer();
    try {
      const html = renderSceneHtml({ kind: "RecommendationComparisonScene", prospectName: "Fixture Team Ñandú", prospectRecommendations: "2", competitorName: "Other Group", competitorRecommendations: "25", denominator: "256", recommendationMultiple: "12.5x as often" });
      const out = await r.rasterize(html, { width: VIDEO_FORMAT.width, height: VIDEO_FORMAT.height });
      if (out.png.length < 10_000) throw new Error(`suspiciously small PNG (${out.png.length} bytes): fonts or rendering broken`);
      if (out.overflow.length) throw new Error(out.overflow.join("; "));
      let fonts = "fc-list unavailable";
      try { fonts = `${execFileSync("fc-list").toString().split("\n").filter(Boolean).length} fonts via fontconfig`; } catch { /* alpine without fontconfig */ }
      return `${out.png.length} byte PNG (chromium ${process.env.VIDEO_CHROMIUM_PATH ?? "playwright-managed"}); ${fonts}`;
    } finally { await r.close(); }
  });
  await check("intro asset loads", async () => {
    const asset = FOUNDER_INTRO_ASSETS[ACTIVE_FOUNDER_INTRO_VERSION]!;
    const p = join(VIDEO_ASSET_ROOT, asset.file);
    // CI runs this inside the freshly built image, where the recording is
    // not (and must not be) baked in; the deployed worker still requires it.
    if (!existsSync(p) && process.env.VIDEO_RUNTIME_CHECK_REQUIRE_INTRO === "false") return `${asset.version} not present (not required by this run)`;
    if (!existsSync(p)) throw new Error(`${asset.version} missing at ${p}`);
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p]).toString().trim();
    return `${asset.version}: ${probe} s`;
  });
  await check("TTS output decodes", async () => {
    const r = await mockTtsProvider().synthesize({ text: "Runtime check narration.", voice: { version: "mock", provider: "mock", voiceIdEnv: "", modelId: "mock", settings: { stability: 0, similarityBoost: 0, style: 0 } }, voiceId: "mock" });
    const wav = pcmToWav(r.pcm, r.sampleRate);
    const p = join(work, "tts.wav");
    await writeImmutable(work, "tts.wav", wav);
    const d = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p]).toString().trim();
    return `${wavDurationMs(wav)} ms WAV; ffprobe reads ${d} s`;
  });
  await check("MP4 renders + ffprobe QA + immutable write", async () => {
    const out = join(work, "smoke");
    const r = execFileSync("npx", ["tsx", "scripts/video-walkthrough-smoke.ts", out], { env: { ...process.env, VIDEO_TTS_PROVIDER: "mock" } }).toString();
    const j = JSON.parse(r.slice(r.indexOf("{"))) as { qa: { passed: boolean; failures: string[] }; probe: { durationMs: number }; renderMs: number };
    if (!j.qa.passed) throw new Error(j.qa.failures.join(" | "));
    const bytes = readFileSync(join(out, "walkthrough.mp4"));
    const w = await writeImmutable(work, "immutable/walkthrough.mp4", bytes);
    const again = await writeImmutable(work, "immutable/walkthrough.mp4", bytes);
    if (!again.alreadyExisted || again.sha256 !== w.sha256) throw new Error("immutable write did not dedupe");
    return `${(j.probe.durationMs / 1000).toFixed(1)} s in ${j.renderMs} ms; sha ${w.sha256.slice(0, 12)}`;
  });
  await check("no local-machine-only dependencies", async () => {
    const bad = ["/opt/homebrew", "/Users/"].filter((p) => (process.env.PATH ?? "").includes(p) || process.cwd().startsWith(p));
    if (bad.length) throw new Error(`running on a local machine (${bad.join(", ")}) — rerun inside the worker`);
    return `cwd ${process.cwd()}`;
  });
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}
main().catch((err) => { console.error(err); process.exit(1); });
