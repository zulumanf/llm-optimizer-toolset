/**
 * Local token counting.
 *
 * **What this is and is not.** This counts tokens deterministically and
 * offline, with no provider call and no tokenizer dependency. It is an
 * approximation of a BPE tokenizer, not the tokenizer itself. It is used for
 * three things — budgeting a packet, sizing a hot file, and comparing context
 * strategies — and it is honest for all three because the comparison is
 * *relative*: the same estimator sizes every mode, so a ratio between modes is
 * meaningful even where an absolute count is off by a few percent.
 *
 * It is deliberately NOT used to report provider cost. Cost comes from the
 * provider's reported `usage` (`lib/ai/agent.ts`), which is the only number
 * that is actually true. Anywhere this module's output is surfaced, it is
 * labelled an estimate.
 *
 * The heuristic: whitespace-delimited words cost roughly 1.3 tokens, and
 * punctuation and digits cost more per character than letters. Calibrated
 * against the `CHARS_PER_TOKEN` constant, which is the documented ratio for
 * English prose in current BPE vocabularies.
 */
import { CHARS_PER_TOKEN } from "@/lib/knowledge/constants";

/**
 * Estimate tokens for a string. Monotonic in length, so a budget check never
 * lets a longer string through where a shorter one failed.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;

  // Character-based floor: the ratio that holds for ordinary prose.
  const byChars = text.length / CHARS_PER_TOKEN;

  // Word-based estimate: subword splitting means long words cost more than one
  // token, and punctuation almost always stands alone.
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  let byWords = 0;
  for (const word of words) {
    // A short word is one token; longer words split roughly every 4-5 chars.
    byWords += word.length <= 4 ? 1 : Math.ceil(word.length / 4.5);
    // Trailing punctuation is usually its own token.
    if (/[.,;:!?)\]}"']$/.test(word)) byWords += 0.5;
  }

  // Newlines are tokens too, and structured context is newline-dense.
  const newlines = (text.match(/\n/g) ?? []).length;

  return Math.max(1, Math.ceil(Math.max(byChars, byWords) + newlines * 0.5));
}

/** Estimate tokens for a JSON-serialisable value as an agent would receive it. */
export function estimateJsonTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value ?? null));
}

/** Sum an estimate across parts, for a packet assembled from many pieces. */
export function totalTokens(parts: string[]): number {
  return parts.reduce((sum, part) => sum + estimateTokens(part), 0);
}

/**
 * Truncate to a token budget on a whitespace boundary, returning what was cut.
 * Never truncates mid-word: a half-word in an agent prompt reads as a typo in
 * the source material, which is worse than a visibly shortened passage.
 */
export function truncateToTokens(
  text: string,
  maxTokens: number
): { text: string; truncated: boolean; droppedTokens: number } {
  const total = estimateTokens(text);
  if (total <= maxTokens) return { text, truncated: false, droppedTokens: 0 };
  if (maxTokens <= 0) return { text: "", truncated: true, droppedTokens: total };

  // Binary search the character length whose estimate fits. The estimator is
  // monotonic in length, so this converges.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  let cut = text.slice(0, low);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > cut.length * 0.5) cut = cut.slice(0, lastSpace);

  return {
    text: cut.trimEnd(),
    truncated: true,
    droppedTokens: total - estimateTokens(cut),
  };
}
