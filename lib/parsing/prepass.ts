/**
 * Deterministic pre-pass (docs/12: deterministic where possible). Pure
 * functions over response text: alias scanning with word boundaries, URL
 * extraction, ordered-list detection, sentence splitting.
 */

export type AliasTier = "canonical" | "alias";

export interface AliasHit {
  companyId: string;
  tier: AliasTier;
  matched: string;
  index: number;
}

export interface CompanyAliases {
  id: string;
  name: string;
  aliases: string[];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordBoundaryMatch(text: string, term: string): number {
  if (term.trim().length === 0) return -1;
  // Boundaries exclude word chars and domain continuation: "Parva" must not
  // match inside "parva.com" (that's the alias's job) or "app.parva.io",
  // while a sentence-ending "…recommend Parva." still matches.
  const re = new RegExp(
    `(?<![\\w.])${escapeRegex(term)}(?!\\w)(?!\\.\\w)`,
    "i"
  );
  const match = re.exec(text);
  return match ? match.index : -1;
}

/** First hit per company; canonical name outranks aliases. */
export function scanAliases(text: string, companies: CompanyAliases[]): AliasHit[] {
  const hits: AliasHit[] = [];
  for (const company of companies) {
    const canonicalIdx = wordBoundaryMatch(text, company.name);
    if (canonicalIdx !== -1) {
      hits.push({
        companyId: company.id,
        tier: "canonical",
        matched: company.name,
        index: canonicalIdx,
      });
      continue;
    }
    for (const alias of company.aliases) {
      const idx = wordBoundaryMatch(text, alias);
      if (idx !== -1) {
        hits.push({ companyId: company.id, tier: "alias", matched: alias, index: idx });
        break;
      }
    }
  }
  return hits;
}

export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)\]}"'<>]+/gi) ?? [];
  return [...new Set(matches.map((u) => u.replace(/[.,;:!?]+$/, "")))];
}

export function urlDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export interface ListItem {
  position: number;
  text: string;
}

/** Detect ordered/bulleted list items ("1. Foo", "- Bar", "* Baz", "2) Qux"). */
export function detectListItems(text: string): ListItem[] {
  const items: ListItem[] = [];
  let position = 0;
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(?:\d+[.)]|[-*•])\s+(.*)$/);
    if (match && (match[1] as string).trim().length > 0) {
      position += 1;
      items.push({ position, text: match[1] as string });
    }
  }
  return items;
}

/** Naive sentence splitter — good enough for excerpt selection. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The verbatim sentence containing the term, capped at maxLen (docs/13). */
export function excerptFor(
  text: string,
  term: string,
  maxLen = 300
): string | null {
  for (const sentence of splitSentences(text)) {
    if (wordBoundaryMatch(sentence, term) !== -1) {
      const excerpt = sentence.slice(0, maxLen);
      // Excerpt must be a verbatim substring of the source (docs/12)
      return text.includes(excerpt) ? excerpt : null;
    }
  }
  return null;
}
