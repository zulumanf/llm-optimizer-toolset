/**
 * The diagnosis layer (spec 042): WHY a prospect is underrepresented in AI
 * answers, as typed findings derived on read from data the platform already
 * trusts — current-revision mentions, classified citations, authority
 * signals, operator assessments, and the company registry.
 *
 * Honesty rules: absence-of-research diagnoses ("no review footprint
 * recorded") are about OUR evidence base, carry low confidence, and say so.
 * Sample-derived diagnoses scale confidence with the sample. Suggested
 * actions are a static, reviewable map — no LLM.
 */
import { sql } from "@/db/client";
import { PROMPT_NAMES_COMPANY } from "@/lib/scoring/prompt-echo";
import { classifySource } from "@/lib/sources/classify";
import { normalizeEntityName, normalizeDomain } from "@/lib/knowledge/normalize";
import type { AssessmentItem, AssessmentValue } from "@/lib/prospects/constants";
import type { AuthoritySignalKind } from "@/lib/prospects/constants";

export const DIAGNOSIS_VERSION = "prospect-diagnosis-v3";

const EVIDENCE_PROMPT_LIMIT = 5;
const CITED_DOMAIN_LIMIT = 5;
const COMPETITOR_CITATION_SHARE = 0.5;
const MIN_STABLE_SAMPLE = 6;
/** Confidence for diagnoses about missing research, not measured facts. */
const ABSENCE_OF_RESEARCH_CONFIDENCE = 0.4;

export interface Diagnosis {
  key: string;
  title: string;
  /** Measured facts only (OBSERVATION) — counts and records, no reading of
   * why. v2: the epistemics live in the data model, not prompt wording. */
  observations: string[];
  /** What the observations may mean (INFERENCE) — always hedged. */
  explanation: string;
  confidence: number;
  /** RECOMMENDATION. */
  suggestedAction: string;
  affectedPrompts: string[];
  competitors: string[];
  citedDomains: { domain: string; citations: number }[];
}

export interface DiagnosisReport {
  version: typeof DIAGNOSIS_VERSION;
  diagnoses: Diagnosis[];
  /** Null when no scored benchmark is linked — run-derived keys absent. */
  benchmarkRunId: string | null;
}

export interface PromptOutcome {
  promptText: string;
  tier: number | null;
  category: string | null;
  responses: number;
  mentioned: number;
  recommended: number;
}

export interface DiagnoseInputs {
  prospectDomain: string | null;
  prospectCompanyName: string | null;
  prompts: PromptOutcome[];
  citedDomains: { domain: string; citations: number }[];
  competitorCompanies: { name: string; domain: string | null }[];
  signalKinds: AuthoritySignalKind[];
  assessments: Partial<Record<AssessmentItem, AssessmentValue>>;
}

const SUGGESTED_ACTIONS: Record<string, string> = {
  no_organic_visibility:
    "Build presence on the third-party surfaces the answers cite (see source targets) and publish neighborhood-specific proof of work.",
  mentioned_never_recommended:
    "Add differentiation and proof (rankings, verified sales, reviews) to the pages models retrieve — being known is not being endorsed.",
  missing_from_cited_sources:
    "The cited domains are clues to the public sources visible in this sample. Improving accurate, consistent representation across relevant third-party profiles (portals, directories, local press) and building authoritative on-site content may improve how AI systems describe you over time. Competitor-owned pages among the citations are context, not targets.",
  competitors_dominate_sources:
    "Strengthen the neutral third-party surfaces (directories, local press) the answers also cite — competitor-owned pages are not available surfaces.",
  missing_from_high_intent_prompts:
    "Create content matching the questions buyers and sellers actually ask (best listing agent, who should sell my X) — you only appear on general ones.",
  entity_ambiguity:
    "Standardize the entity name across web properties and disambiguate from the colliding brand before measurement can be trusted.",
  unstable_sample:
    "Re-run the benchmark with more repetitions before drawing conclusions — the sample is too small to be stable.",
  website_not_indexable:
    "Fix indexability first: nothing downstream (content, structured data) matters while crawlers cannot read the site.",
  weak_structured_data:
    "Add consistent structured data (organization, person, local business) so entity extraction stops guessing.",
  no_review_evidence:
    "Research the prospect's review footprint (Google, Zillow) and record it — review presence feeds both authority and retrieval.",
  no_media_evidence:
    "Research local press coverage and record it — media mentions are a top citation source for agent recommendations.",
};

