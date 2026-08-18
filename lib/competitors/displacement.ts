/**
 * Recommendation displacement (spec 087): when the subject is absent from an
 * answer, who was recommended instead — by rival, provider, prompt cluster,
 * and real-estate dimension, backed by which cited sources.
 *
 * Derived on read from the immutable ledgers, never stored (the coverage
 * precedent): re-parses and review corrections are always reflected. Counts
 * travel with every rate. These are observed recommendation events, not a
 * deterministic "ranking" — language stays associative.
 *
 * The compute core is pure (known-answer tests, docs/09); only
 * runDisplacement touches the database, via lazy imports so the pure part
 * stays importable without env.
 */
import type { FrozenPrompt } from "@/lib/prompts/types";
import type { RunMentionRow, ValidResponseRow } from "@/db/displacement";
import { clusterPrompts } from "@/lib/prompts/cluster";
import { intentBand } from "@/lib/scoring/coverage";

export const DISPLACEMENT_VERSION = "recommendation-displacement-v1";

/** Below this many absent observations, no displacement claim is made
 * (mirrors MIN_STABLE_SAMPLE, lib/prospects/diagnose.ts). */
export const MIN_ABSENT_SAMPLE = 6;
/** A rival recommended once in the subject's absence is an anecdote, not a
 * displacement pattern. */
export const MIN_MEANINGFUL_DISPLACEMENTS = 2;
/** A domain cited once alongside a rival is not a source association. */
export const MIN_DOMAIN_ASSOCIATIONS = 2;

export const DISPLACEMENT_DIMENSIONS = [
  "category",
  "intent",
  "audience",
  "price_tier",
  "neighborhood",
  "property_type",
  "building",
] as const;
export type DisplacementDimension = (typeof DISPLACEMENT_DIMENSIONS)[number];

export interface SegmentCount {
  segment: string;
  count: number;
}

export interface RivalDisplacement {
  companyId: string;
  name: string;
  /** Distinct absent responses where this rival was recommended (echo-excluded). */
  displacedResponses: number;
  /** displacedResponses / absentResponses; null when absent sample is 0. */
  shareOfAbsent: number | null;
  /** Meets MIN_MEANINGFUL_DISPLACEMENTS. Sub-threshold rivals are reported
   * but must never be presented as a displacement pattern. */
  meaningful: boolean;
  /** Mean list position across displacing recommendations that carried one. */
  meanListPosition: number | null;
  byProvider: SegmentCount[];
  byCluster: SegmentCount[];
  byDimension: Partial<Record<DisplacementDimension, SegmentCount[]>>;
  /** Response ids backing the count — every claim traceable to evidence. */
  responseIds: string[];
}

export interface RivalSourceAssociation {
  companyId: string;
  name: string;
  /** Domains cited on this rival's displacing responses, most-cited first.
   * Domains below MIN_DOMAIN_ASSOCIATIONS are flagged, never headlined. */
  domains: {
    domain: string;
    count: number;
    meaningful: boolean;
    sourceType: string | null;
    relationship: string | null;
    /** Never seen on any response that recommended the subject. */
    absentForSubject: boolean;
  }[];
}

export interface DisplacementResult {
  version: string;
  runId: string;
  subjectCompanyId: string;
  validResponses: number;
  subjectMentionedResponses: number;
  subjectRecommendedResponses: number;
  absentResponses: number;
  status: "ok" | "insufficient_evidence";
  /** All rivals with ≥1 displacing recommendation, most-displacing first. */
  rivals: RivalDisplacement[];
  /** Measured facts (epistemics: OBSERVATION — spec 086). */
  observations: string[];
  /** Hedged read of the observations (INFERENCE). Never causal. */
  explanation: string | null;
  /** Observed source associations for meaningful rivals; empty until
   * attachSourceAssociations runs (DB-backed). */
  sourceAssociations: RivalSourceAssociation[];
}

