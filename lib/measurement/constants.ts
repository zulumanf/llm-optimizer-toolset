/**
 * The default measurement instrument (spec 151 A8): the production baseline
 * instrument already used for every public benchmark
 * (scripts/run-recommendedfirst-baseline.ts, docs/consumer_chatgpt_benchmark_assessment.md).
 * Named here once; a project that needs another instrument pins a new
 * version explicitly.
 */
export const DEFAULT_MEASUREMENT_INSTRUMENT = [
  { provider: "openai", model: "gpt-5.4-mini-2026-03-17+search", repetitions: 4 },
  { provider: "perplexity", model: "sonar", repetitions: 4 },
] as const;

/**
 * Optional deployment override for the default instrument, as JSON
 * (`[{"provider":"openai","model":"…","repetitions":4}]`). It only affects a
 * project's FIRST pin; the pin row records the exact providers and the
 * reason names the override, so nothing changes silently afterwards. Used
 * by tests (mock provider) and by any environment that must not call the
 * production providers. Invalid JSON is refused, never ignored.
 */
export const DEFAULT_INSTRUMENT_ENV = "MEASUREMENT_DEFAULT_INSTRUMENT";

export interface DefaultInstrument {
  providers: { provider: string; model: string; repetitions: number }[];
  source: "code_default" | "env_override";
}

export function defaultMeasurementInstrument(env: Record<string, string | undefined> = process.env): DefaultInstrument {
  const raw = env[DEFAULT_INSTRUMENT_ENV]?.trim();
  if (!raw) return { providers: DEFAULT_MEASUREMENT_INSTRUMENT.map((p) => ({ ...p })), source: "code_default" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${DEFAULT_INSTRUMENT_ENV} is not valid JSON`);
  }
  const ok =
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every(
      (p) =>
        p && typeof p === "object" &&
        typeof (p as Record<string, unknown>).provider === "string" &&
        typeof (p as Record<string, unknown>).model === "string" &&
        Number.isInteger((p as Record<string, unknown>).repetitions) &&
        ((p as Record<string, unknown>).repetitions as number) >= 1 &&
        ((p as Record<string, unknown>).repetitions as number) <= 10
    );
  if (!ok) throw new Error(`${DEFAULT_INSTRUMENT_ENV} must be a non-empty array of {provider, model, repetitions 1–10}`);
  return { providers: parsed as DefaultInstrument["providers"], source: "env_override" };
}

/** Statistical scope labels shown next to every interval (spec 151 A9). */
export const INTERVAL_LABEL = "95% interval (statistical, prompt-clustered)";
export const WILSON_LABEL = "95% Wilson interval (assumes independent answers)";
