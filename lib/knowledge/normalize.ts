/**
 * Canonical source normalization (spec 021 Part 5).
 *
 * The rule that shapes this module: **normalization never discards the
 * original, and never resolves ambiguity by picking a winner.** Every
 * normalization returns the original value alongside the normalized one, plus a
 * match status and confidence. A `probable` or `ambiguous` entity match is
 * surfaced for review; it does not quietly become a fact.
 *
 * Reuses `urlDomain` from `lib/parsing/prepass.ts` rather than writing a second
 * URL helper (CLAUDE.md: search lib/ before writing a utility).
 */
import {
  MATCH_CONFIDENCE_AMBIGUOUS,
  MATCH_CONFIDENCE_EXACT,
  MATCH_CONFIDENCE_PROBABLE,
  TRACKING_PARAMS,
} from "@/lib/knowledge/constants";
import { urlDomain } from "@/lib/parsing/prepass";

export type MatchStatus = "exact" | "probable" | "ambiguous" | "unmatched";

export interface NormalizedValue {
  originalValue: string;
  normalizedValue: string;
  matchStatus: MatchStatus;
  matchConfidence: number;
  requiresReview: boolean;
}

// ----------------------------------------------------------------------- urls

/** Lowercase scheme and host, strip tracking params, drop a trailing slash. */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.hash = "";
  for (const param of TRACKING_PARAMS) url.searchParams.delete(param);
  // Sorted so two orderings of the same query are one URL.
  url.searchParams.sort();
  // Normalize the *path*, not the serialized string: `/a/?q=1` and `/a?q=1`
  // are the same resource, and a trailing slash before a query would otherwise
  // survive because the string does not end with it.
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  const out = url.toString();
  return url.pathname === "/" && !url.search ? out.replace(/\/$/, "") : out;
}

export function normalizeDomain(raw: string): string {
  const asUrl = urlDomain(raw.includes("://") ? raw : `https://${raw.trim()}`);
  return asUrl ?? raw.trim().toLowerCase().replace(/^www\./, "");
}

// ---------------------------------------------------------------------- dates

/**
 * Parse the date formats that actually turn up in this domain's exports:
 * ISO, US slash, "March 3, 2025", "Q3 2025", and bare years. Returns null
 * rather than guessing — an unparseable date is missing data, not a default.
 */
