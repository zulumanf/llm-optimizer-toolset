/**
 * Display helpers for statistical estimates (spec 151 A9). One formatting
 * rule everywhere a rate is shown: point estimate, interval, and the counts
 * it came from — never a bare percentage.
 */
export function pct(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(digits)}%`;
}

export function intervalText(low: number | null | undefined, high: number | null | undefined): string {
  return low === null || low === undefined || high === null || high === undefined ? "n/a" : `${pct(low)}–${pct(high)}`;
}

/** "25.0% (95% CI 14.1–39.8%) · 12/48 answers · 12 prompts" */
export function rateSummary(input: {
  rate: number | null;
  low: number | null;
  high: number | null;
  numerator: number;
  denominator: number;
  prompts: number;
}): string {
  const ci = input.low === null || input.high === null ? "interval n/a (too few prompts)" : `95% CI ${intervalText(input.low, input.high)}`;
  return `${pct(input.rate)} (${ci}) · ${input.numerator}/${input.denominator} answers · ${input.prompts} prompts`;
}

export const METRIC_LABELS: Record<string, string> = {
  mention_rate: "Mentioned",
  recommendation_rate: "Recommended",
  first_position_rate: "Listed first",
  top_three_rate: "Listed top 3",
  owned_citation_rate: "Own site cited",
  share_of_voice: "Share of mentions",
};

/** Short model label from an instrument key: "openai · gpt-5.4-mini-…+search". */
export function instrumentLabel(provider: string, model: string): string {
  return `${provider} · ${model}`;
}
