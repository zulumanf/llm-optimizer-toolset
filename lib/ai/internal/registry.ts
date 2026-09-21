import type {
  InternalInferenceBackend,
  InternalInferenceCaller,
  InternalInferenceTarget,
} from "@/lib/ai/internal-inference";
import { ClassifiedError } from "@/lib/errors";
import { ollamaCaller } from "@/lib/ai/internal/ollama";
import { openaiInternalCaller } from "@/lib/ai/internal/openai";

/**
 * Local worker-brain roles.
 *
 * These DO NOT change any existing production task route yet.
 * They are available for explicit evaluation and later task migration.
 */
export const LOCAL_INTERNAL_TARGETS = {
  cheap: {
    backend: "ollama",
    model: "qwen3:8b",
    execution: "local",
  },
  reasoning: {
    backend: "ollama",
    model: "qwen3:30b",
    execution: "local",
  },
  qa: {
    backend: "ollama",
    model: "gpt-oss:20b",
    execution: "local",
  },
} as const satisfies Record<string, InternalInferenceTarget>;

export type LocalInternalRole = keyof typeof LOCAL_INTERNAL_TARGETS;

export function localTargetForRole(
  role: LocalInternalRole
): InternalInferenceTarget {
  const target = LOCAL_INTERNAL_TARGETS[role];

  if (!target) {
    throw new ClassifiedError(
      "validation",
      `Unknown local internal inference role "${String(role)}".`
    );
  }

  return target;
}

const callers: Record<InternalInferenceBackend, InternalInferenceCaller> = {
  openai: openaiInternalCaller,
  ollama: ollamaCaller,
};

export function callerForInternalBackend(
  backend: InternalInferenceBackend
): InternalInferenceCaller {
  const caller = callers[backend];

  if (!caller) {
    throw new ClassifiedError(
      "validation",
      `Unknown internal inference backend "${String(backend)}".`
    );
  }

  return caller;
}
