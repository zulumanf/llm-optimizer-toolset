/**
 * Spec 158 H5: contractual measurement can never route to open-weight
 * (Ollama) internal inference. Today that holds because the measurement path
 * calls modelForTask directly; this test makes it a constraint instead of a
 * coincidence. Changing INTERNAL_TASK_TARGETS requires updating the pinned
 * list here — a deliberate, reviewed act.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { INTERNAL_TASK_TARGETS, inferenceTargetForTask, type RoutedTask } from "@/lib/ai/routing";

const ROOT = join(__dirname, "..", "..");

/** Tasks whose output is a measured number or evidence classification. */
const MEASUREMENT_TASKS = ["mention_classification", "mention_verification", "accuracy_analysis"] as const;

/** Capture → parse → classify → score → accuracy, plus the measured providers. */
const MEASUREMENT_DIRS = ["lib/parsing", "lib/runs", "lib/scoring", "lib/accuracy"];
const MEASUREMENT_FILES = ["lib/ai/openai.ts", "lib/ai/anthropic.ts", "lib/ai/google.ts", "lib/ai/perplexity.ts", "lib/ai/registry.ts"];

/** The internal-inference surface the measurement path must never touch. */
const FORBIDDEN = [
  /@\/lib\/ai\/internal-inference/,
  /@\/lib\/ai\/internal\//,
  /\binferenceTargetForTask\b/,
  /\bINTERNAL_TASK_TARGETS\b/,
  /backend:\s*["']ollama["']/,
];

const PINNED_INTERNAL_TASKS = ["detect_contradictions", "knowledge_claim_extraction", "summarize_meeting", "summarize_support_request"];

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("measurement never routes to internal (open-weight) inference", () => {
  it("no measurement task is migrated to an internal backend", () => {
    for (const task of MEASUREMENT_TASKS) {
      expect(Object.keys(INTERNAL_TASK_TARGETS), task).not.toContain(task);
      expect(inferenceTargetForTask(task as RoutedTask).backend, task).toBe("openai");
    }
  });

  it("the internal routing table is exactly the reviewed list", () => {
    expect(Object.keys(INTERNAL_TASK_TARGETS).sort()).toEqual(PINNED_INTERNAL_TASKS);
  });

  it("no measurement module imports the internal-inference layer", () => {
    const files = [...MEASUREMENT_DIRS.flatMap((d) => tsFiles(join(ROOT, d))), ...MEASUREMENT_FILES.map((f) => join(ROOT, f))];
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.flatMap((f) => {
      const src = readFileSync(f, "utf8");
      return FORBIDDEN.filter((re) => re.test(src)).map((re) => `${relative(ROOT, f)} matches ${re}`);
    });
    expect(offenders).toEqual([]);
  });
});
