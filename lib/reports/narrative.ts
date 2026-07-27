/**
 * Narrative drafter + citation validator (spec 006). Drafter v1 is
 * deterministic templating over the snapshot — every numeric claim carries a
 * [score:id] / [response:id] citation by construction (DECISIONS.md: no LLM
 * drafter until provider keys exist; REPORT_DRAFTER_V1 lands as a later
 * version). The validator is what publish enforces (evidence_score = 1.0):
 * every sentence containing a number must cite, and every citation must
 * resolve inside the snapshot.
 */
import type { ReportBody, NarrativeSection, SnapshotScore } from "@/lib/reports/types";

const CITATION_RE = /\[(score|response):([0-9a-f-]{36})\]/g;
// Non-global twin for .test() — the global one is stateful and unsafe there
const CITATION_TEST = /\[(?:score|response):[0-9a-f-]{36}\]/;

export interface ValidationResult {
  ok: boolean;
  uncitedSentences: string[];
  unresolvedCitations: string[];
}

export function validateNarrative(
  narrative: Partial<Record<NarrativeSection, string>>,
  body: Pick<ReportBody, "scores" | "excerpts">
): ValidationResult {
  const scoreIds = new Set(body.scores.map((s) => s.scoreId));
  const responseIds = new Set(body.excerpts.map((e) => e.responseId));
  const uncitedSentences: string[] = [];
  const unresolvedCitations: string[] = [];

  for (const text of Object.values(narrative)) {
    if (!text) continue;
    for (const match of text.matchAll(CITATION_RE)) {
      const [token, kind, id] = match as unknown as [string, string, string];
      const pool = kind === "score" ? scoreIds : responseIds;
      if (!pool.has(id)) unresolvedCitations.push(token);
    }
    const sentences = text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const sentence of sentences) {
      const withoutCitations = sentence.replace(CITATION_RE, "");
      if (/\d/.test(withoutCitations) && !CITATION_TEST.test(sentence)) {
        uncitedSentences.push(sentence);
      }
    }
  }

  return {
    ok: uncitedSentences.length === 0 && unresolvedCitations.length === 0,
    uncitedSentences,
    unresolvedCitations,
  };
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function findScore(
  scores: SnapshotScore[],
  opts: { isSelf?: boolean; companyId?: string; metric: string }
): SnapshotScore | undefined {
  return scores.find(
    (s) =>
      s.provider === "all" &&
      s.metric === opts.metric &&
      (opts.isSelf === undefined || s.isSelf === opts.isSelf) &&
      (opts.companyId === undefined || s.companyId === opts.companyId)
  );
}

/** Deterministic draft of every narrative section, fully cited. */
export function draftNarrative(
  body: Omit<ReportBody, "narrative">
): Record<NarrativeSection, string> {
  const { scores, deltas, excerpts, coverage, comparable, comparabilityNote } = body;

  // Summary — Parva's headline numbers with deltas where comparable
  const summaryParts: string[] = [];
  const authority = findScore(scores, { isSelf: true, metric: "authority_score" });
  if (authority) {
    summaryParts.push(
      `Parva's authority score is ${authority.value.toFixed(1)} (N=${authority.sampleSize}) [score:${authority.scoreId}].`
    );
  }
  const recRate = findScore(scores, { isSelf: true, metric: "recommendation_rate" });
  if (recRate) {
    summaryParts.push(
      `The recommendation rate is ${pct(recRate.value)} [score:${recRate.scoreId}].`
    );
  }
  for (const delta of deltas.filter((d) => d.isSelf)) {
    const score = findScore(scores, { isSelf: true, metric: delta.metric });
    if (!score) continue;
    const direction = delta.delta >= 0 ? "up" : "down";
    const verdictText =
      delta.verdict === "notable"
        ? "a notable change"
        : delta.verdict === "insufficient"
          ? "sample too small to judge (insufficient data)"
          : "within noise";
    summaryParts.push(
      `Versus the previous comparable run, ${delta.metric.replace(/_/g, " ")} moved ${direction} by ${Math.abs(delta.delta).toFixed(3)} — ${verdictText} [score:${score.scoreId}].`
    );
  }
  if (!comparable) summaryParts.push(comparabilityNote);
  summaryParts.push(
    coverage.pendingReview > 0
      ? // No digits here on purpose: the evidence gate requires citations on
        // numeric sentences, and the exact count lives in the coverage line
        "Coverage caveat: some classifications were still awaiting review when this snapshot was taken (count in the coverage line) — affected conclusions are qualified."
      : "The review queue was clear when this snapshot was taken."
  );

  // Competitors — side-by-side authority + recommendation rate
  const competitorParts: string[] = [];
  const byCompany = new Map<string, SnapshotScore[]>();
  for (const score of scores.filter((s) => s.provider === "all")) {
    if (!byCompany.has(score.companyId)) byCompany.set(score.companyId, []);
    byCompany.get(score.companyId)!.push(score);
  }
  for (const [, companyScores] of byCompany) {
    const first = companyScores[0];
    if (!first || first.isSelf) continue;
    const auth = companyScores.find((s) => s.metric === "authority_score");
    const rec = companyScores.find((s) => s.metric === "recommendation_rate");
    const bits: string[] = [];
    if (auth) bits.push(`authority ${auth.value.toFixed(1)} [score:${auth.scoreId}]`);
    if (rec) bits.push(`recommendation rate ${pct(rec.value)} [score:${rec.scoreId}]`);
    if (bits.length > 0) competitorParts.push(`${first.companyName}: ${bits.join(", ")}.`);
  }
  if (competitorParts.length === 0) {
    competitorParts.push("No competitors are tracked for this period.");
  }

  // Notable responses — verbatim excerpts, cited to their immutable captures
  const notableParts = excerpts
    .slice(0, 5)
    .map(
      (e) =>
        `${e.companyName} (${e.provider}, ${e.runLabel}): "${e.excerpt}" [response:${e.responseId}]`
    );
  if (notableParts.length === 0) notableParts.push("No notable excerpts in this period.");

  // Suggested actions — suggestions only; humans approve (PRINCIPLES.md #8)
  const actionParts: string[] = [];
  for (const delta of deltas.filter((d) => d.isSelf && d.verdict === "notable")) {
    const score = findScore(scores, { isSelf: true, metric: delta.metric });
    if (!score) continue;
    actionParts.push(
      delta.delta < 0
        ? `Suggestion: investigate the notable drop in ${delta.metric.replace(/_/g, " ")} (${delta.delta.toFixed(3)}) [score:${score.scoreId}].`
        : `Suggestion: identify what drove the notable gain in ${delta.metric.replace(/_/g, " ")} (+${delta.delta.toFixed(3)}) and reinforce it [score:${score.scoreId}].`
    );
  }
  if (recRate && recRate.value < 0.5) {
    actionParts.push(
      `Suggestion: recommendation rate is ${pct(recRate.value)} — review the top competitor excerpts for positioning gaps [score:${recRate.scoreId}].`
    );
  }
  if (actionParts.length === 0) {
    actionParts.push("No actions suggested for this period.");
  }

  return {
    summary: summaryParts.join(" "),
    competitors: competitorParts.join(" "),
    notable_responses: notableParts.join("\n\n"),
    suggested_actions: actionParts.join("\n\n"),
  };
}
