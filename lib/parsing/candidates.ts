/**
 * Unrecognized-brand discovery (spec 005). Deliberately conservative: only
 * capitalized 1–3 word sequences that appear mid-sentence (not just at
 * sentence/line starts), aren't common words, and don't match any tracked
 * term. False negatives are fine — humans promote candidates; noise is not
 * fine.
 *
 * Real provider answers are markdown-heavy (bold section headers, tables,
 * numbered lists), so formatting characters are blanked before detection and
 * line starts / header-like "Word:" shapes are rejected — tuned against the
 * first real GPT captures, which produced junk like "Bottom", "Comparison".
 */
const STOPWORDS = new Set(
  `a an and are as at be but by for from has have i if in into is it its my
   no not of on or our so that the their there these they this to was we
   what when where which while who why will with you your yes only most many
   some such just like also both each other another over under between during
   before after against about above below all any because until again once
   here then too very can now new use using best top tools tool options
   however overall finally lastly additionally alternatively though generally
   opinions teams features support reviews pricing bottom line summary verdict
   comparison competitor competitors depending depends differentiation
   dimension inventory larger loyalty main key takeaway takeaways strengths
   weaknesses pros cons notes note caveat caveats example examples quick
   recommendation recommendations assuming practical category product tier
   pick picks choice choices option table section conclusion tldr usually
   often potentially may mixed strong stronger strongest mature smaller
   weaker better worse cheaper pricier faster slower higher lower medium
   high low varies limited moderate similar unknown unclear likely unlikely
   possibly typically swot otas`
    .split(/\s+/)
    .filter(Boolean)
);

const CANDIDATE_RE = /\b([A-Z][a-zA-Z0-9]{2,}(?:\s[A-Z][a-zA-Z0-9]+){0,2})\b/g;

export function normalizeCandidate(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Blank markdown formatting characters, preserving indices exactly.
 * Table pipes become newlines so every cell reads as a line start — cell-
 * leading capitalized words ("Usually cheaper") are structure, not brands. */
function blankMarkdown(text: string): string {
  return text.replace(/[*_`#>~[\]()]/g, " ").replace(/\|/g, "\n");
}

export function detectBrandCandidates(
  text: string,
  knownTerms: string[]
): string[] {
  const known = new Set(knownTerms.map((t) => normalizeCandidate(t)));
  const cleaned = blankMarkdown(text);
  const counts = new Map<string, { name: string; midSentence: boolean }>();

  for (const match of cleaned.matchAll(CANDIDATE_RE)) {
    const name = match[1] as string;
    const normalized = normalizeCandidate(name);
    if (known.has(normalized)) continue;
    if (name.split(" ").every((w) => STOPWORDS.has(w.toLowerCase()))) continue;

    const start = match.index ?? 0;
    const rawBefore = cleaned.slice(0, start);
    const after = cleaned.slice(start + name.length);

    // Line starts are never mid-sentence (markdown headers, list items,
    // table rows all begin lines once formatting is blanked)
    const atLineStart = /(^|\n)[\s]*$/.test(rawBefore);
    // Header-like "Word:" shapes are structure, not brands
    const headerLike = /^\s*:/.test(after);

    const before = rawBefore.trimEnd();
    const midSentence =
      !atLineStart &&
      !headerLike &&
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
