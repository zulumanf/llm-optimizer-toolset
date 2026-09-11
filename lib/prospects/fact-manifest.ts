/**
 * Canonical artifact fact manifest (spec 137). Pure, no I/O.
 *
 * Every customer-facing artifact — the positive-reply email, the private
 * report, the video walkthrough, an evidence summary — consumes ONE
 * manifest compiled from ONE verified frozen evidence snapshot. Derived
 * quantities (production ratio, recommendation multiple, absolute gap)
 * are computed here by code, once, through the same helper the release
 * layer uses; no artifact recomputes them and no model derives them. The
 * manifest only compiles from a VERIFIED release verdict with a known
 * entity type on both sides — UNKNOWN never becomes a fact.
 *
 * Assertions at the bottom are the artifact-side check: a rendered report
 * or email whose figures are not the manifest's figures is not releasable.
 */
import { createHash } from "node:crypto";
import { derivedClaimFigures, type EvidenceReleaseVerdict } from "@/lib/prospects/evidence-release";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";
import { prospectReference, type ProspectEntityType } from "@/lib/prospects/followup-templates";

export const FACT_MANIFEST_VERSION = "fact-manifest-v1";

export const FACT_IDS = [
  "FACT_PROSPECT_NAME",
  "FACT_PROSPECT_ENTITY_TYPE",
  "FACT_MARKET",
  "FACT_PROSPECT_VOLUME",
  "FACT_COMPETITOR_NAME",
  "FACT_COMPETITOR_ENTITY_TYPE",
  "FACT_COMPETITOR_VOLUME",
  "FACT_PRODUCTION_YEAR",
  "FACT_PRODUCTION_METRIC",
  "FACT_PROSPECT_RECOMMENDATIONS",
  "FACT_COMPETITOR_RECOMMENDATIONS",
  "FACT_DENOMINATOR",
  "FACT_PROVIDER",
  "FACT_PRODUCTION_RATIO",
  "FACT_RECOMMENDATION_MULTIPLE",
  "FACT_ABSOLUTE_GAP",
  "FACT_APPROVED_EXAMPLE_IDS",
  "FACT_APPROVED_FIRST_ACTION_ID",
] as const;
export type FactId = (typeof FACT_IDS)[number];

export interface FactValue {
  id: FactId;
  /** Machine value: number, string, string[] or null (not derivable). */
  value: number | string | string[] | null;
  /** Customer-approved display form; the only form artifacts may render. */
  display: string;
  /** Where the value came from (snapshot field, derivation, approval). */
  source: string;
}

export interface FactManifest {
  version: string;
  /** sha256 of the canonical frozen snapshot JSON. */
  evidenceHash: string;
  /** sha256 of the manifest content (facts + source); the artifact key. */
  manifestHash: string;
  facts: Record<FactId, FactValue>;
  source: {
    runId: string;
    provider: string;
    promptPanelVersion: string;
    productionSignalIds: { prospect: string; competitor: string };
    companyIds: { prospect: string; competitor: string };
    verification: {
      version: string;
      primary: EvidenceReleaseVerdict["diagnostics"]["primary"];
      shadow: EvidenceReleaseVerdict["diagnostics"]["shadow"];
      entityLevels: EvidenceReleaseVerdict["diagnostics"]["entityLevels"];
      productionRecords: EvidenceReleaseVerdict["diagnostics"]["productionRecords"];
      correctionId: string | null;
    };
  };
}

export interface CompileManifestInput {
  snapshot: MismatchEvidenceSnapshot;
  verdict: EvidenceReleaseVerdict;
  market: string;
  prospectEntityType: ProspectEntityType | null;
  approvedExampleIds: string[];
  approvedFirstActionId: string | null;
}

export type CompileManifestResult = { ok: true; manifest: FactManifest } | { ok: false; reason: string };

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Stable JSON: keys sorted at every level so a hash is a content hash. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

export function evidenceHashOf(snapshot: MismatchEvidenceSnapshot): string {
  return sha(canonicalJson(snapshot));
}