export interface PromptContext {
  category: string;
  tier: number | null;
  audience: string | null;
  priceTier: string | null;
  neighborhood: string | null;
  building: string | null;
  propertyType: string | null;
  clusterLabel: string | null;
  isHoldout: boolean;
}

/** Prompt contexts (dimensions + derived cluster) from a frozen snapshot. */
export function promptContexts(
  frozenPrompts: FrozenPrompt[]
): Map<string, PromptContext> {
  const clusters = clusterPrompts(
    frozenPrompts.map((p) => ({
      id: p.promptId,
      text: p.text,
      category: p.category,
    }))
  );
  const clusterByPrompt = new Map<string, string>();
  for (const cluster of clusters) {
    for (const id of cluster.promptIds) clusterByPrompt.set(id, cluster.label);
  }
  return new Map(
    frozenPrompts.map((p) => [
      p.promptId,
      {
        category: p.category,
        tier: p.tier ?? null,
        audience: p.audience ?? null,
        priceTier: p.priceTier ?? null,
        neighborhood: p.neighborhood ?? null,
        building: p.building ?? null,
        propertyType: p.propertyType ?? null,
        clusterLabel: clusterByPrompt.get(p.promptId) ?? null,
        isHoldout: p.isHoldout ?? false,
      },
    ])
  );
}

export function dimensionSegment(
  ctx: PromptContext,
  dimension: DisplacementDimension
): string | null {
  switch (dimension) {
    case "category":
      return ctx.category;
    case "intent":
      return intentBand(ctx);
    case "audience":
      return ctx.audience;
    case "price_tier":
      return ctx.priceTier;
    case "neighborhood":
      return ctx.neighborhood;
    case "property_type":
      return ctx.propertyType;
    case "building":
      return ctx.building;
  }
}

