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
  /** Sample sizes behind each side (spec 051). Optional: older published
   * bodies predate the fields and render without them. */
  nCurrent?: number;
  nPrevious?: number;
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

/** Report cadences (spec 016). Each answers a different question and gets
 * its own section emphasis and default period length. */
export const REPORT_KINDS = ["weekly_pulse", "monthly", "quarterly"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const DEFAULT_PERIOD_DAYS: Record<ReportKind, number> = {
  weekly_pulse: 7,
  monthly: 28,
  quarterly: 91,
};

/** Program activity in the period — everything built since spec 006 that
 * reports were previously blind to (spec 016). */
export interface SnapshotGapFinding {
  findingId: string;
  gapType: string;
  finding: string;
  opportunityScore: number;
  status: string;
}

export interface SnapshotAccuracyFinding {
  accuracyId: string;
  kind: string;
  severity: string;
  quote: string;
  status: string;
}

/** One measured metric verdict, frozen at snapshot build (spec 051) —
 * the report records what was known when it was published. */
export interface SnapshotVerdictSummary {
  metric: string;
  postRunId: string;
  delta: number;
  verdict: string;
}

export interface SnapshotIntervention {
  interventionId: string;
  title: string;
  shippedAt: string;
  notableVerdicts: number;
  measuredVerdicts: number;
  /** Optional: older published bodies predate the field. */
  verdictSummaries?: SnapshotVerdictSummary[];
}

export interface SnapshotProgram {
  gapFindings: SnapshotGapFinding[];
  accuracyFindings: SnapshotAccuracyFinding[];
  interventions: SnapshotIntervention[];
  tasksCompleted: { taskId: string; title: string; priority: string }[];
  contentPublished: { assetId: string; title: string; url: string | null }[];
}

/** Category ownership — composed from existing rates and stability, never
 * a bare label: numerator/denominator always travel with it (spec 016). */
export interface SnapshotCategoryOwnership {
  category: string;
  label: "owned" | "emerging" | "contested" | "absent";
  observations: number;
  mentions: number;
  recommendations: number;
  leadingCompetitor: string | null;
  leadingCompetitorMentions: number;
}

export const NARRATIVE_SECTIONS = [
  "summary",
  "competitors",
  "notable_responses",
  "suggested_actions",
] as const;
export type NarrativeSection = (typeof NARRATIVE_SECTIONS)[number];

export interface ReportBody {
  kind: ReportKind;
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
  program: SnapshotProgram;
  categoryOwnership: SnapshotCategoryOwnership[];
  narrative: Record<NarrativeSection, string>;
}
