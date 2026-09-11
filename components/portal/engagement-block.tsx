import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import type { PortalEngagement } from "@/lib/portal/service";

/**
 * The client's program in the order they ask (spec 131): current state
 * (baseline), what needs them, what we are working on, what changed,
 * measurement, next. Numbers always carry their denominator and date;
 * absence says so. No internal scoring, costs or other clients.
 */
export function PortalEngagementBlock({ engagement: e }: { engagement: PortalEngagement }) {
  const KIND_LABEL = { approval: "Approve", input: "Your input", access: "Access" } as const;
  return (
    <div className="space-y-8">
      <section>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Your program</p>
        <h2 className="mt-1 text-lg font-medium">
          {e.marketName} · {formatDate(new Date(`${e.startsOn}T12:00:00Z`))} to {formatDate(new Date(`${e.endsOn}T12:00:00Z`))}
        </h2>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">{e.scopeSummary}</p>
      </section>

      <section>
        <h3 className="text-sm font-medium">Where you started (baseline)</h3>
        {e.baseline ? (
          <div className="mt-2 rounded-md border p-4 text-sm">
            <p>
              Recommended in{" "}
              <span className="font-medium tabular-nums">
                {e.baseline.recommendedCount} of {e.baseline.answerCount}
              </span>{" "}
              valid answers from the {e.baseline.provider === "openai" ? "OpenAI model behind ChatGPT" : e.baseline.provider}, across{" "}
              <span className="tabular-nums">{e.baseline.distinctQuestions}</span> of {e.baseline.questionCount} questions
              {e.baseline.capturedAt ? ` (captured ${formatDate(new Date(e.baseline.capturedAt))})` : ""}.
            </p>
            {e.baseline.competitors.length > 0 && (
              <p className="mt-2 text-muted-foreground">
                Same questions, same answers:{" "}
                {e.baseline.competitors
                  .map((c) => `${c.name} ${c.recommendedCount} of ${e.baseline!.answerCount}`)
                  .join(" · ")}
                .
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              This baseline is frozen. Every later measurement re-asks the same questions and is compared to it.
            </p>
          </div>
        ) : (
          <p className="mt-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            The baseline is being frozen from the benchmark you received. It appears here once locked.
          </p>
        )}
      </section>

      <section>
        <h3 className="text-sm font-medium">Needs your input</h3>
        {e.needsYourInput.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Nothing is waiting on you right now.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {e.needsYourInput.map((t) => (
              <li key={t.id} className="rounded-md border p-3 text-sm">
                <div className="flex items-start gap-2">
                  <Badge>{KIND_LABEL[t.kind]}</Badge>
                  <div className="min-w-0">
                    <p className="font-medium">{t.title}</p>
                    {t.why && <p className="mt-1 text-muted-foreground">Why: {t.why}</p>}
                    {t.proposedChange && <p className="mt-1">Proposed change: {t.proposedChange}</p>}
                    {t.targetUrl && <p className="mt-1 break-all text-xs text-muted-foreground">Where: {t.targetUrl}</p>}
                    {t.detail && <p className="mt-1 text-muted-foreground">{t.detail}</p>}
                    <p className="mt-1 text-xs text-muted-foreground">Reply by email to approve, decline, or request an edit — we record your decision.</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="text-sm font-medium">What we are working on</h3>
        {e.workingOn.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No work item is in progress yet; the plan starts after onboarding.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {e.workingOn.map((t) => (
              <li key={t.id} className="rounded-md border p-3 text-sm">
                <p className="font-medium">{t.title}</p>
                {t.why && <p className="mt-1 text-muted-foreground">{t.why}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="text-sm font-medium">What changed</h3>
        {e.changed.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No change has been completed yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {e.changed.map((c) => (
              <li key={c.id} className="rounded-md border p-3 text-sm">
                <p className="font-medium">{c.title}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDate(c.at)}
                  {c.targetUrl ? ` · ${c.targetUrl}` : ""}
                </p>
                {c.after && <p className="mt-1">Now: {c.after}</p>}
                {c.why && <p className="mt-1 text-muted-foreground">Why: {c.why}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="text-sm font-medium">Measurement</h3>
        {e.latestMeasurement ? (
          <div className="mt-2 rounded-md border p-4 text-sm">
            <p>{e.latestMeasurement.statement}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Measured {formatDate(e.latestMeasurement.at)} · comparability {e.latestMeasurement.grade.replace(/_/g, " ")}
              {e.latestMeasurement.reasons.length > 0 ? ` (${e.latestMeasurement.reasons.join("; ")})` : ""}.
            </p>
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            No remeasurement yet. The baseline stands until the next scheduled run.
          </p>
        )}
      </section>

      <section>
        <h3 className="text-sm font-medium">Next</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {e.nextMeasurementOn
            ? `Next remeasurement on the same questions: ${formatDate(new Date(`${e.nextMeasurementOn}T12:00:00Z`))}.`
            : "No further remeasurement is scheduled."}{" "}
          Weekly updates arrive by email.
        </p>
      </section>
    </div>
  );
}
