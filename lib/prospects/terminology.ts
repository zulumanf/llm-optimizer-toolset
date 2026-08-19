/**
 * Prospect-facing terminology (2026-08-19): the one place audit copy gets
 * its measurement vocabulary, so precision cannot regress page by page.
 *
 * Canonical vocabulary (docs/06/07 made prospect-legible):
 * - benchmark          — a defined prompt set × repeated runs
 * - answer / response  — one generated AI output
 * - mention            — one appearance of an entity within an answer
 * - recommendation     — an entity specifically suggested to the asker
 * - citation / source  — a page an answer linked as its source
 * - authority signal   — independent evidence of real-world performance
 * - derived estimate   — our arithmetic over sourced numbers, labeled as such
 *
 * Rules enforced here rather than in prose:
 * - An API benchmark is never described as testing a consumer app
 *   ("we asked ChatGPT") — the tested-system phrase derives from run
 *   metadata (providers + collection facts), not from a hardcoded brand.
 * - Mention counts are never labeled as answer counts: one answer usually
 *   names several teams, so mentions outnumber answers by design.
 */
import type { AuditSnapshot } from "@/lib/prospects/audits";

/** Provider id → prospect-readable name. Unknown ids pass through as-is
 * rather than guessing a brand. */
const PROVIDER_DISPLAY: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  perplexity: "Perplexity",
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  mock: "test provider",
};

/** The consumer assistant a reader can use to spot-check a provider's
 * models — an invitation to verify, never a claim about what was tested. */
const CONSUMER_COUNTERPART: Record<string, string> = {
  openai: "ChatGPT",
  anthropic: "Claude",
  google: "Gemini",
  perplexity: "Perplexity",
};

export function providerDisplayName(id: string): string {
  return PROVIDER_DISPLAY[id] ?? id;
}

function joinNames(names: string[]): string {
  const unique = [...new Set(names)];
  if (unique.length <= 1) return unique[0] ?? "";
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
}

export function providersDisplay(providers: string[]): string {
  return joinNames(providers.map(providerDisplayName));
}

/**
 * What was actually tested, derived from run metadata. API collections are
 * described as models accessed through the provider's developer interface —
 * never as the consumer product ("we asked ChatGPT"), which spec 011 keeps
 * as a separately-denominated manual workflow (consumerValidation).
 */
export function testedSystemPhrase(
  providers: string[],
  collection: AuditSnapshot["collection"] | null | undefined
): string {
  const names = providersDisplay(providers.filter((p) => p !== "mock"));
  if (!names) return "the listed AI engines";
  if (!collection) {
    // Legacy snapshots carry no collection facts — stay neutral.
    return `${names} AI models`;
  }
  const searchOnly = collection.searchEnabled > 0 && collection.modelOnly === 0;
  const plural = providers.filter((p) => p !== "mock").length > 1;
  if (searchOnly) {
    return plural
      ? `search-enabled AI models from ${names}`
      : `a search-enabled ${names} model`;
  }
  if (collection.searchEnabled > 0) {
    return `${names} models, with and without live web search`;
  }
  return plural ? `AI models from ${names}` : `an ${names} model`;
}

/** "Try one yourself in ChatGPT" — the verification invitation, named from
 * the tested providers' consumer counterparts. */
export function verifySuggestionApps(providers: string[]): string {
  const names = providers
    .map((p) => CONSUMER_COUNTERPART[p])
    .filter((n): n is string => Boolean(n));
  return names.length > 0 ? joinNames(names) : "any AI assistant";
}

// ---------------------------------------------------- mention arithmetic

/** The headline count, with its unit stated: mentions, never answers. */
export function recommendationMentionsLine(
  totalMentions: number,
  responseCount: number
): string {
  return `${totalMentions} recommendation mentions across the ${responseCount} answers`;
}

/** Why mentions outnumber answers — stated next to the count, always. */
export const MENTIONS_VS_ANSWERS_NOTE =
  "One answer usually names several options, so mentions outnumber answers.";

export function mentionSplitLine(
  teamMentions: number,
  brandMentions: number
): string {
  return `${teamMentions} mentions of individual teams · ${brandMentions} of brokerage brands`;
}

// ------------------------------------------------------- source quality

export type SignalSourceType =
  | "independent"
  | "self_reported"
  | "derived"
  | "sponsored";

/** Prospect-readable evidence-quality badge. Null for legacy/unclassified
 * rows — they keep the neutral provenance rendering, never a guessed badge. */
export function sourceQualityLabel(
  sourceType: string | null | undefined
): string | null {
  switch (sourceType) {
    case "independent":
      return "Independent source";
    case "self_reported":
      return "Team-reported";
    case "sponsored":
      return "Sponsored coverage";
    case "derived":
      return "Derived estimate";
    default:
      return null;
  }
}

// -------------------------------------------------- actionable surfaces

/** What a cited surface is TO THE PROSPECT: a page they control, a profile
 * platform, coverage they can earn, or a competitor-owned page that is
 * diagnostic context — never an optimization target. */
export type SurfaceCategory = "owned" | "platform" | "earned" | "competitor";

export const SURFACE_CATEGORY_LABELS: Record<SurfaceCategory, string> = {
  owned: "your own site",
  platform: "third-party profile",
  earned: "earned coverage",
  competitor: "competitor-owned",
};

/** Map the source classifier's output (lib/sources/classify.ts) to the
 * prospect-facing actionability category. Unclassifiable → null (render
 * without a category, never a guess). */
export function surfaceCategory(classification: {
  sourceType: string;
  relationship: string;
}): SurfaceCategory | null {
  if (classification.relationship === "owned") return "owned";
  if (
    classification.relationship === "competitor" ||
    classification.sourceType === "brokerage"
  ) {
    return "competitor";
  }
  switch (classification.sourceType) {
    case "portal":
    case "directory":
    case "review":
    case "social":
      return "platform";
    case "news":
    case "local_press":
    case "industry_ranking":
    case "video":
    case "government":
      return "earned";
    default:
      return null;
  }
}

/** Competitor-owned surfaces are shown, never prescribed. */
export function isActionableSurface(
  category: SurfaceCategory | null | undefined
): boolean {
  return category !== "competitor";
}

export const COMPETITOR_SURFACE_NOTE =
  "Competitor-owned sites are shown because they help explain the " +
  "information environment around these answers — they are not surfaces " +
  "to get listed on.";
