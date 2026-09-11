/**
 * Rendering (spec 138): scene HTML → PNG stills (headless Chromium, a
 * rasterizer — not a screen recording), stills + narration → H.264/AAC MP4
 * (ffmpeg), plus a probe (ffprobe) for artifact QA. Every external tool is
 * behind an interface with a mock, so the lane is tested without binaries
 * and the smoke script exercises the real ones.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { ClassifiedError } from "@/lib/errors";
import { VIDEO_AUDIO, VIDEO_FORMAT, VIDEO_STEP_TIMEOUT_MS } from "@/lib/video/constants";

const exec = promisify(execFile);

export interface PlannedScene {
  index: number;
  kind: string;
  /** Still-image scenes carry HTML + narration; the intro carries a clip. */
  html: string | null;
  audioWavPath: string | null;
  introClipPath: string | null;
  durationMs: number;
}
export interface RenderPlan { scenes: PlannedScene[]; width: number; height: number; fps: number }

export interface ProbeResult { durationMs: number; width: number | null; height: number | null; fps: number | null; hasVideo: boolean; hasAudio: boolean; container: string | null; videoCodec?: string | null; audioCodec?: string | null; bitrateKbps?: number | null }

export interface SceneRasterizer { rasterize(html: string, size: { width: number; height: number }): Promise<{ png: Buffer; overflow: string[] }>; close(): Promise<void> }
export interface VideoComposer { compose(plan: RenderPlan, stills: Map<number, string>, outPath: string, workDir: string): Promise<void> }
export interface MediaProbe { probe(path: string): Promise<ProbeResult> }
export interface RenderDeps { rasterizer: SceneRasterizer; composer: VideoComposer; probe: MediaProbe }

export interface RenderResult { outPath: string; sha256: string; sizeBytes: number; probe: ProbeResult; renderMs: number; overflow: string[] }

