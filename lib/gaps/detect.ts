/**
 * Deterministic gap detectors (spec 009, docs/15). Pure functions over a
 * scored run's structured data — no LLM in v1 (same heuristic-first
 * discipline as the parser, DECISIONS.md): a day-zero client's gaps are
 * fully computable from what the answers did and didn't contain. An LLM
 * competitor-evidence enrichment stage lands as a later detector_version.
 *
 * Opportunity score (docs/15 blueprint, deterministic weights):
 *   30% commercial value of the category
 * + 25% gap severity
 * + 20% execution likelihood
 * + 15% competitive attainability
 * + 10% expected speed
 */
import { CATEGORY_INTENT_VALUE } from "@/lib/scoring/intent";

// v1.1 (spec 064): identical severity/opportunity math — scores are
// byte-identical to v1 — plus epistemics: classification, confidence, and
// typed evidence refs on every finding.
// v1.2 (spec 087): adds the displacement detector (who was recommended when
// the subject was absent, lib/competitors/displacement.ts). Existing finding
// types and their scores are unchanged.
export const DETECTOR_VERSION = "gap-detector-v1.2";

/** The platform's epistemic labels (docs/12), now emitted as data.
 * working_hypothesis is reserved for the future LLM enrichment detector. */
export type FindingClassification =
  | "observation"
  | "supported_finding"
  | "working_hypothesis";

/** Typed pointer the service resolves into an `evidence` registry row. */
export interface EvidenceRef {
  kind: "score" | "response";
  refId: string;
  note: string;
}

/**
 * Deterministic detectors are certain of their arithmetic; what varies is
 * how much sample stands behind it. NOTE: this banded curve is the gap
 * detector's, not the platform's — lib/prospects/diagnose.ts and
 * lib/prospects/findings.ts use a logarithmic curve. Unifying them is a
 * deliberate scoring-version decision (cleanup backlog 2026-08-18), not a
 * drive-by edit: the numbers reach prospect-facing surfaces.
 */
export function sampleConfidence(n: number): number {
  if (n >= 30) return 0.9;
  if (n >= 10) return 0.7;
  return 0.5;
}

/** Flatten candidate id lists into a deduped, capped evidence sample. */
function sampleIds(lists: (readonly string[] | undefined)[], cap = 5): string[] {
  const seen = new Set<string>();
  for (const list of lists) {
    for (const id of list ?? []) {
      seen.add(id);
      if (seen.size >= cap) return [...seen];
    }
  }
  return [...seen];
}

export interface PromptOutcome {
  promptId: string;
  category: string; // recommendation | comparison | how-to | branded | problem
  responses: number;
  subjectMentioned: number;
  subjectRecommended: number;
  subjectCited: number;
  /** Sampled response ids for this prompt (spec 064) — immutable rows the
   * finding's counts were derived from. Optional: v1 callers omit it. */
  sampleResponseIds?: string[];
}

export interface CompanyOutcome {
  companyId: string;
  name: string;
  isSubject: boolean;
  /** Over every response in the run, including prompts that named the company. */
  mentionRate: number;
  recommendationRate: number;
  /**
   * Over responses to prompts that did NOT name this company — the only rate
   * that measures visibility rather than echo.
   *
   * A prompt like "Who are the best SERHANT agents in Jersey City?" will
   * almost always produce a SERHANT mention, because we put the word in the
   * question. Counting that as visibility inflates exactly the companies a
   * brand-probe run was designed to interrogate, and would let a client be
   * told they are "mentioned 25% of the time" on the strength of questions we
   * asked about them by name.
   *
   * Null when the run contains no such prompt for this company — "not
   * measured", never zero, because zero here would read as invisibility.
   */
  organicMentionRate: number | null;
  organicRecommendationRate: number | null;
  organicResponses: number;
  /** Stored score-row ids behind the company's all-provider rates
   * (spec 064). Optional: v1 callers omit it. */
  scoreIds?: { mentionRate?: string; recommendationRate?: string };
}