/** "roughly 44%" — whole percent, never a decimal a reader would misread. */
export function productionRatioDisplay(pct: number | null): string | null {
  return pct === null ? null : `roughly ${Math.round(pct)}%`;
}
/** "12.5x as often" / "5x as often" (founder-approved form, 2026-09-11). */
export function recommendationMultipleDisplay(multiple: number | null): string | null {
  if (multiple === null) return null;
  const n = Number.isInteger(multiple) ? String(multiple) : multiple.toFixed(1);
  return `${n}x as often`;
}

const metricLabel = (t: MismatchEvidenceSnapshot["metricType"]): string => (t === "sides" ? "closed sides" : "closed volume");

export function compileFactManifest(i: CompileManifestInput): CompileManifestResult {
  const { snapshot: s, verdict: v } = i;
  if (!v.verified) return { ok: false, reason: `evidence not verified: ${v.reasons.join(", ")}` };
  if (!i.prospectEntityType) return { ok: false, reason: "prospect entity type unknown" };
  const compLevel = v.diagnostics.entityLevels?.competitor ?? null;
  if (!compLevel) return { ok: false, reason: "competitor entity type unknown" };
  const d = derivedClaimFigures(s);
  const ratio = productionRatioDisplay(d.productionRatioPct);
  const multiple = recommendationMultipleDisplay(d.recommendationMultiple);
  const f = (id: FactId, value: FactValue["value"], display: string, source: string): FactValue => ({ id, value, display, source });
  const facts: Record<FactId, FactValue> = {
    FACT_PROSPECT_NAME: f("FACT_PROSPECT_NAME", s.prospect.name, s.prospect.name, "snapshot.prospect.name"),
    FACT_PROSPECT_ENTITY_TYPE: f("FACT_PROSPECT_ENTITY_TYPE", i.prospectEntityType, i.prospectEntityType, "realtrends record entity_type"),
    FACT_MARKET: f("FACT_MARKET", i.market, i.market, "market launch"),
    FACT_PROSPECT_VOLUME: f("FACT_PROSPECT_VOLUME", s.prospect.productionValue, s.prospect.productionDisplay, `production signal ${s.prospect.productionSignalId}`),
    FACT_COMPETITOR_NAME: f("FACT_COMPETITOR_NAME", s.competitor.name, s.competitor.name, "snapshot.competitor.name"),
    FACT_COMPETITOR_ENTITY_TYPE: f("FACT_COMPETITOR_ENTITY_TYPE", compLevel, compLevel, "entity resolution status"),
    FACT_COMPETITOR_VOLUME: f("FACT_COMPETITOR_VOLUME", s.competitor.productionValue, s.competitor.productionDisplay, `production signal ${s.competitor.productionSignalId}`),
    FACT_PRODUCTION_YEAR: f("FACT_PRODUCTION_YEAR", s.prospect.productionYear, s.prospect.productionYear ? String(s.prospect.productionYear) : "", "production record period"),
    FACT_PRODUCTION_METRIC: f("FACT_PRODUCTION_METRIC", s.metricType, metricLabel(s.metricType), "snapshot.metricType"),
    FACT_PROSPECT_RECOMMENDATIONS: f("FACT_PROSPECT_RECOMMENDATIONS", s.prospect.recommendationCount, String(s.prospect.recommendationCount), "snapshot count, primary = shadow verified"),
    FACT_COMPETITOR_RECOMMENDATIONS: f("FACT_COMPETITOR_RECOMMENDATIONS", s.competitor.recommendationCount, String(s.competitor.recommendationCount), "snapshot count, primary = shadow verified"),
    FACT_DENOMINATOR: f("FACT_DENOMINATOR", s.answerCount, String(s.answerCount), "valid answers, primary = shadow verified"),
    FACT_PROVIDER: f("FACT_PROVIDER", s.provider, s.provider === "openai" ? "the OpenAI model behind ChatGPT" : s.provider, "snapshot.provider"),
    FACT_PRODUCTION_RATIO: f("FACT_PRODUCTION_RATIO", d.productionRatioPct, ratio ?? "", "derivedClaimFigures: competitor / prospect production"),
    FACT_RECOMMENDATION_MULTIPLE: f("FACT_RECOMMENDATION_MULTIPLE", d.recommendationMultiple, multiple ?? "", "derivedClaimFigures: competitor / prospect recommendations"),
    FACT_ABSOLUTE_GAP: f("FACT_ABSOLUTE_GAP", d.absoluteGap, `${d.absoluteGap} more answers`, "derivedClaimFigures: competitor - prospect"),
    FACT_APPROVED_EXAMPLE_IDS: f("FACT_APPROVED_EXAMPLE_IDS", i.approvedExampleIds, i.approvedExampleIds.join(", "), "approved evidence examples"),
    FACT_APPROVED_FIRST_ACTION_ID: f("FACT_APPROVED_FIRST_ACTION_ID", i.approvedFirstActionId, i.approvedFirstActionId ?? "", "approved first action"),
  };
  const source: FactManifest["source"] = {
    runId: s.runId,
    provider: s.provider,
    promptPanelVersion: s.templateVersion,
    productionSignalIds: { prospect: s.prospect.productionSignalId, competitor: s.competitor.productionSignalId },
    companyIds: { prospect: s.prospect.companyId, competitor: s.competitor.companyId },
    verification: {
      version: v.version,
      primary: v.diagnostics.primary,
      shadow: v.diagnostics.shadow,
      entityLevels: v.diagnostics.entityLevels,
      productionRecords: v.diagnostics.productionRecords,
      correctionId: v.diagnostics.correctionId ?? null,
    },
  };
  const evidenceHash = evidenceHashOf(s);
  const manifestHash = sha(canonicalJson({ version: FACT_MANIFEST_VERSION, evidenceHash, facts, source }));
  return { ok: true, manifest: { version: FACT_MANIFEST_VERSION, evidenceHash, manifestHash, facts, source } };
}

