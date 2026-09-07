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
import { findCausalPhrase } from "@/lib/workflow/gates";

const CITATION_RE = /\[(score|response|finding|accuracy):([0-9a-f-]{36})\]/g;
// Non-global twin for .test() — the global one is stateful and unsafe there
// Citation kinds gained finding/accuracy in spec 016 so program numbers
// (gap and accuracy counts) are as traceable as score numbers.
const CITATION_TEST = /\[(?:score|response|finding|accuracy):[0-9a-f-]{36}\]/;

export interface ValidationResult {
  ok: boolean;
  uncitedSentences: string[];
  unresolvedCitations: string[];
  /** Sentences making causal claims (spec 051). Causality belongs to the
   * attribution system's labeled outcomes, never to narrative prose — and
   * the digit rule alone let numberless causal prose ("our work drove your
   * gains") publish clean (audit F19). */
  causalSentences: string[];
}

export function validateNarrative(
  narrative: Partial<Record<NarrativeSection, string>>,
  body: Pick<ReportBody, "scores" | "excerpts"> & {
    program?: ReportBody["program"];
  }
): ValidationResult {
  const scoreIds = new Set(body.scores.map((s) => s.scoreId));
  const responseIds = new Set(body.excerpts.map((e) => e.responseId));
  const findingIds = new Set(
    (body.program?.gapFindings ?? []).map((g) => g.findingId)
  );
  const accuracyIds = new Set(
    (body.program?.accuracyFindings ?? []).map((a) => a.accuracyId)
  );
  const uncitedSentences: string[] = [];
  const unresolvedCitations: string[] = [];
  const causalSentences: string[] = [];

  for (const text of Object.values(narrative)) {
    if (!text) continue;
    for (const match of text.matchAll(CITATION_RE)) {
      const [token, kind, id] = match as unknown as [string, string, string];
      const pool =
        kind === "score"
          ? scoreIds
          : kind === "response"
            ? responseIds
            : kind === "finding"
              ? findingIds
              : accuracyIds;
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
      if (findCausalPhrase(sentence) !== null) {
        causalSentences.push(sentence);
      }
    }
  }

  return {
    ok:
      uncitedSentences.length === 0 &&
      unresolvedCitations.length === 0 &&
      causalSentences.length === 0,
    uncitedSentences,
    unresolvedCitations,
    causalSentences,
  };
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/**
 * Make arbitrary stored text safe to interpolate into a cited sentence.
 * Without this, a snippet containing "." splits into multiple sentences and
 * the numeric half loses its citation — the evidence gate then (correctly)
 * blocks publish. Caught on real data: a gap finding ending in a period and
 * an excerpt that was literally "2.".
 */
function inline(text: string, max: number): string {
  return text
    .replace(/\s+/g, " ")
    .slice(0, max)
    .replace(/([.!?])(\s+)/g, ";$2")
    .replace(/[.!?]+\s*$/, "")
    .trim();
}

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
  const program = body.program;
  const isPulse = body.kind === "weekly_pulse";

  // Summary — the subject's headline numbers with deltas where comparable
  const summaryParts: string[] = [];

  // Weekly pulse leads with what changed and what needs a human, not with
  // standing metrics (spec 016): an operating brief, not a scorecard.
  if (isPulse && program) {
    const highAccuracy = program.accuracyFindings.filter(
      (a) => a.severity === "high"
    );
    for (const finding of highAccuracy.slice(0, 3)) {
      summaryParts.push(
        `New high-severity accuracy finding (${finding.kind.replace(/_/g, " ")}): "${inline(finding.quote, 140)}" [accuracy:${finding.accuracyId}].`
      );
    }
    if (highAccuracy.length === 0) {
      summaryParts.push("No new high-severity factual problems this period.");
    }
    for (const gap of program.gapFindings.slice(0, 2)) {
      summaryParts.push(
        `Top open gap — ${gap.gapType.replace(/_/g, " ")}: ${inline(gap.finding, 160)} [finding:${gap.findingId}].`
      );
    }
    // Counts, dates, titles and URLs live in the structured program tables
    // below — prose stays free of uncited numerals so the evidence gate
    // (docs/06) passes by construction, exactly like the coverage line.
    if (program.interventions.length > 0) {
      summaryParts.push(
        "Interventions shipped in this period are being measured; their post-run counts are in the program section."
      );
    }
    if (program.tasksCompleted.length > 0) {
      summaryParts.push(
        "Work completed this period is listed in the program section."
      );
    }
    if (program.contentPublished.length > 0) {
      summaryParts.push(
        "Content published this period is listed in the program section, with URLs."
      );
    }
  }
  const authority = findScore(scores, { isSelf: true, metric: "authority_score" });
  if (authority) {
    summaryParts.push(
      `${authority.companyName}'s authority score is ${authority.value.toFixed(1)} (N=${authority.sampleSize}) [score:${authority.scoreId}].`
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

  // Category ownership — where the client stands per prompt category,
  // always with numerator/denominator so a label never stands alone
  // Labels only in prose; the numerator/denominator for every row is in the
  // category-ownership table (structured body data, immutable once published)
  const ownershipParts: string[] = [];
  for (const row of body.categoryOwnership ?? []) {
    const leader =
      row.leadingCompetitor && row.label !== "owned"
        ? ` ${row.leadingCompetitor} leads it.`
        : "";
    ownershipParts.push(`"${row.category}" — ${row.label}.${leader}`);
  }

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
        `${e.companyName} (${e.provider}, ${inline(e.runLabel, 80)}): "${inline(e.excerpt, 300)}" [response:${e.responseId}]`
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

  // Category ownership rides in the competitors section: it is the same
  // question ("who owns what") at category rather than company granularity.
  const competitorText = [
    competitorParts.join(" "),
    ownershipParts.length > 0
      ? `Category ownership: ${ownershipParts.join(" ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    summary: summaryParts.join(" "),
    competitors: competitorText,
    notable_responses: notableParts.join("\n\n"),
    suggested_actions: actionParts.join("\n\n"),
  };
}
