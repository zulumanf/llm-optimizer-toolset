/**
 * Captions (spec 138) derive from the approved script — never from speech
 * recognition. Timing comes from the provider's character alignment when
 * present, else from a proportional split. The VTT carries the script
 * revision it was built from so a stale caption file can never attach to
 * newer narration.
 */
import { createHash } from "node:crypto";
import type { CharAlignment } from "@/lib/video/tts";

export interface CaptionCue { startMs: number; endMs: number; text: string }
export interface CaptionSegmentInput { text: string; offsetMs: number; durationMs: number; alignment: CharAlignment | null }
/** Reading-friendly cue length. */
export const CAPTION_MAX_CHARS = 84;

function chunks(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length > CAPTION_MAX_CHARS && cur) { out.push(cur); cur = word; } else cur = next;
    if (/[.!?]$/.test(cur) && cur.length > CAPTION_MAX_CHARS / 2) { out.push(cur); cur = ""; }
  }
  if (cur) out.push(cur);
  return out;
}

export function cuesForSegment(seg: CaptionSegmentInput): CaptionCue[] {
  const parts = chunks(seg.text);
  const total = seg.text.length || 1;
  const cues: CaptionCue[] = [];
  let charCursor = 0;
  for (const p of parts) {
    const start = seg.text.indexOf(p, charCursor);
    const from = start < 0 ? charCursor : start;
    const to = from + p.length;
    charCursor = to;
    const a = seg.alignment;
    const usable = a && a.startsMs.length >= to && a.endsMs.length >= to;
    const startMs = usable ? a!.startsMs[from]! : Math.round((from / total) * seg.durationMs);
    const endMs = usable ? a!.endsMs[to - 1]! : Math.round((to / total) * seg.durationMs);
    cues.push({ startMs: seg.offsetMs + startMs, endMs: seg.offsetMs + Math.max(endMs, startMs + 300), text: p });
  }
  return cues;
}

const ts = (ms: number): string => {
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000), s = Math.floor((ms % 60_000) / 1000), f = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(f).padStart(3, "0")}`;
};

export function buildCaptions(segments: CaptionSegmentInput[], scriptHash: string): { vtt: string; cues: CaptionCue[]; captionsHash: string } {
  const cues = segments.flatMap(cuesForSegment);
  const lines = ["WEBVTT", `NOTE script ${scriptHash}`, ""];
  cues.forEach((c, i) => { lines.push(String(i + 1), `${ts(c.startMs)} --> ${ts(c.endMs)}`, c.text, ""); });
  const vtt = lines.join("\n");
  return { vtt, cues, captionsHash: createHash("sha256").update(vtt).digest("hex") };
}

/** The script revision a VTT was built from (the binding artifact QA checks). */
export function captionsScriptHash(vtt: string): string | null {
  return vtt.match(/^NOTE script ([0-9a-f]{64})$/m)?.[1] ?? null;
}
