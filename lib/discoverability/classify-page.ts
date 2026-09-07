/**
 * Real-estate page classification (spec 088, page-classifier-v1). Extends
 * the onboarding crawler's pattern table (lib/knowledge/sources/discover.ts
 * scoreUrlForAudit — kept for importance scoring) into the page-kind enum
 * the technical checks reason about — and this time the result is persisted.
 *
 * Deterministic URL+title patterns. A wrong deterministic label is
 * debuggable in one place (the source-classifier precedent). "generic" means
 * "no pattern matched", never "unimportant".
 */
import { PAGE_CLASSIFIER_VERSION, type PageKind } from "@/lib/discoverability/constants";

export { PAGE_CLASSIFIER_VERSION };

interface KindPattern {
  kind: PageKind;
  pattern: RegExp;
}

/** First match wins — ordered specific → general. */
const URL_PATTERNS: KindPattern[] = [
  { kind: "transaction", pattern: /(transactions?|sold|sales|closed|deals|track-record|results)/i },
  { kind: "case_study", pattern: /(case-stud|success-stor)/i },
  { kind: "press", pattern: /(press|news|media|awards?|recognition|featured)/i },
  { kind: "building", pattern: /(buildings?|developments?|condos\/|towers?|residences)/i },
  { kind: "neighborhood", pattern: /(neighborhoods?|neighbourhoods?|communities|areas)/i },
  { kind: "market", pattern: /(markets?|market-report|locations?|cities|city-guide)/i },
  { kind: "property_type", pattern: /(condos?|townhomes?|townhouses?|brownstones?|waterfront|luxury-homes?|new-construction)/i },
  { kind: "agent", pattern: /(agents?\/|realtors?\/|profile)/i },
  { kind: "team", pattern: /(team|our-team|people|staff|meet-)/i },
  { kind: "authority", pattern: /(about|about-us|our-story|who-we-are|expertise|services?|specialt|what-we-do)/i },
  { kind: "blog", pattern: /(blog|insights?|guides?|resources?|articles?)/i },
  { kind: "contact", pattern: /(contact|office)/i },
];

const TITLE_PATTERNS: KindPattern[] = [
  { kind: "transaction", pattern: /\b(sold|closed|transactions?|track record)\b/i },
  { kind: "press", pattern: /\b(press|in the news|awards?)\b/i },
  { kind: "neighborhood", pattern: /\bneighborhoods?\b/i },
  { kind: "team", pattern: /\b(meet the team|our team)\b/i },
];

export function classifyPage(url: string, title: string | null): PageKind {
  let path: string;
  try {
    const parsed = new URL(url);
    path = parsed.pathname;
    if (path === "/" || path === "") return "homepage";
  } catch {
    path = url;
  }
  for (const { kind, pattern } of URL_PATTERNS) {
    if (pattern.test(path)) return kind;
  }
  if (title) {
    for (const { kind, pattern } of TITLE_PATTERNS) {
      if (pattern.test(title)) return kind;
    }
  }
  return "generic";
}
