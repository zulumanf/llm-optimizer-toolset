/** Report snapshot shapes (spec 006). The body is fully self-contained:
 * everything a published report renders comes from here, never live tables. */

export interface SnapshotScore {
  scoreId: string;
  companyId: string;
  companyName: string;
  isSelf: boolean;
  metric: string;
  provider: string;
  value: number;
  sampleSize: number;
  scoringVersion: string;
}

export type DeltaVerdict = "notable" | "within_noise" | "insufficient" | null;

export interface SnapshotDelta {
  companyId: string;
  companyName: string;
  isSelf: boolean;
  metric: string;
  current: number;
  previous: number;
  delta: number;
  verdict: DeltaVerdict;
}

export interface SnapshotExcerpt {
  responseId: string;
  companyName: string;
  provider: string;
  runLabel: string;
  excerpt: string;
  recommended: boolean;
}

export interface SnapshotCoverage {
  runCount: number;
  capturedCells: number;
  failedCells: number;
  refusals: number;
  pendingReview: number;
}

export const NARRATIVE_SECTIONS = [
  "summary",
  "competitors",
  "notable_responses",
  "suggested_actions",
] as const;
export type NarrativeSection = (typeof NARRATIVE_SECTIONS)[number];

export interface ReportBody {
  scoringVersion: string;
  generatedAt: string;
  runs: { id: string; label: string; startedAt: string }[];
  currentRunId: string;
  previousRunId: string | null;
  comparable: boolean;
  comparabilityNote: string;
  scores: SnapshotScore[];
  deltas: SnapshotDelta[];
  excerpts: SnapshotExcerpt[];
  coverage: SnapshotCoverage;
  narrative: Record<NarrativeSection, string>;
}
