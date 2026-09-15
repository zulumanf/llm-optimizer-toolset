/**
 * Wording rules for public surfaces (spec 141). API captures are never
 * described as consumer ChatGPT behaviour, and nothing is guaranteed. Used by
 * the claims verifier (static scan of marketing sources) and by unit tests.
 */
export const INSTRUMENT_LABEL_OPENAI = "the OpenAI model (gpt-5.4-mini, web search, API)";
export const INSTRUMENT_LABEL_PERPLEXITY = "Perplexity (sonar, API)";

/** Patterns that must not appear in public copy or registry wording. */
export const BANNED_WORDING: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /\bChatGPT (recommended|recommends|cited|cites|named|names)\b/i, why: "API captures are the OpenAI model, not consumer ChatGPT" },
  { pattern: /\bChatGPT always\b/i, why: "no universal claim about any assistant" },
  { pattern: /\bguaranteed (citation|recommendation|ranking|result)s?\b/i, why: "nothing is guaranteed" },
  { pattern: /\bguarantee(d|s)? (a |your )?(top|#1|first) (spot|position|ranking)\b/i, why: "nothing is guaranteed" },
  { pattern: /\b(lost|losing) (revenue|deals|listings)\b/i, why: "no fabricated losses (prospect-voice rule 1)" },
];

export function findBannedWording(text: string): { match: string; why: string } | null {
  for (const rule of BANNED_WORDING) {
    const m = text.match(rule.pattern);
    if (m) return { match: m[0], why: rule.why };
  }
  return null;
}
