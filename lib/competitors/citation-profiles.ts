/**
 * Citation-profile comparison (spec 036). For each company: the domains
 * cited in responses that RECOMMEND it, with counts and registry labels;
 * for each competitor: the source gap — domains backing its
 * recommendations that never appear when the subject is recommended.
 * Derived on read; every output frames this as co-occurrence, never
 * causal influence.
 */
import { getSubjectCompany } from "@/db/companies";
import { listCompetitorsIncludingArchived } from "@/db/competitors";
import {
  domainLabelsForProject,
  recommendedCitationDomains,
  type RecommendedCitationRow,
} from "@/db/citation-profiles";
import { latestScoredRunId } from "@/db/dashboard";

export const CITATION_PROFILE_VERSION = "citation-profile-v1";

export interface ProfileDomain {
  domain: string;
  citations: number;
  sourceType: string | null;
  relationship: string | null;
}

export interface CompanyCitationProfile {
  companyId: string;
  companyName: string;
  isSelf: boolean;
  archived: boolean;
  domains: ProfileDomain[];
  /** Competitors only: domains absent from the subject's profile. */
  sourceGap: ProfileDomain[];
}

export interface CitationProfilesResult {
  version: string;
  runId: string | null;
  note: string;
  profiles: CompanyCitationProfile[];
}

const NOTE =
  "Domains cited in answers that recommend each company — observed co-occurrence, not proof of causal influence.";

/** Pure assembly, fixture-testable. */
export function buildProfiles(args: {
  selfId: string;
  selfName: string;
  competitors: { companyId: string; companyName: string; archived?: boolean }[];
  rows: RecommendedCitationRow[];
  labels: { domain: string; sourceType: string | null; relationship: string | null }[];
}): CompanyCitationProfile[] {
  const labelByDomain = new Map(args.labels.map((l) => [l.domain, l]));
  const toDomains = (companyId: string): ProfileDomain[] =>
    args.rows
      .filter((r) => r.companyId === companyId)
      .map((r) => ({
        domain: r.domain,
        citations: r.citations,
        sourceType: labelByDomain.get(r.domain)?.sourceType ?? null,
        relationship: labelByDomain.get(r.domain)?.relationship ?? null,
      }));

  const selfDomains = toDomains(args.selfId);
  const selfSet = new Set(selfDomains.map((d) => d.domain));

  return [
    {
      companyId: args.selfId,
      companyName: args.selfName,
      isSelf: true,
      archived: false,
      domains: selfDomains,
      sourceGap: [],
    },
    ...args.competitors.map((competitor) => {
      const domains = toDomains(competitor.companyId);
      return {
        companyId: competitor.companyId,
        companyName: competitor.companyName,
        isSelf: false,
        archived: competitor.archived ?? false,
        domains,
        sourceGap: domains.filter((d) => !selfSet.has(d.domain)),
      };
    }),
  ];
}

export async function citationProfilesForProject(
  projectId: string,
  runId?: string
): Promise<CitationProfilesResult> {
  const targetRun = runId ?? (await latestScoredRunId(projectId));
  const subject = await getSubjectCompany(projectId);
  if (!targetRun || !subject) {
    return {
      version: CITATION_PROFILE_VERSION,
      runId: targetRun,
      note: NOTE,
      profiles: [],
    };
  }
  const [competitors, rows, labels] = await Promise.all([
    listCompetitorsIncludingArchived(projectId),
    recommendedCitationDomains(targetRun),
    domainLabelsForProject(projectId),
  ]);
  return {
    version: CITATION_PROFILE_VERSION,
    runId: targetRun,
    note: NOTE,
    profiles: buildProfiles({
      selfId: subject.id,
      selfName: subject.name,
      competitors,
      rows,
      labels,
    }),
  };
}