function bump(map: Map<string, number>, key: string | null): void {
  if (key == null) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sorted(map: Map<string, number>): SegmentCount[] {
  return [...map.entries()]
    .map(([segment, count]) => ({ segment, count }))
    .sort((a, b) => b.count - a.count || a.segment.localeCompare(b.segment));
}

/**
 * Pure displacement computation. Callers guarantee: responses are valid
 * (error is null, mock filtered per the scoring rule) and mentions are
 * current-revision rows belonging to those responses.
 */
export function computeDisplacement(input: {
  runId: string;
  subjectCompanyId: string;
  responses: ValidResponseRow[];
  mentions: RunMentionRow[];
  contexts: Map<string, PromptContext>;
}): DisplacementResult {
  const { runId, subjectCompanyId, contexts } = input;

  // Holdout prompts stay out of every denominator (the scoring rule).
  const responses = input.responses.filter(
    (r) => !(contexts.get(r.promptId)?.isHoldout ?? false)
  );
  const responseById = new Map(responses.map((r) => [r.id, r]));
  const mentions = input.mentions.filter((m) => responseById.has(m.responseId));

  const subjectMentioned = new Set<string>();
  const subjectRecommended = new Set<string>();
  for (const m of mentions) {
    if (m.companyId !== subjectCompanyId || !m.mentioned) continue;
    subjectMentioned.add(m.responseId);
    if (m.recommended) subjectRecommended.add(m.responseId);
  }

  const absent = responses.filter((r) => !subjectMentioned.has(r.id));
  const absentIds = new Set(absent.map((r) => r.id));

  interface RivalAcc {
    name: string;
    responseIds: Set<string>;
    positions: number[];
    byProvider: Map<string, number>;
    byCluster: Map<string, number>;
    byDimension: Map<DisplacementDimension, Map<string, number>>;
  }
  const rivals = new Map<string, RivalAcc>();

  for (const m of mentions) {
    if (m.companyId === subjectCompanyId) continue;
    if (!m.mentioned || !m.recommended) continue;
    if (!absentIds.has(m.responseId)) continue;
    // Echo rule: a recommendation on a prompt that named this rival measures
    // our own question coming back, not a displacement.
    if (m.promptEchoed) continue;

    const response = responseById.get(m.responseId);
    if (!response) continue;
    const ctx = contexts.get(response.promptId);
    const acc: RivalAcc =
      rivals.get(m.companyId) ??
      {
        name: m.companyName,
        responseIds: new Set<string>(),
        positions: [],
        byProvider: new Map(),
        byCluster: new Map(),
        byDimension: new Map(),
      };
    acc.responseIds.add(m.responseId);
    if (m.listPosition != null) acc.positions.push(m.listPosition);
    bump(acc.byProvider, response.provider);
    if (ctx) {
      bump(acc.byCluster, ctx.clusterLabel);
      for (const dim of DISPLACEMENT_DIMENSIONS) {
        const seg = dimensionSegment(ctx, dim);
        if (seg == null) continue;
        const map = acc.byDimension.get(dim) ?? new Map<string, number>();
        bump(map, seg);
        acc.byDimension.set(dim, map);
      }
    }
    rivals.set(m.companyId, acc);
  }

  const rivalRows: RivalDisplacement[] = [...rivals.entries()]
    .map(([companyId, acc]) => ({
      companyId,
      name: acc.name,
      displacedResponses: acc.responseIds.size,
      shareOfAbsent:
        absent.length > 0 ? acc.responseIds.size / absent.length : null,
      meaningful: acc.responseIds.size >= MIN_MEANINGFUL_DISPLACEMENTS,
      meanListPosition:
        acc.positions.length > 0
          ? acc.positions.reduce((a, b) => a + b, 0) / acc.positions.length
          : null,
      byProvider: sorted(acc.byProvider),
      byCluster: sorted(acc.byCluster),
      byDimension: Object.fromEntries(
        [...acc.byDimension.entries()].map(([dim, map]) => [dim, sorted(map)])
      ) as Partial<Record<DisplacementDimension, SegmentCount[]>>,
      responseIds: [...acc.responseIds].sort(),
    }))
    .sort(
      (a, b) =>
        b.displacedResponses - a.displacedResponses ||
        a.name.localeCompare(b.name)
    );

  const status: DisplacementResult["status"] =
    absent.length < MIN_ABSENT_SAMPLE ? "insufficient_evidence" : "ok";

  const observations = [
    `${responses.length} valid observations; the subject was mentioned in ` +
      `${subjectMentioned.size} and recommended in ${subjectRecommended.size}.`,
    `${absent.length} observations did not mention the subject.`,
    ...rivalRows
      .filter((r) => r.meaningful)
      .slice(0, 5)
      .map(
        (r) =>
          `${r.name} was recommended instead in ${r.displacedResponses} of ` +
          `the ${absent.length} subject-absent observations.`
      ),
  ];

  const meaningfulCount = rivalRows.filter((r) => r.meaningful).length;
  const explanation =
    status === "insufficient_evidence"
      ? null
      : meaningfulCount > 0
        ? "When the subject was absent, these rivals repeatedly collected " +
          "the recommendation. This is an observed pattern in the sampled " +
          "answers, not a proven cause of the subject's absence."
        : "No rival collected recommendations repeatedly in the subject's " +
          "absence — the missing recommendations are dispersed rather than " +
          "concentrated on specific competitors.";

  return {
    version: DISPLACEMENT_VERSION,
    runId,
    subjectCompanyId,
    validResponses: responses.length,
    subjectMentionedResponses: subjectMentioned.size,
    subjectRecommendedResponses: subjectRecommended.size,
    absentResponses: absent.length,
    status,
    rivals: rivalRows,
    observations,
    explanation,
    sourceAssociations: [],
  };
}

/**
 * Observed source associations for meaningful rivals: which domains the
 * engines cited on the responses where each rival displaced the subject,
 * classified with the project's source taxonomy, and whether the domain ever
 * appears on a response that recommended the subject. Associations, never
 * causes.
 */
export async function attachSourceAssociations(
  result: DisplacementResult,
  projectId: string,
  subjectRecommendedResponseIds: string[]
): Promise<DisplacementResult> {
  const {
    citationDomainsForResponses,
    domainClassifications,
  } = await import("@/db/displacement");

  const meaningful = result.rivals.filter((r) => r.meaningful);
  if (meaningful.length === 0) return result;

  const allIds = [
    ...new Set([
      ...meaningful.flatMap((r) => r.responseIds),
      ...subjectRecommendedResponseIds,
    ]),
  ];
  const citationRows = await citationDomainsForResponses(allIds);
  const byResponse = new Map<string, string[]>();
  for (const row of citationRows) {
    const list = byResponse.get(row.responseId) ?? [];
    list.push(row.domain);
    byResponse.set(row.responseId, list);
  }

  const subjectDomains = new Set(
    subjectRecommendedResponseIds.flatMap((id) => byResponse.get(id) ?? [])
  );

  const allDomains = [...new Set(citationRows.map((r) => r.domain))];
  const classifications = new Map(
    (await domainClassifications(projectId, allDomains)).map((c) => [
      c.domain,
      c,
    ])
  );

  const sourceAssociations: RivalSourceAssociation[] = meaningful.map((r) => {
    const counts = new Map<string, number>();
    for (const id of r.responseIds) {
      for (const domain of new Set(byResponse.get(id) ?? [])) {
        counts.set(domain, (counts.get(domain) ?? 0) + 1);
      }
    }
    return {
      companyId: r.companyId,
      name: r.name,
      domains: [...counts.entries()]
        .map(([domain, count]) => ({
          domain,
          count,
          meaningful: count >= MIN_DOMAIN_ASSOCIATIONS,
          sourceType: classifications.get(domain)?.sourceType ?? null,
          relationship: classifications.get(domain)?.relationship ?? null,
          absentForSubject: !subjectDomains.has(domain),
        }))
        .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain)),
    };
  });

  return { ...result, sourceAssociations };
}

