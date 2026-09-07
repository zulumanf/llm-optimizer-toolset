/**
 * Competitive-mismatch evidence panel (spec 124). Display-only, derived on
 * read from the one canonical review — the operator verifies the premise of
 * a mismatch draft in seconds, before approving. Never rendered to a
 * prospect; evidence stays out of the email itself.
 */
import { Badge } from "@/components/ui/badge";
import {
  MISMATCH_REASON_LABELS,
  formatProductionDisplay,
  mismatchStrength,
  type CompetitiveMismatchReview,
  type MismatchCandidate,
} from "@/lib/prospects/mismatch";

function EntityFacts({
  name,
  display,
  year,
  sourceUrl,
  recommended,
  answers,
}: {
  name: string;
  display: string;
  year: number | null;
  sourceUrl: string;
  recommended: number;
  answers: number;
}) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-sm font-medium">{name}</p>
      <p className="text-sm tabular-nums">{display}</p>
      <p className="text-xs text-muted-foreground">
        {sourceUrl.startsWith("http") ? (
          <a href={sourceUrl} target="_blank" rel="noreferrer" className="underline">
            RealTrends
          </a>
        ) : (
          <span title="Purchased RealTrends verified dataset (internal evidence — no public URL)">
            RealTrends verified dataset
          </span>
        )}
        {year ? ` · ${year}` : ""}
      </p>
      <p className="mt-1 text-xs tabular-nums">
        recommended in {recommended} of {answers} OpenAI answers
      </p>
    </div>
  );
}

export function MismatchPanel({ review }: { review: CompetitiveMismatchReview | null }) {
  if (!review) return null;
  const { evaluation } = review;
  const selected = evaluation.selected;
  return (
    <div className="mb-4 rounded-md border bg-muted/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">Competitive mismatch</p>
        <Badge variant={evaluation.eligible ? "default" : "secondary"}>
          {evaluation.eligible ? "eligible" : "not eligible"}
        </Badge>
        {evaluation.eligible && selected && (
          <Badge
            variant={mismatchStrength(selected) === "strong" ? "default" : "outline"}
            title="Operator diagnostic only — never shown to the recipient. Strong = competitor at ≤80% of the prospect's production AND a recommendation gap of 3+."
          >
            {mismatchStrength(selected)} hook
          </Badge>
        )}
        {evaluation.benchmarkAgeDays !== null && (
          <span className="text-xs text-muted-foreground tabular-nums">
            benchmark {evaluation.benchmarkAgeDays}d old
          </span>
        )}
      </div>
      {evaluation.eligible && selected && review.prospect.production ? (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <EntityFacts
              name={review.prospect.displayName}
              display={formatProductionDisplay(
                selected.metricType!,
                selected.metricType === "closed_volume"
                  ? review.prospect.production.volumeUsd
                  : review.prospect.production.sides
              )}
              year={review.prospect.production.productionYear}
              sourceUrl={review.prospect.production.sourceUrl}
              recommended={review.prospect.recommendationCount}
              answers={review.benchmark?.answerCount ?? 0}
            />
            <EntityFacts
              name={selected.displayName}
              display={formatProductionDisplay(
                selected.metricType!,
                selected.metricType === "closed_volume"
                  ? selected.production!.volumeUsd
                  : selected.production!.sides
              )}
              year={selected.production!.productionYear}
              sourceUrl={selected.production!.sourceUrl}
              recommended={selected.recommendationCount}
              answers={review.benchmark?.answerCount ?? 0}
            />
          </div>
          <p className="mt-2 text-xs tabular-nums">
            {selected.metricType === "closed_volume"
              ? `Prospect outproduces by ${formatProductionDisplay(
                  "closed_volume",
                  review.prospect.production.volumeUsd - selected.production!.volumeUsd
                ).replace(" closed", "")} (competitor at ${Math.round(
                  (selected.productionRatio ?? 1) * 100
                )}%)`
              : `Prospect outproduces by ${
                  review.prospect.production.sides - selected.production!.sides
                } sides (competitor at ${Math.round(
                  (selected.productionRatio ?? 1) * 100
                )}%)`}
            {" · recommendation gap +"}
            {selected.recommendationGap}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {review.benchmark?.capturedAt
              ? `Captured ${review.benchmark.capturedAt.toLocaleDateString()} · `
              : ""}
            {review.scopeCopy} · counted from OpenAI answers only, one per
            answer, prompts that name a team excluded.
          </p>
          {evaluation.eligibleCandidates.length > 1 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Other eligible comparisons:{" "}
              {evaluation.eligibleCandidates
                .slice(1)
                .map((c: MismatchCandidate) => c.displayName)
                .join(", ")}{" "}
              — pick one when generating the draft.
            </p>
          )}
        </>
      ) : (
        <ul className="mt-2 space-y-1">
          {evaluation.reasonCodes.map((code) => (
            <li key={code} className="text-xs text-muted-foreground">
              {MISMATCH_REASON_LABELS[code]}
            </li>
          ))}
          <li className="text-xs text-muted-foreground">
            The draft falls back to the reply-first template until the
            comparison is clean — it is never weakened to fire.
          </li>
        </ul>
      )}
    </div>
  );
}