export interface DomainCitation {
  domain: string;
  citations: number;
  ownedBySubject: boolean;
  /** Sampled response ids whose payloads cited this domain (spec 064). */
  sampleResponseIds?: string[];
}

export interface GapFinding {
  gapType:
    | "entity"
    | "branded_recognition"
    | "recommendation"
    | "citation"
    | "category_share"
    | "source_target"
    | "displacement";
  promptCategory: string | null;
  finding: string;
  detail: Record<string, unknown>;
  severity: number; // 0..1
  opportunityScore: number; // 0..100
  classification: FindingClassification;
  confidence: number; // sampleConfidence over the finding's own denominator
  evidence: EvidenceRef[];
}

// Commercial value per prompt category now lives in lib/scoring/intent.ts —
// one intent-value model, shared with valuable visibility (spec 038). The
// numbers are unchanged; gap scores are byte-identical.
const CATEGORY_VALUE = CATEGORY_INTENT_VALUE;

// Execution likelihood / attainability / speed per gap type (documented
// assumptions; deterministic so scores are reproducible and comparable)
const GAP_FACTORS: Record<GapFinding["gapType"], { execution: number; attainability: number; speed: number }> = {
  branded_recognition: { execution: 0.9, attainability: 0.9, speed: 0.8 },
  entity: { execution: 0.8, attainability: 0.7, speed: 0.6 },
  citation: { execution: 0.7, attainability: 0.6, speed: 0.5 },
  source_target: { execution: 0.6, attainability: 0.5, speed: 0.4 },
  recommendation: { execution: 0.6, attainability: 0.5, speed: 0.4 },
  category_share: { execution: 0.5, attainability: 0.4, speed: 0.4 },
  // Displacement is worked through the sources/authority behind the winning
  // rival — same execution profile as chasing a recommendation.
  displacement: { execution: 0.6, attainability: 0.5, speed: 0.4 },
};

function score(
  gapType: GapFinding["gapType"],
  severity: number,
  categoryValue: number
): number {
  const factors = GAP_FACTORS[gapType];
  return (
    100 *
    (0.3 * categoryValue +
      0.25 * severity +
      0.2 * factors.execution +
      0.15 * factors.attainability +
      0.1 * factors.speed)
  );
}

const UNBRANDED = new Set(["recommendation", "problem", "how-to"]);

/** Compact displacement summary (spec 087) the service derives from
 * lib/competitors/displacement.ts. Meaningful rivals only — the engine has
 * already applied MIN_MEANINGFUL_DISPLACEMENTS and the echo rule. */
export interface DisplacementGapInput {
  validResponses: number;
  absentResponses: number;
  rivals: {
    name: string;
    displacedResponses: number;
    topClusters: string[];
    topDomains: { domain: string; count: number; sourceType: string | null }[];
  }[];
  sampleResponseIds?: string[];
}

/** Priority banding over the shared opportunity score — vocabulary for the
 * work queue, not a new score. Thresholds are named so the mapping to task
 * priorities (createTaskFromFinding) stays inspectable. */
export const PRIORITY_BANDS = {
  doNow: 70,
  doNext: 50,
  test: 30,
} as const;
export type PriorityBand = "do_now" | "do_next" | "test" | "low_priority";

export function priorityBand(opportunityScore: number): PriorityBand {
  if (opportunityScore >= PRIORITY_BANDS.doNow) return "do_now";
  if (opportunityScore >= PRIORITY_BANDS.doNext) return "do_next";
  if (opportunityScore >= PRIORITY_BANDS.test) return "test";
  return "low_priority";
}

