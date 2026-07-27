/**
 * Unrecognized-brand discovery (spec 005). Deliberately conservative: only
 * capitalized 1–3 word sequences that appear mid-sentence (not just at
 * sentence starts), aren't common words, and don't match any tracked term.
 * False negatives are fine — humans promote candidates; noise is not fine.
 */
const STOPWORDS = new Set(
  `a an and are as at be but by for from has have i if in into is it its my
   no not of on or our so that the their there these they this to was we
   what when where which while who why will with you your yes only most many
   some such just like also both each other another over under between during
   before after against about above below all any because until again once
   here then too very can now new use using best top tools tool options
   however overall finally lastly additionally alternatively though generally
   opinions teams features support reviews pricing`
    .split(/\s+/)
    .filter(Boolean)
);

const CANDIDATE_RE = /\b([A-Z][a-zA-Z0-9]{2,}(?:\s[A-Z][a-zA-Z0-9]+){0,2})\b/g;

export function normalizeCandidate(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

export function detectBrandCandidates(
  text: string,
  knownTerms: string[]
): string[] {
  const known = new Set(knownTerms.map((t) => normalizeCandidate(t)));
  const counts = new Map<string, { name: string; midSentence: boolean }>();

  for (const match of text.matchAll(CANDIDATE_RE)) {
    const name = match[1] as string;
    const normalized = normalizeCandidate(name);
    if (known.has(normalized)) continue;
    if (name.split(" ").every((w) => STOPWORDS.has(w.toLowerCase()))) continue;

    // Mid-sentence check: preceded by something other than a sentence
    // terminator or a list marker (capitalization is only a brand signal
    // mid-sentence)
    const before = text.slice(0, match.index ?? 0).trimEnd();
    const midSentence =
      before.length > 0 &&
      !/[.!?:]$/.test(before) &&
      !/(?:\d[.)]|[-*•])$/.test(before);

    const existing = counts.get(normalized);
    if (existing) existing.midSentence = existing.midSentence || midSentence;
    else counts.set(normalized, { name, midSentence });
  }

  return [...counts.values()]
    .filter((c) => c.midSentence)
    .map((c) => c.name);
}
