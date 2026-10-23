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

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordBoundaryMatch(text: string, term: string): number {
  if (term.trim().length === 0) return -1;
  // Boundaries exclude word chars and domain continuation: "Lumina" must not
  // match inside "lumina.com" (that's the alias's job) or "app.lumina.io",
  // while a sentence-ending "…recommend Lumina." still matches.
  const re = new RegExp(
    `(?<![\\w.])${escapeRegex(term)}(?!\\w)(?!\\.\\w)`,
    "i"
  );
  const match = re.exec(text);
  return match ? match.index : -1;
}

/**
 * Entity-text normalization (spec 151 A7): case, "&"/"and", possessives,
 * curly quotes and punctuation fold to one canonical form. A period that
 * continues a word ("lumina.com") is KEPT — the boundary rule above refuses
 * domain continuations and normalization must not reopen that hole.
 *
 * Returns the normalized string plus, for every normalized character, the
 * index of the original character it came from, so a normalized hit still
 * reports a position in the raw answer.
 */
export function normalizeEntityText(raw: string): { text: string; map: number[] } {
  let out = "";
  const map: number[] = [];
  const emit = (str: string, at: number) => {
    for (const ch of str) {
      if (ch === " " && (out.length === 0 || out.endsWith(" ") || out.endsWith(BOUNDARY))) continue;
      if (ch === BOUNDARY && out.endsWith(" ")) {
        out = out.slice(0, -1);
        map.pop();
      }
      if (ch === BOUNDARY && out.endsWith(BOUNDARY)) continue;
      out += ch;
      map.push(at);
    }
  };
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] as string;
    const next = raw[i + 1] ?? "";
    if (ch === "&") {
      emit(" and ", i);
    } else if ((ch === "'" || ch === "\u2019") && /s/i.test(next) && !/\w/.test(raw[i + 2] ?? "")) {
      i += 1; // possessive "'s" folds away
    } else if (ch === "." && /\w/.test(next) && /\w/.test(raw[i - 1] ?? "")) {
      emit(".", i);
    } else if (/[\w]/.test(ch)) {
      emit(ch.toLowerCase(), i);
    } else if (HARD_BOUNDARY_CHARS.test(ch)) {
      // Sentence ends, list commas, colons and line breaks are hard
      // boundaries: "…in Charleston. Real estate…" must never match
      // "Charleston Real Estate" (review finding H2).
      emit(BOUNDARY, i);
    } else {
      emit(" ", i);
    }
  }
  while (out.endsWith(" ") || out.endsWith(BOUNDARY)) {
    out = out.slice(0, -1);
    map.pop();
  }
  return { text: out, map };
}

/** A character no entity term can normalize INTO the middle of a match. */
const BOUNDARY = "|";
const HARD_BOUNDARY_CHARS = /[.!?,;:\n\r|()[\]{}"\u201C\u201D]/;

/** Normalized multi-token terms only: a single word gains nothing from
 * normalization the boundary match does not already give, and limiting the
 * second path to phrases keeps the precision trade-off measurable
 * (tests/unit/entity-normalization.test.ts). */
export const MIN_TOKENS_FOR_NORMALIZED_MATCH = 2;

function normalizedMatch(text: string, term: string): number {
  const nTerm = normalizeEntityText(term).text;
  if (nTerm.includes(BOUNDARY)) return -1; // a term with internal punctuation only matches exactly
  if (nTerm.split(" ").filter(Boolean).length < MIN_TOKENS_FOR_NORMALIZED_MATCH) return -1;
  const nText = normalizeEntityText(text);
  const re = new RegExp(`(?<![\\w.])${escapeRegex(nTerm)}(?![\\w])(?!\\.\\w)`);
  const match = re.exec(nText.text);
  return match ? (nText.map[match.index] ?? -1) : -1;
}

/** Exact boundary match first; the normalized path only when it misses. */
export function entityMatchIndex(text: string, term: string): number {
  const exact = wordBoundaryMatch(text, term);
  return exact !== -1 ? exact : normalizedMatch(text, term);
}

/** First hit per company; canonical name outranks aliases. */
export function scanAliases(text: string, companies: CompanyAliases[]): AliasHit[] {
  const hits: AliasHit[] = [];
  for (const company of companies) {
    const canonicalIdx = entityMatchIndex(text, company.name);
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
      const idx = entityMatchIndex(text, alias);
      if (idx !== -1) {
        hits.push({ companyId: company.id, tier: "alias", matched: alias, index: idx });
        break;
      }
    }
  }
  return hits;
}

/** True when the text names the term (whole word/phrase, plus the
 * normalized path). Stricter-recall sibling of the SQL echo rule in
 * lib/scoring/prompt-echo.ts, which matches exact whole words only: the two
 * can disagree on "&"/"and" and possessive variants. */
export function textNamesTerm(text: string, term: string): boolean {
  return term.trim().length > 0 && entityMatchIndex(text, term) !== -1;
}

/** Canonical owner domain: lowercase host, no scheme, path, port or www. */
export function normalizeOwnerDomain(domain: string): string {
  const trimmed = domain.trim().toLowerCase();
  const host = trimmed.replace(/^[a-z]+:\/\//, "").split(/[/?#:]/)[0] ?? "";
  return host.replace(/^www\./, "").replace(/\.$/, "");
}

/**
 * Spec 151 A6 — the ONE ownership rule for a cited host: the exact owner
 * domain or a dot-bounded subdomain of it. `notacme.com` never belongs to
 * `acme.com` (the defect every bare `endsWith` call carried).
 */
export function domainBelongsTo(host: string | null | undefined, ownerDomain: string | null | undefined): boolean {
  if (!host || !ownerDomain) return false;
  const h = normalizeOwnerDomain(host);
  const o = normalizeOwnerDomain(ownerDomain);
  if (h.length === 0 || o.length === 0) return false;
  return h === o || h.endsWith(`.${o}`);
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
    if (entityMatchIndex(sentence, term) !== -1) {
      const excerpt = sentence.slice(0, maxLen);
      // Excerpt must be a verbatim substring of the source (docs/12)
      return text.includes(excerpt) ? excerpt : null;
    }
  }
  return null;
}