export function detectGaps(input: {
  subjectName: string;
  subjectDomain: string | null;
  prompts: PromptOutcome[];
  companies: CompanyOutcome[];
  domains: DomainCitation[];
  /** Optional (spec 087): callers without displacement data get the v1.1
   * finding set unchanged. */
  displacement?: DisplacementGapInput;
}): GapFinding[] {
  const { subjectName, prompts, companies, domains, displacement } = input;
  const findings: GapFinding[] = [];
  const subject = companies.find((c) => c.isSubject);
  const competitors = companies.filter((c) => !c.isSubject);
  // Ranked on ORGANIC rate: a competitor that only appears because a prompt
  // named it is not the one out-competing the client for attention. Those
  // with no organic sample are excluded rather than treated as zero.
  const topCompetitor = [...competitors]
    .filter((c) => c.organicMentionRate !== null && c.organicResponses > 0)
    .sort((a, b) => (b.organicMentionRate ?? 0) - (a.organicMentionRate ?? 0))[0];
  const topCompetitorRate = topCompetitor?.organicMentionRate ?? 0;

  // 1. Entity gap: absent from unbranded prompts while a competitor shows up
  const unbranded = prompts.filter((p) => UNBRANDED.has(p.category));
  const unbrandedResponses = unbranded.reduce((a, p) => a + p.responses, 0);
  const unbrandedMentions = unbranded.reduce((a, p) => a + p.subjectMentioned, 0);
  if (unbrandedResponses > 0 && topCompetitor) {
    const rate = unbrandedMentions / unbrandedResponses;
    if (rate < 0.1 && topCompetitorRate >= 0.3) {
      const severity = 1 - rate / 0.1;
      findings.push({
        gapType: "entity",
        promptCategory: null,
        finding: `${subjectName} appears in ${(rate * 100).toFixed(0)}% of unbranded answers while ${topCompetitor.name} appears in ${(topCompetitorRate * 100).toFixed(0)}% — the models' retrieval sources don't surface ${subjectName} for the category at all.`,
        detail: {
          unbrandedMentionRate: rate,
          topCompetitor: topCompetitor.name,
          topCompetitorMentionRate: topCompetitorRate,
        },
        severity,
        opportunityScore: score("entity", severity, 1.0),
        classification: "supported_finding",
        confidence: sampleConfidence(unbrandedResponses),
        evidence: [
          ...(subject?.scoreIds?.mentionRate
            ? [{
                kind: "score" as const,
                refId: subject.scoreIds.mentionRate,
                note: `${subjectName}'s stored all-provider mention rate; the finding's unbranded rate is re-derived from the run's responses.`,
              }]
            : []),
          ...(topCompetitor.scoreIds?.mentionRate
            ? [{
                kind: "score" as const,
                refId: topCompetitor.scoreIds.mentionRate,
                note: `${topCompetitor.name}'s stored all-provider mention rate, the comparison side of the gap.`,
              }]
            : []),
          ...sampleIds(unbranded.map((p) => p.sampleResponseIds)).map((id) => ({
            kind: "response" as const,
            refId: id,
            note: `Sampled unbranded answer counted in the ${unbrandedResponses}-response denominator.`,
          })),
        ],
      });
    }
  }

  // 2. Branded recognition gap: asked directly, the model doesn't know it
  const branded = prompts.filter((p) => p.category === "branded");
  const brandedResponses = branded.reduce((a, p) => a + p.responses, 0);
  const brandedMentions = branded.reduce((a, p) => a + p.subjectMentioned, 0);
  if (brandedResponses > 0 && brandedMentions / brandedResponses < 0.5) {
    const rate = brandedMentions / brandedResponses;
    const severity = 1 - rate / 0.5;
    findings.push({
      gapType: "branded_recognition",
      promptCategory: "branded",
      finding: `Asked directly about ${subjectName}, the model discussed it in only ${(rate * 100).toFixed(0)}% of answers — no reliable entity recognition (name-collision or missing public record).`,
      detail: { brandedMentionRate: rate, brandedResponses },
      severity,
      opportunityScore: score("branded_recognition", severity, CATEGORY_VALUE.branded ?? 0.6),
      classification: "supported_finding",
      confidence: sampleConfidence(brandedResponses),
      evidence: sampleIds(branded.map((p) => p.sampleResponseIds)).map((id) => ({
        kind: "response" as const,
        refId: id,
        note: `Sampled branded-prompt answer counted in the ${brandedResponses}-response denominator.`,
      })),
    });
  }

  // 3. Recommendation gap: mentioned but never endorsed
  // Organic only. "Mentioned but never recommended" is a real and useful
  // finding — but only when something other than our own question put the
  // name in the answer.
  const subjectOrganic = subject?.organicMentionRate ?? null;
  if (
    subject &&
    subjectOrganic !== null &&
    subjectOrganic > 0 &&
    (subject.organicRecommendationRate ?? 0) === 0
  ) {
    const severity = Math.min(1, subjectOrganic * 2);
    findings.push({
      gapType: "recommendation",
      promptCategory: null,
      finding: `${subjectName} gets mentioned (${(subjectOrganic * 100).toFixed(0)}% of answers to questions that did not name it) but never recommended — answers describe it without endorsing it (weak proof/differentiation signals).`,
      detail: {
        organicMentionRate: subjectOrganic,
        organicRecommendationRate: subject.organicRecommendationRate,
        organicResponses: subject.organicResponses,
      },
      severity,
      opportunityScore: score("recommendation", severity, 0.9),
      classification: "supported_finding",
      confidence: sampleConfidence(subject.organicResponses),
      evidence: [
        ...(subject.scoreIds?.mentionRate
          ? [{
              kind: "score" as const,
              refId: subject.scoreIds.mentionRate,
              note: `${subjectName}'s stored all-provider mention rate; the organic split is re-derived from the run.`,
            }]
          : []),
        ...(subject.scoreIds?.recommendationRate
          ? [{
              kind: "score" as const,
              refId: subject.scoreIds.recommendationRate,
              note: `${subjectName}'s stored all-provider recommendation rate — the endorsement side of the gap.`,
            }]
          : []),
      ],
    });
  }

  // 4. Citation gap: subject's own domain never cited while others are
  const anyCitations = domains.reduce((a, d) => a + d.citations, 0);
  const ownCitations = domains
    .filter((d) => d.ownedBySubject)
    .reduce((a, d) => a + d.citations, 0);
  if (anyCitations > 0 && ownCitations === 0) {
    findings.push({
      gapType: "citation",
      promptCategory: null,
      finding: `Answers cited ${anyCitations} sources this run — none from ${subjectName}'s own domain. Owned content isn't in the retrieval path.`,
      detail: { totalCitations: anyCitations, ownCitations: 0 },
      severity: 0.8,
      opportunityScore: score("citation", 0.8, 0.7),
      // A counted fact about the run — zero own-domain citations — not an
      // interpretation: an observation.
      classification: "observation",
      confidence: sampleConfidence(anyCitations),
      evidence: sampleIds(domains.map((d) => d.sampleResponseIds)).map((id) => ({
        kind: "response" as const,
        refId: id,
        note: `Sampled answer whose payload carried citations counted in the ${anyCitations}-citation total.`,
      })),
    });
  }

  // 5. Category share gaps: per unbranded category where subject trails badly
  for (const category of [...new Set(unbranded.map((p) => p.category))]) {
    const inCategory = unbranded.filter((p) => p.category === category);
    const responses = inCategory.reduce((a, p) => a + p.responses, 0);
    const mentions = inCategory.reduce((a, p) => a + p.subjectMentioned, 0);
    if (responses === 0 || !topCompetitor) continue;
    const rate = mentions / responses;
    if (rate < 0.2 && topCompetitorRate - rate >= 0.3) {
      const severity = Math.min(1, (topCompetitorRate - rate) / 0.7);
      findings.push({
        gapType: "category_share",
        promptCategory: category,
        finding: `"${category}" prompts: ${subjectName} at ${(rate * 100).toFixed(0)}% vs ${topCompetitor.name} at ${(topCompetitorRate * 100).toFixed(0)}% — the category conversation happens without ${subjectName}.`,
        detail: { category, subjectRate: rate, leader: topCompetitor.name },
        severity,
        opportunityScore: score("category_share", severity, CATEGORY_VALUE[category] ?? 0.5),
        classification: "supported_finding",
        confidence: sampleConfidence(responses),
        evidence: [
          ...(topCompetitor.scoreIds?.mentionRate
            ? [{
                kind: "score" as const,
                refId: topCompetitor.scoreIds.mentionRate,
                note: `${topCompetitor.name}'s stored all-provider mention rate, the category leader side.`,
              }]
            : []),
          ...sampleIds(inCategory.map((p) => p.sampleResponseIds)).map((id) => ({
            kind: "response" as const,
            refId: id,
            note: `Sampled "${category}" answer counted in the ${responses}-response denominator.`,
          })),
        ],
      });
    }
  }

  // 6. Source targets: third-party domains the answers actually cite —
  // the authority surfaces worth getting onto (top 5 by citations)
  const targets = domains
    .filter((d) => !d.ownedBySubject)
    .sort((a, b) => b.citations - a.citations)
    .slice(0, 5);
  if (targets.length > 0) {
    findings.push({
      gapType: "source_target",
      promptCategory: null,
      finding: `The retrieval path runs through: ${targets.map((t) => `${t.domain} (${t.citations}×)`).join(", ")} — presence on these surfaces feeds future answers.`,
      detail: {
        targets: targets.map((t) => ({
          domain: t.domain,
          citations: t.citations,
          ownedBySubject: t.ownedBySubject,
        })) as unknown as Record<string, unknown>[],
      },
      severity: 0.6,
      opportunityScore: score("source_target", 0.6, 0.8),
      // Which domains the answers cited is directly counted: an observation.
      classification: "observation",
      confidence: sampleConfidence(targets.reduce((a, t) => a + t.citations, 0)),
      evidence: sampleIds(targets.map((t) => t.sampleResponseIds)).map((id) => ({
        kind: "response" as const,
        refId: id,
        note: "Sampled answer citing one of the top third-party domains listed in the finding.",
      })),
    });
  }

  // 7. Displacement (spec 087): the subject was absent and named rivals
  // repeatedly collected the recommendation. The engine has already enforced
  // MIN_ABSENT_SAMPLE upstream — a caller passing a summary asserts
  // sufficiency; rivals arrive meaningful-only and echo-excluded.
  if (
    displacement &&
    displacement.absentResponses > 0 &&
    displacement.rivals.length > 0
  ) {
    const top = displacement.rivals[0]!;
    // A rival taking half the subject-absent answers saturates severity.
    const severity = Math.min(
      1,
      (top.displacedResponses / displacement.absentResponses) * 2
    );
    const rivalLine = displacement.rivals
      .slice(0, 4)
      .map((r) => `${r.name} (${r.displacedResponses}×)`)
      .join(", ");
    const clusterNote =
      top.topClusters.length > 0
        ? ` ${top.name} collects them mostly in: ${top.topClusters.slice(0, 3).join(", ")}.`
        : "";
    findings.push({
      gapType: "displacement",
      promptCategory: null,
      finding: `In ${displacement.absentResponses} of ${displacement.validResponses} valid answers ${subjectName} was absent — and the recommendation went to ${rivalLine} instead.${clusterNote}`,
      detail: {
        validResponses: displacement.validResponses,
        absentResponses: displacement.absentResponses,
        rivals: displacement.rivals as unknown as Record<string, unknown>[],
      },
      severity,
      // Losing the recommendation moment itself: full commercial value.
      opportunityScore: score("displacement", severity, 1.0),
      // Counted recommendation events, not an interpretation.
      classification: "observation",
      confidence: sampleConfidence(displacement.absentResponses),
      evidence: (displacement.sampleResponseIds ?? []).slice(0, 5).map((id) => ({
        kind: "response" as const,
        refId: id,
        note: "Sampled subject-absent answer whose recommendation went to a rival counted in the finding.",
      })),
    });
  }

  return findings.sort((a, b) => b.opportunityScore - a.opportunityScore);
}
