/**
 * Model agreement / disagreement (spec 066). Per-provider values existed
 * only as delta-noise inputs; this is the consensus read the data always
 * supported: "recommended by 3/4 providers" vs "only perplexity surfaces
 * them" — whether a visibility pattern is systemic or platform-shaped.
 *
 * Derived on read, never stored (the spec-036 stance). The pure core is
 * fixture-testable; eligibility mirrors scoring and head-to-head: errored
 * cells and holdout prompts excluded, latest mention revision wins.
 *
 * Agreement describes the pattern across assistants. It never explains it —
 * no causal language leaves this module.
 */
import { sql } from "@/db/client";
import { getSubjectCompany } from "@/db/companies";
import { listCompetitorsIncludingArchived } from "@/db/competitors";
import { latestScoredRunId } from "@/db/dashboard";
import type { FrozenPrompt } from "@/lib/prompts/types";

export const MODEL_AGREEMENT_VERSION = "model-agreement-v1";

/** A provider's reading needs this many eligible responses to count toward
 * the verdict — the docs/06 reporting rule (N < 10 is "insufficient data"). */
export const MIN_PROVIDER_SAMPLE = 10;

/** Mention-rate spread across eligible providers at or above this reads as
 * divergent: the assistants disagree about this company. */
export const DIVERGENCE_SPREAD = 0.35;

export interface ProviderReading {
  provider: string;
  responses: number;
  mentioned: number;
  recommended: number;
  /** responses >= MIN_PROVIDER_SAMPLE — insufficient readings render but
   * never enter the verdict. */
  sufficient: boolean;
}

export const AGREEMENT_LABELS = [
  "insufficient",
  "absent",
  "consensus_recommended",
  "single_provider",
  "divergent",
  "consensus_mentioned",
  "majority",
] as const;
export type AgreementLabel = (typeof AGREEMENT_LABELS)[number];

export interface CompanyAgreement {
  companyId: string;
  companyName: string;
  isSelf: boolean;
  readings: ProviderReading[];
  /** Providers with sufficient sample — the verdict's denominator. */
  eligibleProviders: number;
  mentionedOn: number;
  recommendedOn: number;
  /** max − min mention rate across eligible providers; null under 2. */
  spread: number | null;
  label: AgreementLabel;
  summary: string;
}

export interface ModelAgreementResult {
  version: string;
  runId: string | null;
  providers: string[];
  rows: CompanyAgreement[];
}

interface ResponseLite {
  responseId: string;
  provider: string;
}

interface MentionLite {
  responseId: string;
  companyId: string;
  mentioned: boolean;
  recommended: boolean;
}

const pct = (n: number, of: number) => `${Math.round((n / of) * 100)}%`;

/** Label precedence from the spec — first match wins, pure and pinned. */
function settle(
  readings: ProviderReading[]
): Pick<CompanyAgreement, "eligibleProviders" | "mentionedOn" | "recommendedOn" | "spread" | "label" | "summary"> {
  const eligible = readings.filter((r) => r.sufficient);
  const mentionedOn = eligible.filter((r) => r.mentioned > 0).length;
  const recommendedOn = eligible.filter((r) => r.recommended > 0).length;
  const rates = eligible.map((r) => ({
    provider: r.provider,
    rate: r.mentioned / r.responses,
    mentioned: r.mentioned,
    responses: r.responses,
  }));
  const spread =
    rates.length >= 2
      ? Math.max(...rates.map((r) => r.rate)) - Math.min(...rates.map((r) => r.rate))
      : null;
  const base = {
    eligibleProviders: eligible.length,
    mentionedOn,
    recommendedOn,
    spread,
  };

  if (eligible.length < 2) {
    return {
      ...base,
      label: "insufficient",
      summary: `A cross-model read needs at least two providers with N ≥ ${MIN_PROVIDER_SAMPLE}; this run has ${eligible.length}.`,
    };
  }
  if (mentionedOn === 0) {
    return {
      ...base,
      label: "absent",
      summary: `Not mentioned on any of ${eligible.length} providers.`,
    };
  }
  if (recommendedOn === eligible.length) {
    return {
      ...base,
      label: "consensus_recommended",
      summary: `Recommended on ${recommendedOn}/${eligible.length} providers — every assistant tested.`,
    };
  }
  if (mentionedOn === 1) {
    const only = eligible.find((r) => r.mentioned > 0)!;
    return {
      ...base,
      label: "single_provider",
      summary: `Mentioned only on ${only.provider} (${only.mentioned}/${only.responses} answers); absent on the other ${eligible.length - 1}.`,
    };
  }
  if (spread !== null && spread >= DIVERGENCE_SPREAD) {
    const sorted = [...rates].sort((a, b) => b.rate - a.rate);
    const top = sorted[0]!;
    const bottom = sorted[sorted.length - 1]!;
    return {
      ...base,
      label: "divergent",
      summary: `The assistants disagree: mention rate ranges from ${pct(bottom.mentioned, bottom.responses)} (${bottom.provider}, ${bottom.mentioned}/${bottom.responses}) to ${pct(top.mentioned, top.responses)} (${top.provider}, ${top.mentioned}/${top.responses}).`,
    };
  }
  if (mentionedOn === eligible.length) {
    return {
      ...base,
      label: "consensus_mentioned",
      summary: `Mentioned on all ${eligible.length} providers; recommended on ${recommendedOn}/${eligible.length}.`,
    };
  }
  return {
    ...base,
    label: "majority",
    summary: `Mentioned on ${mentionedOn}/${eligible.length} providers; recommended on ${recommendedOn}/${eligible.length}.`,
  };
}

