/**
 * Observation provenance (spec 086): how an AI observation was collected,
 * which surface it reflects, and why it was measured — all DERIVED from
 * facts the platform already stores, never independently editable.
 *
 * Structural guarantee: `responses` rows are written only by the run
 * executor (API adapters), and manual consumer observations live only in
 * `client_validation_observations` (spec 011, never enter scores). An API
 * response therefore cannot be presented as a consumer observation — the
 * label comes from which table the row lives in, not from a mutable field.
 */

export const PROVENANCE_VERSION = "observation-provenance-v1";

export const COLLECTION_METHODS = [
  "api",
  "consumer_ui",
  "manual_ui",
  "licensed_provider",
  "serp_provider",
] as const;
export type CollectionMethod = (typeof COLLECTION_METHODS)[number];

export const SURFACES = ["model_only", "web_search", "consumer_web"] as const;
export type Surface = (typeof SURFACES)[number];

export const MEASUREMENT_PURPOSES = [
  "prospecting",
  "audit_validation",
  "client_baseline",
  "client_monitoring",
  "experiment_followup",
] as const;
export type MeasurementPurpose = (typeof MEASUREMENT_PURPOSES)[number];

export type MeasurementTier = "A" | "B" | "C" | "D";

/** Communicates how directly an observation reflects the consumer-facing
 * experience. NOT an accuracy ranking — a Tier D model-only measurement of
 * the same instrument is more reproducible than a Tier A screenshot. */
export const TIER_LABELS: Record<MeasurementTier, string> = {
  A: "Consumer UI observed",
  B: "Search-enabled provider API",
  C: "Licensed / third-party dataset",
  D: "Model-only provider API",
};

const SEARCH_SUFFIX = "+search";
const SEARCH_TOOLS = ["web_search", "googleSearch"];

export interface ApiObservationFacts {
  provider: string;
  model: string;
  /** responses.request_params — null on legacy rows captured before spec 058. */
  requestParams: { tools?: string[] } | null;
}

/** Surface of an API-collected response, from the instrument facts recorded
 * at capture time. Perplexity Sonar is inherently search-grounded. */
export function apiSurface(facts: ApiObservationFacts): Surface {
  if (facts.provider === "perplexity") return "web_search";
  if (facts.model.endsWith(SEARCH_SUFFIX)) return "web_search";
  const tools = facts.requestParams?.tools ?? [];
  if (tools.some((t) => SEARCH_TOOLS.includes(t))) return "web_search";
  return "model_only";
}

export function measurementTier(
  method: CollectionMethod,
  surface: Surface
): MeasurementTier {
  if (method === "consumer_ui" || method === "manual_ui") return "A";
  if (method === "licensed_provider" || method === "serp_provider") return "C";
  return surface === "web_search" ? "B" : "D";
}

export interface ObservationProvenance {
  collectionMethod: CollectionMethod;
  surface: Surface;
  tier: MeasurementTier;
  tierLabel: string;
}

/** Provenance of a `responses` row. */
export function apiObservationProvenance(
  facts: ApiObservationFacts
): ObservationProvenance {
  const surface = apiSurface(facts);
  const tier = measurementTier("api", surface);
  return { collectionMethod: "api", surface, tier, tierLabel: TIER_LABELS[tier] };
}

/** Provenance of a `client_validation_observations` row (staff-recorded
 * clean-session browser observation, spec 011). */
export function manualObservationProvenance(): ObservationProvenance {
  return {
    collectionMethod: "manual_ui",
    surface: "consumer_web",
    tier: "A",
    tierLabel: TIER_LABELS.A,
  };
}

export interface RunPurposeFacts {
  projectKind: "client" | "prospect";
  trigger: "manual" | "scheduled";
  /** intervention_runs.role when the run is linked to an intervention. */
  interventionRole: "baseline" | "post" | null;
}

/** Why a benchmark run was measured, derived from stored facts. Prevents a
 * lightweight prospecting measurement from being read as longitudinal client
 * monitoring. Consumer validation runs are `audit_validation` by construction
 * (they live in client_validation_runs, not here). */
export function measurementPurpose(facts: RunPurposeFacts): MeasurementPurpose {
  if (facts.interventionRole === "post") return "experiment_followup";
  if (facts.interventionRole === "baseline") return "client_baseline";
  if (facts.projectKind === "prospect") return "prospecting";
  return facts.trigger === "scheduled" ? "client_monitoring" : "client_baseline";
}

export type CollectorStatus =
  | "active"
  | "experimental"
  | "manual_only"
  | "disabled"
  | "unsupported";

export interface CollectorInfo {
  provider: string;
  surface: Surface;
  collectorType: CollectionMethod;
  status: CollectorStatus;
  citationSupport: boolean;
  screenshotSupport: boolean;
  notes: string;
}

/** What the platform can collect today, as code-reviewed facts. Consumer
 * surfaces are manual-only: no unauthorized scraping, no browser fleet
 * (spec 086 out-of-scope). Nothing reads this to gate behavior yet — it
 * documents capability honestly for operators and future adapters. */
export const COLLECTOR_REGISTRY: CollectorInfo[] = [
  { provider: "openai", surface: "model_only", collectorType: "api", status: "active", citationSupport: false, screenshotSupport: false, notes: "Chat Completions API" },
  { provider: "openai", surface: "web_search", collectorType: "api", status: "active", citationSupport: true, screenshotSupport: false, notes: "Responses API + web_search tool" },
  { provider: "anthropic", surface: "model_only", collectorType: "api", status: "active", citationSupport: false, screenshotSupport: false, notes: "Messages API" },
  { provider: "anthropic", surface: "web_search", collectorType: "api", status: "active", citationSupport: true, screenshotSupport: false, notes: "Messages API + web_search tool" },
  { provider: "google", surface: "model_only", collectorType: "api", status: "active", citationSupport: false, screenshotSupport: false, notes: "Gemini API, ungrounded" },
  { provider: "google", surface: "web_search", collectorType: "api", status: "active", citationSupport: true, screenshotSupport: false, notes: "Gemini API + googleSearch grounding" },
  { provider: "perplexity", surface: "web_search", collectorType: "api", status: "active", citationSupport: true, screenshotSupport: false, notes: "Sonar — inherently search-grounded" },
  { provider: "chatgpt", surface: "consumer_web", collectorType: "manual_ui", status: "manual_only", citationSupport: true, screenshotSupport: true, notes: "Clean-session validation workflow (spec 011)" },
  { provider: "gemini", surface: "consumer_web", collectorType: "manual_ui", status: "manual_only", citationSupport: true, screenshotSupport: true, notes: "Clean-session validation workflow (spec 011)" },
  { provider: "claude", surface: "consumer_web", collectorType: "manual_ui", status: "manual_only", citationSupport: true, screenshotSupport: true, notes: "Clean-session validation workflow (spec 011)" },
  { provider: "perplexity", surface: "consumer_web", collectorType: "manual_ui", status: "manual_only", citationSupport: true, screenshotSupport: true, notes: "Clean-session validation workflow (spec 011)" },
];
