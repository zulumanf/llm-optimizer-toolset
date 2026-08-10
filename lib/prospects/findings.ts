/**
 * Deterministic reality-to-AI finding candidates (spec 032). Pure functions:
 * the service queries; this module reasons. Every candidate carries the
 * response ids that evidence it, uses only observation language ("appears",
 * "recommended less frequently") and never claims revenue or causality —
 * `findProhibitedPhrase` is the guard both here (by construction) and at
 * approval (by validation).
 */
import {
  FINDING_GENERATOR_VERSION,
  MIN_RESPONSES_FOR_FINDINGS,
  type FindingKind,
  type FindingSeverity,
  type ProvenanceLabel,
} from "@/lib/prospects/constants";

export interface BenchmarkEntityMetrics {
  companyId: string;
  name: string;
  /** 0..1 or null when not measured — null is never treated as 0. */
  mentionRate: number | null;
  recommendationRate: number | null;
  shareOfVoice: number | null;
  citationScore: number | null;
  sampleSize: number;
  /** metric name → immutable scores row id (spec 052): the machine-checkable
   * provenance behind every rate a prospect is shown. */
  scoreIds: Record<string, string>;
}

export interface AuthoritySignalInput {
  id: string;
  kind: string;
  label: string;
  provenance: ProvenanceLabel;
}

export interface AbsenceEvidence {
  /** responses where this competitor was recommended and the prospect was not mentioned */
  competitorCompanyId: string;
  responseIds: string[];
}

export interface FindingCandidate {
  kind: FindingKind;
  title: string;
  explanation: string;
  metrics: Record<string, number | string | null>;
  signalIds: string[];
  responseIds: string[];
  competitorCompanyIds: string[];
  confidence: number;
  severity: FindingSeverity;
  businessRelevance: string;
  suggestedAngle: string;
  rankScore: number;
  generatorVersion: string;
}