/** Pure core, fixture-testable: responses = eligible cells only. */
export function computeModelAgreement(args: {
  companies: { companyId: string; companyName: string; isSelf: boolean }[];
  responses: ResponseLite[];
  mentions: MentionLite[];
}): Omit<ModelAgreementResult, "runId"> {
  const providers = [...new Set(args.responses.map((r) => r.provider))].sort();
  const responsesByProvider = new Map<string, number>();
  for (const response of args.responses) {
    responsesByProvider.set(
      response.provider,
      (responsesByProvider.get(response.provider) ?? 0) + 1
    );
  }
  const providerByResponse = new Map(
    args.responses.map((r) => [r.responseId, r.provider])
  );

  const rows: CompanyAgreement[] = args.companies.map((company) => {
    const counts = new Map<string, { mentioned: number; recommended: number }>(
      providers.map((p) => [p, { mentioned: 0, recommended: 0 }])
    );
    for (const mention of args.mentions) {
      if (mention.companyId !== company.companyId || !mention.mentioned) continue;
      const provider = providerByResponse.get(mention.responseId);
      if (!provider) continue; // mention on an ineligible (errored/holdout) cell
      const entry = counts.get(provider)!;
      entry.mentioned += 1;
      if (mention.recommended) entry.recommended += 1;
    }
    const readings: ProviderReading[] = providers.map((provider) => {
      const responses = responsesByProvider.get(provider) ?? 0;
      const entry = counts.get(provider)!;
      return {
        provider,
        responses,
        mentioned: entry.mentioned,
        recommended: entry.recommended,
        sufficient: responses >= MIN_PROVIDER_SAMPLE,
      };
    });
    return {
      companyId: company.companyId,
      companyName: company.companyName,
      isSelf: company.isSelf,
      readings,
      ...settle(readings),
    };
  });

  // Subject first, then by breadth of presence — a stable, explainable order.
  rows.sort(
    (a, b) =>
      Number(b.isSelf) - Number(a.isSelf) ||
      b.mentionedOn - a.mentionedOn ||
      a.companyName.localeCompare(b.companyName)
  );
  return { version: MODEL_AGREEMENT_VERSION, providers, rows };
}

/** Eligible responses (non-errored, non-holdout) + current mentions. */
async function loadRun(runId: string): Promise<{
  responses: ResponseLite[];
  mentions: MentionLite[];
}> {
  const [version] = await sql`
    select v.frozen_prompts from runs r
    join prompt_set_versions v on v.id = r.prompt_set_version_id
    where r.id = ${runId}
  `;
  const holdouts = new Set(
    ((version?.frozenPrompts as FrozenPrompt[] | null) ?? [])
      .filter((p) => p.isHoldout)
      .map((p) => p.promptId)
  );
  const responseRows = await sql`
    select id as response_id, prompt_id, provider from responses
    where run_id = ${runId} and error is null
  `;
  const responses = responseRows
    .filter((r) => !holdouts.has(r.promptId as string))
    .map((r) => ({
      responseId: r.responseId as string,
      provider: r.provider as string,
    }));

  const mentionRows = await sql`
    select m.response_id, m.company_id, m.mentioned, m.recommended
    from mentions m
    join responses r on r.id = m.response_id
    where r.run_id = ${runId}
      and not exists (select 1 from mentions n
        where n.response_id = m.response_id and n.company_id = m.company_id
          and n.revision > m.revision)
  `;
  return {
    responses,
    mentions: mentionRows.map((m) => ({
      responseId: m.responseId as string,
      companyId: m.companyId as string,
      mentioned: Boolean(m.mentioned),
      recommended: Boolean(m.recommended),
    })),
  };
}

export async function modelAgreementForProject(
  projectId: string,
  runId?: string
): Promise<ModelAgreementResult> {
  const targetRun = runId ?? (await latestScoredRunId(projectId));
  const subject = await getSubjectCompany(projectId);
  if (!targetRun || !subject) {
    return {
      version: MODEL_AGREEMENT_VERSION,
      runId: targetRun,
      providers: [],
      rows: [],
    };
  }
  const competitors = await listCompetitorsIncludingArchived(projectId);
  const { responses, mentions } = await loadRun(targetRun);
  const computed = computeModelAgreement({
    companies: [
      { companyId: subject.id, companyName: subject.name, isSelf: true },
      ...competitors
        .filter((c) => !c.archived)
        .map((c) => ({
          companyId: c.companyId,
          companyName: c.companyName,
          isSelf: false,
        })),
    ],
    responses,
    mentions,
  });
  return { ...computed, runId: targetRun };
}
