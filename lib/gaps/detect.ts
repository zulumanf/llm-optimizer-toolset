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
export const DETECTOR_VERSION = "gap-detector-v1";

export interface PromptOutcome {
  promptId: string;
  category: string; // recommendation | comparison | how-to | branded | problem
  responses: number;
  subjectMentioned: number;
  subjectRecommended: number;
  subjectCited: number;
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
}

export interface DomainCitation {
  domain: string;
  citations: number;
  ownedBySubject: boolean;
}

export interface GapFinding {
  gapType:
    | "entity"
    | "branded_recognition"
    | "recommendation"
    | "citation"
    | "category_share"
    | "source_target";
  promptCategory: string | null;
  finding: string;
  detail: Record<string, unknown>;
  severity: number; // 0..1
  opportunityScore: number; // 0..100
}

// Commercial value per prompt category (documented assumption: high-intent
// recommendation/problem prompts convert; branded protects; how-to educates)
const CATEGORY_VALUE: Record<string, number> = {
  recommendation: 1.0,
  problem: 0.9,
  comparison: 0.8,
  branded: 0.6,
  "how-to": 0.4,
};

// Execution likelihood / attainability / speed per gap type (documented
// assumptions; deterministic so scores are reproducible and comparable)
const GAP_FACTORS: Record<GapFinding["gapType"], { execution: number; attainability: number; speed: number }> = {
  branded_recognition: { execution: 0.9, attainability: 0.9, speed: 0.8 },
  entity: { execution: 0.8, attainability: 0.7, speed: 0.6 },
  citation: { execution: 0.7, attainability: 0.6, speed: 0.5 },
  source_target: { execution: 0.6, attainability: 0.5, speed: 0.4 },
  recommendation: { execution: 0.6, attainability: 0.5, speed: 0.4 },
  category_share: { execution: 0.5, attainability: 0.4, speed: 0.4 },
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

export function detectGaps(input: {
  subjectName: string;
  subjectDomain: string | null;
  prompts: PromptOutcome[];
  companies: CompanyOutcome[];
  domains: DomainCitation[];
}): GapFinding[] {
  const { subjectName, prompts, companies, domains } = input;
  const findings: GapFinding[] = [];
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
    });
  }

  // 3. Recommendation gap: mentioned but never endorsed
  const subject = companies.find((c) => c.isSubject);
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
      detail: { targets: targets as unknown as Record<string, unknown>[] },
      severity: 0.6,
      opportunityScore: score("source_target", 0.6, 0.8),
    });
  }

  return findings.sort((a, b) => b.opportunityScore - a.opportunityScore);
}
