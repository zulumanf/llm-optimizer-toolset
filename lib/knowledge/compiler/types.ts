/**
 * The page-template contract (spec 023).
 *
 * The load-bearing decision: **a template declares its dependencies in the same
 * function that selects its data.** `select()` returns both the sections it
 * rendered and the canonical objects it read. The dependency graph is therefore
 * correct by construction — a template cannot read a claim and forget to
 * register it, because registering it is how the claim gets into the output.
 *
 * A unit test asserts the two agree: every claim id appearing in section
 * provenance must also appear in the declared dependency list.
 */
import type { FreshnessState } from "@/lib/knowledge/constants";

export type DependencyType =
  | "entity"
  | "claim"
  | "claim_version"
  | "evidence"
  | "source_artifact"
  | "transaction"
  | "prompt_cluster"
  | "visibility_measurement"
  | "action"
  | "outcome"
  | "methodology"
  | "instruction"
  | "competitor"
  | "market"
  | "neighborhood"
  | "page";

export interface PageDependency {
  type: DependencyType;
  id: string;
}

export interface SectionProvenance {
  claimIds: string[];
  claimVersionIds: string[];
  evidenceIds: string[];
  instructionVersionIds: string[];
  sourceArtifactIds: string[];
}

export interface SectionDraft {
  key: string;
  heading: string;
  body: string;
  /** A material section states a client fact and must carry provenance. */
  material: boolean;
  provenance: SectionProvenance;
}

export interface PageSelection {
  title: string;
  summary: string;
  sections: SectionDraft[];
  dependencies: PageDependency[];
  freshness: FreshnessState;
  /** Machine-readable mirror of the page, for consumers that want data. */
  structured: Record<string, unknown>;
}

export interface PageTemplate {
  /** Stable identity of the page within its client. */
  slug: string;
  pageType: string;
  title: string;
  /** Bumped when the rendering changes; recorded on every version. */
  templateVersion: string;
  /** Hot files declare one; ordinary pages usually do not. */
  tokenBudget?: number;
  privacy: "public" | "client_only" | "internal" | "restricted";
  /**
   * True when the page is shared across clients (a market, a methodology).
   * Shared pages compile once with a null project.
   */
  shared?: boolean;
  select(context: CompileContext): Promise<PageSelection> | PageSelection;
}

/** Everything a template may read, loaded once per build. */
export interface CompileContext {
  projectId: string | null;
  projectName: string;
  now: Date;
  data: ClientKnowledge;
}

// ------------------------------------------------------------ loaded shapes

export interface CompiledClaim {
  id: string;
  key: string;
  canonicalText: string;
  value: unknown;
  category: string;
  materiality: string;
  status: string;
  privacyStatus: string;
  verificationStatus: string;
  confidence: number | null;
  asOf: string | null;
  effectiveDate: string | null;
  reviewDate: string | null;
  lastVerifiedAt: string | null;
  allowedWording: string[];
  prohibitedWording: string[];
  evidenceIds: string[];
  sourceArtifactIds: string[];
  subjectEntity: string | null;
  subjectEntityId: string | null;
  normalizedPredicate: string | null;
  /** Latest immutable version row, for provenance. */
  claimVersionId: string | null;
  freshness: FreshnessState;
  freshnessReason: string;
}

export interface CompiledContradiction {
  id: string;
  claimId: string;
  contradictingClaimId: string | null;
  severity: string;
  description: string;
  detectedBy: string;
}

export interface CompiledEntity {
  id: string;
  entityType: string;
  canonicalName: string;
  slug: string;
  description: string;
  companyId: string | null;
  aliases: string[];
}

export interface CompiledCompetitor {
  id: string;
  name: string;
  domain: string | null;
  note: string;
}

export interface CompiledAction {
  id: string;
  title: string;
  status: string;
  kind: string;
  createdAt: string;
}

export interface CompiledMetric {
  metric: string;
  value: number;
  sampleSize: number;
  scoringVersion: string;
  computedAt: string;
}

export interface CompiledSource {
  id: string;
  sourceType: string;
  label: string;
  privacy: string;
  retrievedAt: string;
  extractionStatus: string;
}

export interface ClientKnowledge {
  claims: CompiledClaim[];
  contradictions: CompiledContradiction[];
  entities: CompiledEntity[];
  competitors: CompiledCompetitor[];
  actions: CompiledAction[];
  metrics: CompiledMetric[];
  sources: CompiledSource[];
  instructions: {
    id: string;
    versionId: string;
    instructionType: string;
    title: string;
    body: string;
    isSafety: boolean;
  }[];
  /** Canonical changes inside the recent-changes window. */
  recentChanges: {
    kind: string;
    subject: string;
    at: string;
  }[];
}