const run = async (bin: string, args: string[]): Promise<{ stdout: string }> => {
  try {
    return await exec(bin, args, { timeout: VIDEO_STEP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    if (e.code === "ENOENT") throw new ClassifiedError("internal", `${bin} is not installed on this worker.`);
    if (e.killed) throw new ClassifiedError("timeout", `${bin} exceeded ${VIDEO_STEP_TIMEOUT_MS} ms.`);
    throw new ClassifiedError("internal", `${bin} failed: ${(e.stderr ?? e.message ?? "").slice(-400)}`);
  }
};

/** Headless Chromium screenshots of a static document: deterministic,
 * measures real overflow on every fitted element. */
export function playwrightRasterizer(): SceneRasterizer {
  let browser: { newPage(o: { viewport: { width: number; height: number }; deviceScaleFactor: number }): Promise<PwPage>; close(): Promise<void> } | null = null;
  type PwPage = { setContent(html: string, o: { waitUntil: "load" }): Promise<void>; evaluate<T>(fn: () => T): Promise<T>; screenshot(o: { type: "png" }): Promise<Buffer>; close(): Promise<void> };
  const open = async () => {
    if (browser) return browser;
    let mod: { chromium: { launch(o: { headless: boolean; executablePath?: string }): Promise<typeof browser> } };
    try {
      mod = (await import("@playwright/test")) as unknown as typeof mod;
    } catch {
      throw new ClassifiedError("internal", "Playwright is not installed on this worker.");
    }
    // A system Chromium (the worker image's apk package) is used when named;
    // otherwise Playwright's own download.
    const executablePath = process.env.VIDEO_CHROMIUM_PATH || undefined;
    browser = await mod.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    return browser!;
  };
  return {
    async rasterize(html, size) {
      const b = await open();
      const page = await b.newPage({ viewport: size, deviceScaleFactor: 1 });
      try {
        await page.setContent(html, { waitUntil: "load" });
        const overflow = await page.evaluate(() => {
          const out: string[] = [];
          const d = document;
          if (d.documentElement.scrollWidth > d.documentElement.clientWidth || d.documentElement.scrollHeight > d.documentElement.clientHeight) out.push("document overflows the frame");
          d.querySelectorAll("[data-fit]").forEach((el, i) => {
            const e = el as HTMLElement;
            if (e.scrollWidth > e.clientWidth + 1) out.push(`fitted element ${i} overflows horizontally`);
            const r = e.getBoundingClientRect();
            if (r.bottom > window.innerHeight - 40) out.push(`fitted element ${i} runs past the bottom safe area`);
          });
          return out;
        });
        const png = await page.screenshot({ type: "png" });
        return { png, overflow };
      } finally {
        await page.close();
      }
    },
    async close() { await browser?.close(); browser = null; },
  };
}

/** ffmpeg: one H.264/AAC segment per scene (still + narration padded to the
 * scene length; the intro clip normalized), then a lossless concat. */
export function ffmpegComposer(bin = "ffmpeg"): VideoComposer {
  return {
    async compose(plan, stills, outPath, workDir) {
      await mkdir(workDir, { recursive: true });
      const { width, height, fps } = plan;
      const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps},format=yuv420p`;
      const common = ["-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(fps), "-c:a", "aac", "-b:a", "128k", "-ar", String(VIDEO_AUDIO.outputSampleRate), "-ac", "2"];
      const segments: string[] = [];
      for (const s of plan.scenes) {
        const seg = join(workDir, `seg-${String(s.index).padStart(2, "0")}.mp4`);
        const dur = (s.durationMs / 1000).toFixed(3);
        if (s.introClipPath) {
          await run(bin, ["-y", "-i", s.introClipPath, "-f", "lavfi", "-i", `anullsrc=r=${VIDEO_AUDIO.outputSampleRate}:cl=stereo`, "-filter_complex", `[0:v]${vf}[v];[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0[a]`, "-map", "[v]", "-map", "[a]", ...common, seg]);
        } else {
          const still = stills.get(s.index);
          if (!still) throw new ClassifiedError("validation", `scene ${s.index} has no still`);
          const audio = s.audioWavPath ? ["-i", s.audioWavPath] : ["-f", "lavfi", "-i", `anullsrc=r=${VIDEO_AUDIO.outputSampleRate}:cl=stereo`];
          await run(bin, ["-y", "-loop", "1", "-framerate", String(fps), "-i", still, ...audio, "-t", dur, "-vf", vf, "-af", "apad", "-tune", "stillimage", ...common, seg]);
        }
        segments.push(seg);
      }
      const list = join(workDir, "concat.txt");
      await writeFile(list, segments.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
      await run(bin, ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", outPath]);
    },
  };
}

export function ffprobeProbe(bin = "ffprobe"): MediaProbe {
  return {
    async probe(path) {
      const { stdout } = await run(bin, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]);
      const j = JSON.parse(stdout) as { format?: { duration?: string; format_name?: string; bit_rate?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string }[] };
      const v = (j.streams ?? []).find((s) => s.codec_type === "video");
      const a = (j.streams ?? []).find((s) => s.codec_type === "audio");
      const rate = v?.avg_frame_rate ?? v?.r_frame_rate ?? null;
      const fps = rate ? (() => { const [n, d] = rate.split("/").map(Number); return d ? n! / d : n!; })() : null;
      return {
        durationMs: Math.round(Number(j.format?.duration ?? 0) * 1000), width: v?.width ?? null, height: v?.height ?? null, fps, hasVideo: Boolean(v), hasAudio: Boolean(a), container: j.format?.format_name ?? null,
        videoCodec: v?.codec_name ?? null, audioCodec: a?.codec_name ?? null, bitrateKbps: j.format?.bit_rate ? Math.round(Number(j.format.bit_rate) / 1000) : null,
      };
    },
  };
}

/** No binaries: a byte-exact stand-in MP4 whose probe reflects the plan. */
export function mockRenderDeps(opts: { failCompose?: () => Error | null; onCompose?: () => void; probeOverride?: Partial<ProbeResult> } = {}): RenderDeps {
  let lastPlan: RenderPlan | null = null;
  return {
    rasterizer: { async rasterize(html, size) { return { png: Buffer.from(`PNG:${size.width}x${size.height}:${createHash("sha256").update(html).digest("hex")}`), overflow: [] }; }, async close() {} },
    composer: {
      async compose(plan, stills, outPath) {
        opts.onCompose?.();
        const failure = opts.failCompose?.() ?? null;
        if (failure) throw failure;
        lastPlan = plan;
        const body = plan.scenes.map((s) => `${s.index}:${s.kind}:${s.durationMs}:${stills.get(s.index) ? "still" : "clip"}`).join("|");
        await writeFile(outPath, Buffer.from(`MOCKMP4\n${body}\n`));
      },
    },
    probe: {
      async probe(path) {
        const bytes = await readFile(path);
        const text = bytes.toString("utf8", 0, Math.min(bytes.length, 65_536));
        // A mock MP4 carries its plan; any other file (the founder intro
        // fixture) probes as a six-second clip.
        const total = text.startsWith("MOCKMP4")
          ? text.split("\n")[1]!.split("|").reduce((a, s) => a + Number(s.split(":")[2] ?? 0), 0)
          : 6_000;
        void lastPlan;
        return { durationMs: total, width: VIDEO_FORMAT.width, height: VIDEO_FORMAT.height, fps: VIDEO_FORMAT.fps, hasVideo: true, hasAudio: true, container: "mock", ...(text.startsWith("MOCKMP4") ? opts.probeOverride : {}) };
      },
    },
  };
}

export const realRenderDeps = (): RenderDeps => ({ rasterizer: playwrightRasterizer(), composer: ffmpegComposer(), probe: ffprobeProbe() });

export async function rendererAvailability(): Promise<{ available: boolean; detail: string }> {
  const missing: string[] = [];
  for (const bin of ["ffmpeg", "ffprobe"]) { try { await exec(bin, ["-version"], { timeout: 10_000 }); } catch { missing.push(bin); } }
  try { await import("@playwright/test"); } catch { missing.push("playwright"); }
  return missing.length ? { available: false, detail: `missing: ${missing.join(", ")}` } : { available: true, detail: "ffmpeg, ffprobe and Playwright present" };
}

/** Rasterize every still scene, compose, probe, hash. Deterministic for a
 * plan; the caller decides where the bytes live. */
export async function renderVideo(deps: RenderDeps, plan: RenderPlan, outPath: string, workDir: string): Promise<RenderResult> {
  const started = Date.now();
  await mkdir(workDir, { recursive: true });
  const stills = new Map<number, string>();
  const overflow: string[] = [];
  try {
    for (const s of plan.scenes) {
      if (!s.html) continue;
      const r = await deps.rasterizer.rasterize(s.html, { width: plan.width, height: plan.height });
      overflow.push(...r.overflow.map((o) => `scene ${s.index} (${s.kind}): ${o}`));
      const p = join(workDir, `scene-${String(s.index).padStart(2, "0")}.png`);
      await writeFile(p, r.png);
      stills.set(s.index, p);
    }
  } finally {
    await deps.rasterizer.close();
  }
  await deps.composer.compose(plan, stills, outPath, workDir);
  const bytes = await readFile(outPath);
  const probe = await deps.probe.probe(outPath);
  const size = (await stat(outPath)).size;
  return { outPath, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: size, probe, renderMs: Date.now() - started, overflow };
}