export interface GeneratorInput {
  prospectName: string;
  prospect: BenchmarkEntityMetrics;
  competitors: BenchmarkEntityMetrics[];
  signals: AuthoritySignalInput[];
  absence: AbsenceEvidence[];
  /** responses (any provider) where the prospect was not mentioned at all */
  prospectAbsentResponseIds: string[];
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** Sample-size confidence: 0 at the minimum, ~0.9 by n=50, capped. */
function sampleConfidence(n: number): number {
  if (n < MIN_RESPONSES_FOR_FINDINGS) return 0;
  return Math.min(0.95, 0.4 + Math.log10(n) * 0.32);
}

function strongSignals(signals: AuthoritySignalInput[]): AuthoritySignalInput[] {
  return signals.filter(
    (s) => s.provenance === "verified" || s.provenance === "publicly_sourced"
  );
}

/**
 * Generate every defensible candidate. Deterministic: same inputs, same
 * candidates in the same order (sorted by rankScore desc, then title).
 */
export function generateFindingCandidates(input: GeneratorInput): FindingCandidate[] {
  const out: FindingCandidate[] = [];
  const p = input.prospect;
  if (p.sampleSize < MIN_RESPONSES_FOR_FINDINGS) return out;

  const confidence = sampleConfidence(p.sampleSize);
  const evidenced = strongSignals(input.signals);
  const allAbsenceIds = [...new Set(input.absence.flatMap((a) => a.responseIds))];

  // 1. Authority-vs-visibility gap: documented market position, weak
  // recommendation rate. Requires at least one verifiable signal — without
  // one, the "reality" half of the claim is hearsay.
  if (
    evidenced.length > 0 &&
    p.recommendationRate !== null &&
    p.recommendationRate < 0.25 &&
    allAbsenceIds.length > 0
  ) {
    const anchor = evidenced[0]!;
    out.push({
      kind: "authority_visibility_gap",
      title: `AI visibility appears weaker than ${input.prospectName}'s documented market position`,
      explanation:
        `${anchor.label}. Yet across ${p.sampleSize} monitored responses, ` +
        `${input.prospectName} was recommended in ${pct(p.recommendationRate)}. ` +
        `The team appears underrepresented relative to its documented position.`,
      metrics: {
        recommendation_rate: p.recommendationRate,
        sample_size: p.sampleSize,
        verified_signals: evidenced.length,
      },
      signalIds: evidenced.map((s) => s.id),
      responseIds: allAbsenceIds,
      competitorCompanyIds: [],
      confidence: Math.min(confidence + 0.05, 0.95),
      severity: p.recommendationRate < 0.1 ? "high" : "medium",
      businessRelevance:
        "Buyers and sellers increasingly ask AI assistants for agent recommendations; a documented leader that assistants do not surface concedes those introductions.",
      suggestedAngle:
        "Lead with the verified authority signal, then the measured recommendation rate — let the contrast speak.",
      rankScore:
        0.5 + 0.3 * (1 - p.recommendationRate) + 0.1 * Math.min(evidenced.length, 3) / 3 + 0.1 * confidence,
      generatorVersion: FINDING_GENERATOR_VERSION,
    });
  }

  // 2. Competitor contrasts: a specific rival recommended clearly more often.
  for (const c of input.competitors) {
    if (c.companyId === p.companyId) continue;
    if (c.recommendationRate === null || p.recommendationRate === null) continue;
    const gap = c.recommendationRate - p.recommendationRate;
    if (gap < 0.15) continue;
    const ev = input.absence.find((a) => a.competitorCompanyId === c.companyId);
    if (!ev || ev.responseIds.length === 0) continue;
    out.push({
      kind: "competitor_contrast",
      title: `${c.name} is recommended more consistently than ${input.prospectName}`,
      explanation:
        `Across ${p.sampleSize} monitored responses, ${c.name} was recommended in ` +
        `${pct(c.recommendationRate)} while ${input.prospectName} was recommended in ` +
        `${pct(p.recommendationRate)}. In ${ev.responseIds.length} of those responses, ` +
        `${c.name} appeared where ${input.prospectName} was absent.`,
      metrics: {
        prospect_recommendation_rate: p.recommendationRate,
        competitor_recommendation_rate: c.recommendationRate,
        gap,
        sample_size: p.sampleSize,
      },
      signalIds: [],
      responseIds: ev.responseIds,
      competitorCompanyIds: [c.companyId],
      confidence,
      severity: gap >= 0.3 ? "high" : "medium",
      businessRelevance:
        "A named, verifiable competitor contrast is the easiest finding for a recipient to check themselves.",
      suggestedAngle:
        "Name the competitor once, factually; invite the prospect to run the same prompts.",
      rankScore: 0.45 + 0.4 * Math.min(gap, 0.6) / 0.6 + 0.15 * confidence,
      generatorVersion: FINDING_GENERATOR_VERSION,
    });
  }

  // 3. Absence: simply not present in most monitored responses.
  if (
    p.mentionRate !== null &&
    p.mentionRate < 0.2 &&
    input.prospectAbsentResponseIds.length > 0
  ) {
    out.push({
      kind: "absence",
      title: `${input.prospectName} is absent from most monitored AI responses`,
      explanation:
        `${input.prospectName} was mentioned in ${pct(p.mentionRate)} of ` +
        `${p.sampleSize} monitored responses — absent from the remaining ` +
        `${pct(1 - p.mentionRate)}.`,
      metrics: { mention_rate: p.mentionRate, sample_size: p.sampleSize },
      signalIds: [],
      responseIds: input.prospectAbsentResponseIds,
      competitorCompanyIds: [],
      confidence,
      severity: p.mentionRate < 0.05 ? "high" : "medium",
      businessRelevance:
        "Absence is the baseline problem: assistants cannot recommend a team they never surface.",
      suggestedAngle: "Use as supporting context for a sharper contrast finding, not as the lead.",
      rankScore: 0.3 + 0.3 * (1 - p.mentionRate) + 0.1 * confidence,
      generatorVersion: FINDING_GENERATOR_VERSION,
    });
  }

  // 4. Citation gap: rivals' sources are cited, the prospect's are not.
  const citedRivals = input.competitors.filter(
    (c) => c.citationScore !== null && c.citationScore > 0
  );
  if (
    (p.citationScore === null || p.citationScore === 0) &&
    citedRivals.length > 0
  ) {
    const rivalIds = citedRivals.map((c) => c.companyId);
    const ev = input.absence
      .filter((a) => rivalIds.includes(a.competitorCompanyId))
      .flatMap((a) => a.responseIds);
    if (ev.length > 0) {
      out.push({
        kind: "citation_gap",
        title: `AI responses cite sources for competitors but not for ${input.prospectName}`,
        explanation:
          `In the monitored responses, ${citedRivals.map((c) => c.name).join(", ")} ` +
          `appeared with source citations while no sources referencing ` +
          `${input.prospectName} were cited. Assistants appear to lack citable ` +
          `material about the team.`,
        metrics: {
          prospect_citation_score: p.citationScore ?? 0,
          competitors_with_citations: citedRivals.length,
          sample_size: p.sampleSize,
        },
        signalIds: [],
        responseIds: [...new Set(ev)],
        competitorCompanyIds: rivalIds,
        confidence: Math.max(0, confidence - 0.1),
        severity: "medium",
        businessRelevance:
          "Citations show which sources assistants trust; missing from all of them suggests an authority-content gap that is directly addressable.",
        suggestedAngle: "Frame as an opportunity (missing source coverage), not a defect.",
        rankScore: 0.35 + 0.1 * Math.min(citedRivals.length, 3) / 3 + 0.1 * confidence,
        generatorVersion: FINDING_GENERATOR_VERSION,
      });
    }
  }

  return out.sort(
    (a, b) => b.rankScore - a.rankScore || a.title.localeCompare(b.title)
  );
}