function sampleConfidence(n: number): number {
  return Math.min(0.95, 0.4 + Math.log10(Math.max(1, n)) * 0.32);
}

export function deriveDiagnoses(inputs: DiagnoseInputs): Diagnosis[] {
  const out: Diagnosis[] = [];
  const add = (
    key: string,
    title: string,
    observations: string[],
    explanation: string,
    confidence: number,
    extras: Partial<Pick<Diagnosis, "affectedPrompts" | "competitors" | "citedDomains">> = {}
  ) =>
    out.push({
      key,
      title,
      observations,
      explanation,
      confidence,
      suggestedAction: SUGGESTED_ACTIONS[key] ?? "",
      affectedPrompts: extras.affectedPrompts ?? [],
      competitors: extras.competitors ?? [],
      citedDomains: extras.citedDomains ?? [],
    });

  const totalResponses = inputs.prompts.reduce((a, p) => a + p.responses, 0);
  const totalMentioned = inputs.prompts.reduce((a, p) => a + p.mentioned, 0);
  const totalRecommended = inputs.prompts.reduce((a, p) => a + p.recommended, 0);
  const totalCitations = inputs.citedDomains.reduce((a, d) => a + d.citations, 0);

  if (totalResponses > 0) {
    if (totalMentioned === 0) {
      add(
        "no_organic_visibility",
        "Absent from every organic answer",
        [`You appeared in 0 of ${totalResponses} answers to questions that didn't name you.`],
        "Nothing the models retrieve appears to surface you — the sources behind these answers may not carry your name at all.",
        sampleConfidence(totalResponses),
        {
          affectedPrompts: inputs.prompts
            .slice(0, EVIDENCE_PROMPT_LIMIT)
            .map((p) => p.promptText),
        }
      );
    } else if (totalRecommended === 0) {
      add(
        "mentioned_never_recommended",
        "Mentioned but never recommended",
        [
          `You were mentioned in ${totalMentioned} of ${totalResponses} answers.`,
          "You were recommended in none.",
        ],
        "The answers describe you without endorsing you — the retrieved sources may lack the proof (rankings, verified sales, reviews) endorsements lean on.",
        sampleConfidence(totalResponses),
        {
          affectedPrompts: inputs.prompts
            .filter((p) => p.mentioned > 0 && p.recommended === 0)
            .slice(0, EVIDENCE_PROMPT_LIMIT)
            .map((p) => p.promptText),
        }
      );
    }

    // High-intent absence — only meaningful when visible somewhere else.
    const highIntent = inputs.prompts.filter(
      (p) => p.tier === 1 || p.tier === 2 || p.category === "recommendation"
    );
    const absentHighIntent = highIntent.filter((p) => p.responses > 0 && p.mentioned === 0);
    if (
      totalMentioned > 0 &&
      highIntent.length > 0 &&
      absentHighIntent.length === highIntent.length
    ) {
      add(
        "missing_from_high_intent_prompts",
        "Missing exactly where it counts",
        [
          `You appeared on general questions but in 0 of the ${highIntent.length} high-intent questions buyers and sellers ask when choosing.`,
        ],
        "Your visibility may not extend to decision-stage content — the questions that convert are answered from sources that don't include you.",
        sampleConfidence(highIntent.reduce((a, p) => a + p.responses, 0)),
        {
          affectedPrompts: absentHighIntent
            .slice(0, EVIDENCE_PROMPT_LIMIT)
            .map((p) => p.promptText),
        }
      );
    }

    if (totalResponses < MIN_STABLE_SAMPLE) {
      add(
        "unstable_sample",
        "Sample too small to trust",
        [`${totalResponses} organic responses captured — the stability floor is ${MIN_STABLE_SAMPLE}.`],
        "No conclusion above this line should be trusted until the sample grows.",
        1.0
      );
    }
  }

  if (totalCitations > 0) {
    const ownDomain = inputs.prospectDomain ? normalizeDomain(inputs.prospectDomain) : null;
    const ownCitations = ownDomain
      ? inputs.citedDomains
          .filter((d) => normalizeDomain(d.domain) === ownDomain)
          .reduce((a, d) => a + d.citations, 0)
      : 0;
    const top = [...inputs.citedDomains]
      .sort((a, b) => b.citations - a.citations)
      .slice(0, CITED_DOMAIN_LIMIT);
    if (ownCitations === 0) {
      add(
        "missing_from_cited_sources",
        "Not in the retrieval path",
        [`The answers cited their sources ${totalCitations} times — never your own site.`],
        "The models are building these answers from other people's pages; presence on the cited surfaces may matter more than your own site here.",
        sampleConfidence(totalCitations),
        { citedDomains: top }
      );
    }

    const competitorDomains = inputs.competitorCompanies
      .filter((c) => c.domain)
      .map((c) => ({ name: c.name, domain: normalizeDomain(c.domain!) }));
    const competitorCitations = inputs.citedDomains.reduce((acc, d) => {
      const normalized = normalizeDomain(d.domain);
      const classification = classifySource(d.domain, {
        subjectDomain: inputs.prospectDomain ? normalizeDomain(inputs.prospectDomain) : null,
        competitorDomains: competitorDomains.map((c) => c.domain),
      });
      return classification.relationship === "competitor"
        ? acc + d.citations
        : normalized && competitorDomains.some((c) => c.domain === normalized)
          ? acc + d.citations
          : acc;
    }, 0);
    if (competitorCitations / totalCitations >= COMPETITOR_CITATION_SHARE) {
      add(
        "competitors_dominate_sources",
        "Competitors control the cited sources",
        [`${competitorCitations} of ${totalCitations} citations resolve to tracked competitors' own domains.`],
        "The retrieval path may be running through competitor-controlled pages — their framing is the raw material for these answers.",
        sampleConfidence(totalCitations),
        {
          competitors: competitorDomains.map((c) => c.name),
          citedDomains: top,
        }
      );
    }
  }

  if (inputs.prospectCompanyName) {
    const normalized = normalizeEntityName(inputs.prospectCompanyName);
    const colliding = inputs.competitorCompanies.filter(
      (c) => normalizeEntityName(c.name) === normalized
    );
    if (colliding.length > 0) {
      add(
        "entity_ambiguity",
        "Name collides with another tracked brand",
        [
          `"${inputs.prospectCompanyName}" normalizes identically to ${colliding.map((c) => `"${c.name}"`).join(", ")}.`,
        ],
        "Mentions may be misattributed in either direction — measurement cannot be trusted until the entities are disambiguated.",
        0.9,
        { competitors: colliding.map((c) => c.name) }
      );
    }
  }

  if (inputs.assessments.website_indexable === "no") {
    add(
      "website_not_indexable",
      "Website is not indexable",
      ["The operator assessment records the site as not indexable."],
      "Retrieval cannot surface what crawlers cannot read — nothing downstream matters until this is fixed.",
      1.0
    );
  }
  if (inputs.assessments.structured_data_consistent === "no") {
    add(
      "weak_structured_data",
      "Structured data inconsistent or missing",
      ["The operator assessment records inconsistent structured data."],
      "Entity extraction is left guessing — models may fail to connect your pages to your name.",
      1.0
    );
  }

  if (!inputs.signalKinds.includes("review_footprint")) {
    add(
      "no_review_evidence",
      "No review footprint recorded",
      ["No review-footprint signal has been recorded for this prospect."],
      "This is a gap in our research, not a measured absence of reviews.",
      ABSENCE_OF_RESEARCH_CONFIDENCE
    );
  }
  if (!inputs.signalKinds.includes("press_mention")) {
    add(
      "no_media_evidence",
      "No media coverage recorded",
      ["No press-mention signal has been recorded for this prospect."],
      "This is a gap in our research, not a measured absence of coverage.",
      ABSENCE_OF_RESEARCH_CONFIDENCE
    );
  }

  return out.sort((a, b) => b.confidence - a.confidence);
}