// ------------------------------------------------------------ compiled sentences

export interface CompiledSentence {
  text: string;
  /** Every fact the sentence states — the claim annotation (internal only). */
  factIds: FactId[];
}

/** The one comparative sentence the email and video may state. Assembled
 * from manifest displays only; the wording changes only with the manifest
 * version. */
export function validatedSummarySentence(m: FactManifest): CompiledSentence {
  const comp = m.facts.FACT_COMPETITOR_NAME.display;
  const den = m.facts.FACT_DENOMINATOR.display;
  const ratio = m.facts.FACT_PRODUCTION_RATIO.value === null ? null : m.facts.FACT_PRODUCTION_RATIO.display;
  const multiple = m.facts.FACT_RECOMMENDATION_MULTIPLE.value === null ? null : m.facts.FACT_RECOMMENDATION_MULTIPLE.display;
  const entity = m.facts.FACT_PROSPECT_ENTITY_TYPE.value as ProspectEntityType;
  const yours = entity === "team" ? "your team's" : "your";
  const ref = prospectReference(entity);
  if (ratio && multiple) {
    return {
      text: `${comp} closed ${ratio} of ${yours} volume, but was recommended ${multiple} in the same ${den}-answer test.`,
      factIds: ["FACT_COMPETITOR_NAME", "FACT_PRODUCTION_RATIO", "FACT_RECOMMENDATION_MULTIPLE", "FACT_DENOMINATOR"],
    };
  }
  if (ratio) {
    const cr = m.facts.FACT_COMPETITOR_RECOMMENDATIONS.display;
    return {
      text: `${comp} closed ${ratio} of ${yours} volume, but was recommended in ${cr} of the same ${den} answers while ${ref} was not recommended in any.`,
      factIds: ["FACT_COMPETITOR_NAME", "FACT_PRODUCTION_RATIO", "FACT_COMPETITOR_RECOMMENDATIONS", "FACT_DENOMINATOR", "FACT_PROSPECT_RECOMMENDATIONS"],
    };
  }
  const cr = m.facts.FACT_COMPETITOR_RECOMMENDATIONS.display;
  const pr = m.facts.FACT_PROSPECT_RECOMMENDATIONS.display;
  return {
    text: `${comp} was recommended in ${cr} of ${den} answers versus ${pr} for ${ref}.`,
    factIds: ["FACT_COMPETITOR_NAME", "FACT_COMPETITOR_RECOMMENDATIONS", "FACT_DENOMINATOR", "FACT_PROSPECT_RECOMMENDATIONS"],
  };
}

