/**
 * Active parser version resolution (spec 013). The pipeline records the
 * version that ACTUALLY ran on each row, so a mixed heuristic/LLM history
 * stays legible in the evidence portal (docs/03 revision model).
 */
import { PARSER_VERSION_HEURISTIC, PARSER_VERSION_LLM, PARSER_VERSION_ADJUDICATION } from "@/lib/constants";

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

/**
 * Every version whose output is a legitimate parse. Scoring readiness asks
 * "was this response parsed?", not "was it parsed at today's preferred
 * version" — an LLM outage that degraded one response to the heuristic must
 * neither stall the run nor be papered over with a v2 stamp. Upgrading is
 * enqueueParseJobs' job (it targets activeParserVersion), never the gate's.
 */
export const KNOWN_PARSER_VERSIONS: string[] = [
  PARSER_VERSION_HEURISTIC,
  PARSER_VERSION_LLM,
  PARSER_VERSION_ADJUDICATION,
];