/**
 * Displacement for one run. Subject defaults to the project's is_self
 * company; prospect flows pass the prospect's company id explicitly. Null
 * when the run, its frozen version, or the subject is missing — absence,
 * not zeros.
 */
export async function runDisplacement(
  runId: string,
  options: { subjectCompanyId?: string; withSources?: boolean } = {}
): Promise<DisplacementResult | null> {
  const { sql } = await import("@/db/client");
  const { getSubjectCompany } = await import("@/db/companies");
  const { validResponsesForRun, currentMentionsWithEcho } = await import(
    "@/db/displacement"
  );
  const { mockScoringAllowed } = await import("@/lib/ai/registry");

  const [run] = await sql`
    select r.project_id, v.frozen_prompts
    from runs r
    join prompt_set_versions v on v.id = r.prompt_set_version_id
    where r.id = ${runId}
  `;
  if (!run?.frozenPrompts) return null;
  const projectId = run.projectId as string;

  let subjectCompanyId = options.subjectCompanyId;
  if (!subjectCompanyId) {
    const subject = await getSubjectCompany(projectId);
    if (!subject) return null;
    subjectCompanyId = subject.id;
  }

  // The scoring rule: mock captures never fold into real analysis.
  const allResponses = await validResponsesForRun(runId);
  const responses = mockScoringAllowed()
    ? allResponses
    : allResponses.filter((r) => r.provider !== "mock");
  const responseIds = new Set(responses.map((r) => r.id));
  const mentions = (await currentMentionsWithEcho(runId)).filter((m) =>
    responseIds.has(m.responseId)
  );

  const contexts = promptContexts(run.frozenPrompts as FrozenPrompt[]);
  const result = computeDisplacement({
    runId,
    subjectCompanyId,
    responses,
    mentions,
    contexts,
  });

  if (options.withSources === false) return result;
  const subjectRecommendedIds = [
    ...new Set(
      mentions
        .filter(
          (m) =>
            m.companyId === subjectCompanyId && m.mentioned && m.recommended
        )
        .map((m) => m.responseId)
    ),
  ];
  return attachSourceAssociations(result, projectId, subjectRecommendedIds);
}