/** Assemble inputs from the prospect's latest linked benchmark and records. */
export async function diagnoseProspect(prospectId: string): Promise<DiagnosisReport> {
  const [prospect] = await sql`
    select p.website, p.company_id, c.name as company_name, c.domain as company_domain
    from prospects p
    left join companies c on c.id = p.company_id
    where p.id = ${prospectId} and p.archived_at is null
  `;
  if (!prospect) return { version: DIAGNOSIS_VERSION, diagnoses: [], benchmarkRunId: null };

  const [link] = await sql`
    select b.run_id from prospect_benchmarks b
    where b.prospect_id = ${prospectId}
    order by b.created_at desc limit 1
  `;
  const runId = (link?.runId as string | undefined) ?? null;
  const companyId = prospect.companyId as string | null;

  let prompts: PromptOutcome[] = [];
  let citedDomains: { domain: string; citations: number }[] = [];
  if (runId && companyId) {
    // Per-prompt outcomes over ORGANIC responses (prompt did not name the
    // company) — the same echo exclusion every other measurement uses.
    const rows = await sql`
      with fp as (
        select p."promptId" as prompt_id, p.category, p.tier,
          coalesce(p."isHoldout", false) as is_holdout
        from runs r2
        join prompt_set_versions v on v.id = r2.prompt_set_version_id,
        jsonb_to_recordset(v.frozen_prompts)
          as p("promptId" uuid, category text, tier int, "isHoldout" boolean)
        where r2.id = ${runId}
      )
      select r.prompt_text, fp.tier, fp.category,
        count(*)::int as responses,
        count(*) filter (where coalesce(m.mentioned, false))::int as mentioned,
        count(*) filter (where coalesce(m.recommended, false))::int as recommended
      from responses r
      join fp on fp.prompt_id = r.prompt_id
      left join mentions m on m.response_id = r.id and m.company_id = ${companyId}
        and not exists (
          select 1 from mentions newer
          where newer.response_id = m.response_id
            and newer.company_id = m.company_id and newer.revision > m.revision
        )
      where r.run_id = ${runId} and r.error is null and not fp.is_holdout
        and not coalesce(
          (select ${PROMPT_NAMES_COMPANY} from companies c where c.id = ${companyId}),
          false
        )
      group by r.prompt_text, fp.tier, fp.category
      order by r.prompt_text
    `;
    prompts = rows.map((r) => ({
      promptText: r.promptText as string,
      tier: r.tier === null || r.tier === undefined ? null : Number(r.tier),
      category: (r.category as string | null) ?? null,
      responses: Number(r.responses),
      mentioned: Number(r.mentioned),
      recommended: Number(r.recommended),
    }));
    const domains = await sql`
      select c.domain, count(*)::int as citations
      from response_citations c
      join responses r on r.id = c.response_id
      where r.run_id = ${runId}
      group by c.domain
    `;
    citedDomains = domains.map((d) => ({
      domain: d.domain as string,
      citations: Number(d.citations),
    }));
  }

  const competitors = await sql`
    select name, domain from companies
    where archived_at is null and (${companyId}::uuid is null or id != ${companyId})
  `;
  const signals = await sql`
    select distinct kind from prospect_authority_signals where prospect_id = ${prospectId}
  `;
  const assessmentRows = await sql`
    select item, value from prospect_assessments where prospect_id = ${prospectId}
  `;

  const diagnoses = deriveDiagnoses({
    prospectDomain:
      (prospect.website as string | null) ?? (prospect.companyDomain as string | null) ?? null,
    prospectCompanyName: (prospect.companyName as string | null) ?? null,
    prompts,
    citedDomains,
    competitorCompanies: competitors.map((c) => ({
      name: c.name as string,
      domain: (c.domain as string | null) ?? null,
    })),
    signalKinds: signals.map((s) => s.kind as AuthoritySignalKind),
    assessments: Object.fromEntries(
      assessmentRows.map((r) => [r.item as string, r.value as AssessmentValue])
    ) as Partial<Record<AssessmentItem, AssessmentValue>>,
  });
  return { version: DIAGNOSIS_VERSION, diagnoses, benchmarkRunId: runId };
}
