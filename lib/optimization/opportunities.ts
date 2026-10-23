/**
 * Opportunity normalization (spec 151 B1), pure. Each existing finding
 * engine keeps its own logic; these functions only translate a finding row
 * into the shared opportunity shape and give it a stable identity across
 * runs (`dedupe_key`), so the same problem found again next week is the
 * same opportunity — its status survives regeneration.
 *
 * Copy is deterministic and versioned with the builder; nothing here calls
 * a model. Recommended actions describe what to do, never a promised
 * outcome (a citation does not guarantee a recommendation).
 */
import { createHash } from "node:crypto";
import { priorityBand, type PriorityBand } from "@/lib/gaps/detect";

export const OPPORTUNITY_BUILDER_VERSION = "opportunity-builder-v1";

export type OpportunityCategory = "visibility_gap" | "citation_source" | "website" | "accuracy";
export type SourceKind = "gap_finding" | "citation_opportunity" | "site_finding" | "accuracy_finding";
export type Effort = "low" | "medium" | "high" | "unknown";

export const OPPORTUNITY_STATUSES = [
  "proposed",
  "approved",
  "in_progress",
  "implemented",
  "measuring",
  "closed",
  "dismissed",
] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

/** Allowed lifecycle moves. Reopening a dismissed item returns it to proposed. */
export const OPPORTUNITY_TRANSITIONS: Record<OpportunityStatus, OpportunityStatus[]> = {
  proposed: ["approved", "dismissed"],
  approved: ["in_progress", "dismissed"],
  in_progress: ["implemented", "dismissed"],
  implemented: ["measuring"],
  measuring: ["closed"],
  closed: [],
  dismissed: ["proposed"],
};

export function canMoveOpportunity(from: OpportunityStatus, to: OpportunityStatus): boolean {
  return OPPORTUNITY_TRANSITIONS[from].includes(to);
}

/** Approval kinds a human must sign before the work can be executed. */
export const APPROVAL = {
  PUBLIC_CLAIM: "public_claim",
  THIRD_PARTY_OUTREACH: "third_party_outreach",
  CLIENT_WEBSITE_CHANGE: "client_website_change",
  CONTENT_PUBLICATION: "content_publication",
} as const;

export interface OpportunityDraft {
  dedupeKey: string;
  sourceKind: SourceKind;
  sourceId: string;
  category: OpportunityCategory;
  title: string;
  observedProblem: string;
  recommendedAction: string;
  targetIntent: string | null;
  targetLocation: string | null;
  affectedUrl: string | null;
  evidence: { kind: string; refId: string; note?: string }[];
  competitorNames: string[];
  priorityScore: number;
  priorityBand: PriorityBand;
  effort: Effort;
  estimatedCostUsd: number | null;
  confidence: number | null;
  limitations: string;
  approvalRequirements: string[];
  measurementPlan: MeasurementPlan;
}

export interface MeasurementPlan {
  primaryMetric: "recommendation_rate" | "mention_rate" | "owned_citation_rate";
  retests: string[];
  note: string;
}

const DEFAULT_RETESTS = ["+2w", "+6w", "+12w"];

const clamp100 = (v: number) => Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0));

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

const GAP_ACTIONS: Record<string, { title: string; action: string; metric: MeasurementPlan["primaryMetric"]; effort: Effort; approvals: string[] }> = {
  entity: {
    title: "Not surfaced for the category",
    action: "Strengthen the client's presence on the sources AI answers cite for this category (complete portal and directory profiles, a service-area page on the client's site) using approved facts only.",
    metric: "mention_rate",
    effort: "medium",
    approvals: [APPROVAL.CLIENT_WEBSITE_CHANGE, APPROVAL.THIRD_PARTY_OUTREACH],
  },
  branded_recognition: {
    title: "Not recognized when asked by name",
    action: "Make the client's identity unambiguous: consistent name, brokerage and service area across the client's site and major profiles; add structured data from approved facts.",
    metric: "mention_rate",
    effort: "low",
    approvals: [APPROVAL.CLIENT_WEBSITE_CHANGE],
  },
  recommendation: {
    title: "Mentioned but not recommended",
    action: "Publish verifiable proof of expertise (approved production facts, reviews the client already holds, specialties) on pages AI answers cite.",
    metric: "recommendation_rate",
    effort: "medium",
    approvals: [APPROVAL.PUBLIC_CLAIM, APPROVAL.CONTENT_PUBLICATION],
  },
  citation: {
    title: "Own site rarely cited",
    action: "Fix crawlability and make the client's own pages answer the buyer questions directly, with approved facts.",
    metric: "owned_citation_rate",
    effort: "medium",
    approvals: [APPROVAL.CLIENT_WEBSITE_CHANGE, APPROVAL.CONTENT_PUBLICATION],
  },
  category_share: {
    title: "Low share in a buyer-intent category",
    action: "Create or improve a page that addresses this buyer intent with approved facts, then re-measure the category.",
    metric: "recommendation_rate",
    effort: "medium",
    approvals: [APPROVAL.CONTENT_PUBLICATION],
  },
  source_target: {
    title: "A heavily cited source lacks the client",
    action: "Research whether the source accepts a listing, profile or contribution; draft the request for approval.",
    metric: "mention_rate",
    effort: "medium",
    approvals: [APPROVAL.THIRD_PARTY_OUTREACH],
  },
  displacement: {
    title: "A competitor holds the answers the client should appear in",
    action: "Compare the competitor's cited evidence with the client's and close the specific gaps with approved facts.",
    metric: "recommendation_rate",
    effort: "high",
    approvals: [APPROVAL.PUBLIC_CLAIM, APPROVAL.CONTENT_PUBLICATION],
  },
};