export function normalizeDate(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (slash) {
    return `${slash[3]}-${pad(slash[1]!)}-${pad(slash[2]!)}`;
  }

  const monthName =
    /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(value) ??
    /^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(value);
  if (monthName) {
    const [name, day, year] = /^\d/.test(monthName[1]!)
      ? [monthName[2]!, monthName[1]!, monthName[3]!]
      : [monthName[1]!, monthName[2]!, monthName[3]!];
    const month = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
    if (month >= 0) return `${year}-${pad(String(month + 1))}-${pad(day)}`;
  }

  // "Q3 2025" → the quarter's first day. The period, not a point, is the fact;
  // callers that care record the period separately.
  const quarter = /^Q([1-4])\s+(\d{4})$/i.exec(value);
  if (quarter) {
    const month = (Number(quarter[1]) - 1) * 3 + 1;
    return `${quarter[2]}-${pad(String(month))}-01`;
  }

  const year = /^(\d{4})$/.exec(value);
  if (year) return `${year[1]}-01-01`;

  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function pad(value: string): string {
  return value.padStart(2, "0");
}

// ------------------------------------------------------------------- currency

export interface NormalizedAmount {
  /** Minor units — cents for USD — so no float ever holds money. */
  minorUnits: number;
  currency: string;
  originalValue: string;
}

const CURRENCY_SYMBOLS: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP" };
const MAGNITUDES: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

/** "$1.2M" → 120000000 cents USD. "180,000" → 18000000 cents. */
export function normalizeAmount(raw: string, defaultCurrency = "USD"): NormalizedAmount | null {
  const value = raw.trim();
  if (value.length === 0) return null;

  const symbol = Object.keys(CURRENCY_SYMBOLS).find((s) => value.includes(s));
  const isoCode = /\b(USD|EUR|GBP|CAD|AUD)\b/i.exec(value)?.[1]?.toUpperCase();
  const currency = isoCode ?? (symbol ? CURRENCY_SYMBOLS[symbol]! : defaultCurrency);

  const match = /(-?[\d,]*\.?\d+)\s*([kmb])?/i.exec(value.replace(/[^\d.,kmbKMB-]/g, " "));
  if (!match) return null;
  const base = Number(match[1]!.replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const magnitude = match[2] ? MAGNITUDES[match[2].toLowerCase()] ?? 1 : 1;

  return {
    minorUnits: Math.round(base * magnitude * 100),
    currency,
    originalValue: value,
  };
}

// -------------------------------------------------------------- entity names

/** Casefold, drop punctuation and corporate suffixes, collapse whitespace. */
export function normalizeEntityName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,'\u2019"()]/g, "")
    .replace(/\b(llc|inc|ltd|corp|corporation|co|group|team|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Score a candidate name against a known one. Deliberately conservative: an
 * exact normalized match is 1.0, a containment match is `probable`, a token
 * overlap above half is `ambiguous`, and anything else is unmatched. Nothing
 * here promotes itself to a fact — `requiresReview` is true below `exact`.
 */
export function scoreNameMatch(candidate: string, known: string): NormalizedValue {
  const a = normalizeEntityName(candidate);
  const b = normalizeEntityName(known);

  if (a.length === 0 || b.length === 0) {
    return unmatched(candidate, a);
  }
  if (a === b) {
    return {
      originalValue: candidate,
      normalizedValue: a,
      matchStatus: "exact",
      matchConfidence: MATCH_CONFIDENCE_EXACT,
      requiresReview: false,
    };
  }
  if (a.includes(b) || b.includes(a)) {
    return {
      originalValue: candidate,
      normalizedValue: a,
      matchStatus: "probable",
      matchConfidence: MATCH_CONFIDENCE_PROBABLE,
      requiresReview: true,
    };
  }
  const tokensA = new Set(a.split(" "));
  const tokensB = new Set(b.split(" "));
  const shared = [...tokensA].filter((t) => tokensB.has(t)).length;
  const overlap = shared / Math.max(tokensA.size, tokensB.size);
  if (overlap >= 0.5) {
    return {
      originalValue: candidate,
      normalizedValue: a,
      matchStatus: "ambiguous",
      matchConfidence: Math.max(MATCH_CONFIDENCE_AMBIGUOUS, Number(overlap.toFixed(3))),
      requiresReview: true,
    };
  }
  return unmatched(candidate, a);
}

function unmatched(original: string, normalized: string): NormalizedValue {
  return {
    originalValue: original,
    normalizedValue: normalized,
    matchStatus: "unmatched",
    matchConfidence: 0,
    requiresReview: true,
  };
}

/** Pick the best match among candidates, keeping ambiguity when it exists. */
export function bestMatch(
  candidate: string,
  known: { id: string; name: string }[]
): { entityId: string | null; match: NormalizedValue } {
  let best: { id: string; match: NormalizedValue } | null = null;
  let runnerUpConfidence = 0;

  for (const entry of known) {
    const match = scoreNameMatch(candidate, entry.name);
    if (match.matchStatus === "unmatched") continue;
    if (!best || match.matchConfidence > best.match.matchConfidence) {
      if (best) runnerUpConfidence = best.match.matchConfidence;
      best = { id: entry.id, match };
    } else if (match.matchConfidence > runnerUpConfidence) {
      runnerUpConfidence = match.matchConfidence;
    }
  }

  if (!best) {
    return { entityId: null, match: unmatched(candidate, normalizeEntityName(candidate)) };
  }
  // Two candidates scoring the same is ambiguity, not a coin toss.
  if (runnerUpConfidence === best.match.matchConfidence) {
    return {
      entityId: null,
      match: { ...best.match, matchStatus: "ambiguous", requiresReview: true },
    };
  }
  return { entityId: best.id, match: best.match };
}
