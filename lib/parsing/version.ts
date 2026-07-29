/**
 * Active parser version resolution (spec 013). The pipeline records the
 * version that ACTUALLY ran on each row, so a mixed heuristic/LLM history
 * stays legible in the evidence portal (docs/03 revision model).
 */
import { PARSER_VERSION_HEURISTIC, PARSER_VERSION_LLM } from "@/lib/constants";

/** LLM classification requires a provider key; without one the pipeline
 * degrades to heuristic v1 rather than failing (docs/12 graceful
 * degradation). */
export function llmClassificationAvailable(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function activeParserVersion(): string {
  return llmClassificationAvailable()
    ? PARSER_VERSION_LLM
    : PARSER_VERSION_HEURISTIC;
}