const UNVERIFIED_CAUSATION =
  "Observed in sampled API answers for the pinned instrument; it describes what the models said, not why. Acting on it is a hypothesis to be re-measured, not a guaranteed change.";

export interface GapFindingRow {
  id: string;
  gapType: string;
  promptCategory: string | null;
  finding: string;
  detail: Record<string, unknown>;
  opportunityScore: number;
  confidence: number | null;
  evidenceIds: string[];
}

function detailString(detail: Record<string, unknown>, key: string): string | null {
  const v = detail[key];
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

export function fromGapFinding(row: GapFindingRow, location: string | null): OpportunityDraft {
  const spec = GAP_ACTIONS[row.gapType] ?? {
    title: "Visibility gap",
    action: "Review the finding and decide on an action.",
    metric: "recommendation_rate" as const,
    effort: "unknown" as const,
    approvals: [APPROVAL.CONTENT_PUBLICATION],
  };
  const domain = detailString(row.detail, "domain");
  const competitor = detailString(row.detail, "topCompetitor") ?? detailString(row.detail, "leader");
  const score = clamp100(row.opportunityScore);
  return {
    dedupeKey: `gap:${row.gapType}:${row.promptCategory ?? "all"}:${domain ?? competitor ?? "-"}`,
    sourceKind: "gap_finding",
    sourceId: row.id,
    category: row.gapType === "source_target" ? "citation_source" : "visibility_gap",
    title: spec.title,
    observedProblem: row.finding,
    recommendedAction: spec.action,
    targetIntent: row.promptCategory,
    targetLocation: location,
    affectedUrl: domain ? `https://${domain}` : null,
    evidence: [{ kind: "gap_finding", refId: row.id }, ...row.evidenceIds.map((id) => ({ kind: "evidence", refId: id }))],
    competitorNames: competitor ? [competitor] : [],
    priorityScore: score,
    priorityBand: priorityBand(score),
    effort: spec.effort,
    estimatedCostUsd: null,
    confidence: row.confidence,
    limitations: UNVERIFIED_CAUSATION,
    approvalRequirements: spec.approvals,
    measurementPlan: { primaryMetric: spec.metric, retests: DEFAULT_RETESTS, note: "Re-measure on the pinned instrument; compare with control prompts named in the intervention plan." },
  };
}

export interface CitationOpportunityRow {
  id: string;
  domain: string;
  acvs: number | null;
  acquisitionPath: string;
  acquisitionDifficulty: string;
  estimatedCostUsd: number | null;
  nextAction: string | null;
}

const DIFFICULTY_EFFORT: Record<string, Effort> = { easy: "low", moderate: "medium", hard: "high" };

export function fromCitationOpportunity(row: CitationOpportunityRow, location: string | null): OpportunityDraft {
  const score = clamp100(row.acvs ?? 0);
  return {
    dedupeKey: `citation:${row.domain.toLowerCase()}`,
    sourceKind: "citation_opportunity",
    sourceId: row.id,
    category: "citation_source",
    title: `Get the client onto ${row.domain}`,
    observedProblem: `${row.domain} is cited in AI answers for this market (citation frequency, scored by ACVS), and the client is not established there.`,
    recommendedAction:
      row.nextAction ??
      `Research the ${row.acquisitionPath.replaceAll("_", " ")} route on ${row.domain}; draft any outreach for approval.`,
    targetIntent: null,
    targetLocation: location,
    affectedUrl: `https://${row.domain}`,
    evidence: [{ kind: "citation_opportunity", refId: row.id }],
    competitorNames: [],
    priorityScore: score,
    priorityBand: priorityBand(score),
    effort: DIFFICULTY_EFFORT[row.acquisitionDifficulty] ?? "unknown",
    estimatedCostUsd: row.estimatedCostUsd,
    confidence: null,
    limitations:
      "Citation frequency is not influence: being cited more often does not show the source caused any recommendation, and a placement does not guarantee one.",
    approvalRequirements: [APPROVAL.THIRD_PARTY_OUTREACH],
    measurementPlan: { primaryMetric: "mention_rate", retests: DEFAULT_RETESTS, note: "Verify the placement is live, then re-measure; citations are a mediator, reported separately." },
  };
}

export interface SiteFindingRow {
  id: string;
  checkType: string;
  observation: string;
  recommendation: string;
  priorityScore: number;
  pageUrl: string | null;
  severity: string;
}

const SEVERITY_EFFORT: Record<string, Effort> = { critical: "low", high: "low", medium: "medium", low: "medium", info: "low" };

export function fromSiteFinding(row: SiteFindingRow, location: string | null): OpportunityDraft {
  const score = clamp100(row.priorityScore);
  return {
    dedupeKey: `site:${row.checkType}:${row.pageUrl ?? "site"}`,
    sourceKind: "site_finding",
    sourceId: row.id,
    category: "website",
    title: `Website: ${row.checkType.replaceAll("_", " ")}`,
    observedProblem: row.observation,
    recommendedAction: row.recommendation,
    targetIntent: null,
    targetLocation: location,
    affectedUrl: row.pageUrl,
    evidence: [{ kind: "site_finding", refId: row.id }],
    competitorNames: [],
    priorityScore: score,
    priorityBand: priorityBand(score),
    effort: SEVERITY_EFFORT[row.severity] ?? "unknown",
    estimatedCostUsd: null,
    confidence: null,
    limitations: "A technical fix removes an obstacle to crawling or understanding the site; on its own it is not evidence the models will recommend the client.",
    approvalRequirements: [APPROVAL.CLIENT_WEBSITE_CHANGE],
    measurementPlan: { primaryMetric: "owned_citation_rate", retests: DEFAULT_RETESTS, note: "Re-scan the site after the change, then re-measure." },
  };
}

export interface AccuracyFindingRow {
  id: string;
  kind: string;
  quote: string;
  rationale: string;
  severity: string;
  confidence: number;
  claimId: string | null;
  responseId: string;
}

const ACCURACY_SCORE: Record<string, number> = { high: 80, medium: 55, low: 30 };

export function fromAccuracyFinding(row: AccuracyFindingRow, location: string | null): OpportunityDraft {
  const score = ACCURACY_SCORE[row.severity] ?? 30;
  return {
    dedupeKey: `accuracy:${row.kind}:${row.claimId ?? shortHash(row.quote)}`,
    sourceKind: "accuracy_finding",
    sourceId: row.id,
    category: "accuracy",
    title: `AI states something wrong or unverifiable (${row.kind.replaceAll("_", " ")})`,
    observedProblem: `"${row.quote}" — ${row.rationale}`,
    recommendedAction: "Find where the wrong information comes from and correct it at the source (client site or third-party profile); corrections are drafted for approval, never sent automatically.",
    targetIntent: null,
    targetLocation: location,
    affectedUrl: null,
    evidence: [
      { kind: "accuracy_finding", refId: row.id },
      { kind: "response", refId: row.responseId },
      ...(row.claimId ? [{ kind: "claim", refId: row.claimId }] : []),
    ],
    competitorNames: [],
    priorityScore: score,
    priorityBand: priorityBand(score),
    effort: "medium",
    estimatedCostUsd: null,
    confidence: row.confidence,
    limitations: "The quote is verbatim from a stored answer; the source of the error is not yet identified.",
    approvalRequirements: [APPROVAL.PUBLIC_CLAIM, APPROVAL.THIRD_PARTY_OUTREACH],
    measurementPlan: { primaryMetric: "mention_rate", retests: DEFAULT_RETESTS, note: "Re-run accuracy analysis after correction; the finding is closed only when the statement no longer appears." },
  };
}

/** One opportunity per key: the highest-priority draft wins (stable tie-break). */
export function dedupeDrafts(drafts: OpportunityDraft[]): OpportunityDraft[] {
  const byKey = new Map<string, OpportunityDraft>();
  for (const d of drafts) {
    const cur = byKey.get(d.dedupeKey);
    if (!cur || d.priorityScore > cur.priorityScore || (d.priorityScore === cur.priorityScore && d.sourceId < cur.sourceId)) {
      byKey.set(d.dedupeKey, d);
    }
  }
  return [...byKey.values()].sort((a, b) => b.priorityScore - a.priorityScore || a.dedupeKey.localeCompare(b.dedupeKey));
}
