/**
 * Mention classifier v1 — deterministic heuristics over the pre-pass
 * (DECISIONS.md: heuristic-first parser; an LLM refinement stage becomes a
 * new parser_version when provider keys exist). Ambiguity is expressed as
 * lowered confidence so uncertain rows land in human review rather than in
 * scores (docs/06 thresholds).
 *
 * Confidence formula (docs/06):
 *   0.5 × extraction_certainty + 0.3 × alias_match_strength + 0.2 × structural_clarity
 */
import type { Sentiment } from "@/lib/constants";
import { CONFIDENCE_REVIEW_THRESHOLD } from "@/lib/constants";
import {
  scanAliases,
  extractUrls,
  urlDomain,
  detectListItems,
  excerptFor,
  splitSentences,
  type CompanyAliases,
} from "@/lib/parsing/prepass";

export interface CompanyInput extends CompanyAliases {
  domain: string | null;
}

export interface MentionDraft {
  companyId: string;
  mentioned: boolean;
  recommended: boolean;
  listPosition: number | null;
  sentiment: Sentiment;
  excerpt: string | null;
  citedUrls: string[];
  confidence: number;
  needsReview: boolean;
}

const RECOMMEND_PATTERNS =
  /\b(recommend(?:ed|s)?|suggest(?:ed|s)?|i'?d (?:go with|start with|pick|choose)|top (?:pick|choice)|best (?:option|choice|bet|tool|pick)|go[- ]to|start with)\b/i;

const POSITIVE_WORDS =
  /\b(excellent|great|strong|solid|best|leading|outstanding|impressive|reliable|powerful|robust|top)\b/i;
const NEGATIVE_WORDS =
  /\b(avoid|poor|weak|limited|lacking|worse|worst|clunky|outdated|unreliable|falls short)\b/i;

function nearbyText(text: string, term: string): string {
  const sentences = splitSentences(text);
  const hitIndex = sentences.findIndex((s) =>
    s.toLowerCase().includes(term.toLowerCase())
  );
  if (hitIndex === -1) return "";
  return [sentences[hitIndex - 1], sentences[hitIndex], sentences[hitIndex + 1]]
    .filter(Boolean)
    .join(" ");
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Classify one response against the tracked companies. Only companies with
 * an alias hit produce drafts — absence of a row means not-mentioned. */
export function classifyResponse(
  responseText: string,
  companies: CompanyInput[]
): MentionDraft[] {
  if (responseText.trim().length === 0) return [];

  const hits = scanAliases(responseText, companies);
  const urls = extractUrls(responseText);
  const listItems = detectListItems(responseText);
  const listById = new Map<string, number>();
  for (const company of companies) {
    for (const item of listItems) {
      if (scanAliases(item.text, [company]).length > 0) {
        listById.set(company.id, item.position);
        break;
      }
    }
  }

  return hits.map((hit) => {
    const company = companies.find((c) => c.id === hit.companyId);
    const context = nearbyText(responseText, hit.matched);
    const listPosition = listById.get(hit.companyId) ?? null;

    const explicitRecommend = RECOMMEND_PATTERNS.test(context);
    const topOfList = listPosition === 1 && listItems.length >= 2;
    const recommended = explicitRecommend || topOfList;

    const positive = POSITIVE_WORDS.test(context);
    const negative = NEGATIVE_WORDS.test(context);
    let sentiment: Sentiment = "neutral";
    if (positive && negative) sentiment = "mixed";
    else if (positive || explicitRecommend) sentiment = "positive";
    else if (negative) sentiment = "negative";

    const citedUrls = company?.domain
      ? urls.filter((u) => urlDomain(u)?.endsWith(company.domain as string))
      : [];

    // Heuristic certainty: explicit signals are trustworthy; inferred
    // recommendation/sentiment from prose is where heuristics get shaky.
    let extractionCertainty = 0.9;
    if (recommended && !explicitRecommend) extractionCertainty = 0.7; // list-only
    if (!recommended && RECOMMEND_PATTERNS.test(responseText)) {
      // Recommendation language exists elsewhere — may misattribute
      extractionCertainty = Math.min(extractionCertainty, 0.75);
    }
    if (sentiment === "mixed") extractionCertainty = Math.min(extractionCertainty, 0.7);

    const aliasStrength = hit.tier === "canonical" ? 1.0 : 0.8;
    const structuralClarity = listPosition !== null || explicitRecommend ? 1.0 : 0.5;

    const confidence = clamp01(
      0.5 * extractionCertainty + 0.3 * aliasStrength + 0.2 * structuralClarity
    );

    return {
      companyId: hit.companyId,
      mentioned: true,
      recommended,
      listPosition,
      sentiment,
      excerpt: excerptFor(responseText, hit.matched),
      citedUrls,
      confidence: Number(confidence.toFixed(3)),
      needsReview: confidence < CONFIDENCE_REVIEW_THRESHOLD,
    };
  });
}