// ------------------------------------------------------------ assertions

export interface ManifestAssertionIssue { check: string; detail: string }

/** Numeric tokens in a text: counts, money ("$47.2M"), percents, years. */
const NUMBER_TOKEN = /\$?\d[\d,]*(?:\.\d+)?%?[MKkx]?/g;
export function numberTokens(text: string): string[] {
  return (text.match(NUMBER_TOKEN) ?? []).map((t) => t.replace(/,/g, ""));
}

/** The number tokens the manifest licenses an artifact to state. */
export function manifestNumberTokens(m: FactManifest): Set<string> {
  const out = new Set<string>();
  for (const f of Object.values(m.facts)) for (const t of numberTokens(f.display)) out.add(t);
  return out;
}

/** Every number in the text must be a manifest number (after the caller
 * removes non-factual regions such as URLs and the postal footer). */
export function assertTextNumbersManifested(text: string, m: FactManifest, allowedExtra: string[] = []): ManifestAssertionIssue[] {
  const allowed = manifestNumberTokens(m);
  for (const x of allowedExtra) for (const t of numberTokens(x)) allowed.add(t);
  const bad = [...new Set(numberTokens(text))].filter((t) => !allowed.has(t));
  return bad.length ? [{ check: "unmanifested_number", detail: `figure(s) not in the fact manifest: ${bad.join(", ")}` }] : [];
}

/** The private report's headline facts equal the manifest's. */
export function assertReportMatchesManifest(
  block: {
    prospect: { name: string; productionDisplay: string; productionYear: number | null; recommendationCount: number };
    competitor: { name: string; productionDisplay: string; productionYear: number | null; recommendationCount: number };
    answerCount: number;
  },
  m: FactManifest
): ManifestAssertionIssue[] {
  const issues: ManifestAssertionIssue[] = [];
  const eq = (check: string, got: unknown, want: unknown): void => {
    if (got !== want) issues.push({ check, detail: `report states ${JSON.stringify(got)}, manifest ${JSON.stringify(want)}` });
  };
  eq("prospect_name", block.prospect.name, m.facts.FACT_PROSPECT_NAME.value);
  eq("competitor_name", block.competitor.name, m.facts.FACT_COMPETITOR_NAME.value);
  eq("prospect_recommendations", block.prospect.recommendationCount, m.facts.FACT_PROSPECT_RECOMMENDATIONS.value);
  eq("competitor_recommendations", block.competitor.recommendationCount, m.facts.FACT_COMPETITOR_RECOMMENDATIONS.value);
  eq("denominator", block.answerCount, m.facts.FACT_DENOMINATOR.value);
  eq("prospect_volume", block.prospect.productionDisplay, m.facts.FACT_PROSPECT_VOLUME.display);
  eq("competitor_volume", block.competitor.productionDisplay, m.facts.FACT_COMPETITOR_VOLUME.display);
  eq("production_year", block.prospect.productionYear, m.facts.FACT_PRODUCTION_YEAR.value);
  return issues;
}

/** Fields that must never reach a customer-facing artifact. */
const INTERNAL_KEY = /(^|[_.-])(id|ids|hash|token|key|secret|debug|internal|qa|diag|parser|revision|companyId|runId|manifestHash|evidenceHash)$/i;
export function assertNoInternalFields(rendered: Record<string, unknown>): ManifestAssertionIssue[] {
  const bad = Object.keys(rendered).filter((k) => INTERNAL_KEY.test(k));
  return bad.length ? [{ check: "internal_field_rendered", detail: `internal field(s) in customer-facing props: ${bad.join(", ")}` }] : [];
}
