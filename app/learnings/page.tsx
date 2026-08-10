import { Badge } from "@/components/ui/badge";
import { searchLearnings } from "@/lib/learnings/service";
import {
  RecordLearningDialog,
  RetireLearningButton,
} from "@/components/learnings/learning-controls";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

const CONFIDENCE_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  confirmed: "default",
  strongly_supported: "default",
  correlated: "secondary",
  probable: "secondary",
  unknown: "outline",
};

/** What we learned, and how sure we are (spec 058). Confirmed and
 * strongly-supported rows re-order plan composition; everything else is
 * context. Retire-and-rewrite is the only correction path. */
export default async function LearningsPage() {
  const learnings = await searchLearnings({ includeRetired: true });
  const active = learnings.filter((l) => l.status === "active");
  const retired = learnings.filter((l) => l.status === "retired");

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Learnings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Measured outcomes, distilled. Confirmed learnings about a play
            move its rank in every future plan — supports up, cautions down —
            so the second engagement starts smarter than the first.
          </p>
        </div>
        <RecordLearningDialog />
      </div>

      {active.length === 0 ? (
        <p className="rounded-md border border-dashed p-8 text-sm text-muted-foreground">
          Nothing recorded yet. When a re-measured intervention settles,
          distill what it showed here — cite its outcome IDs and future plans
          will use it.
        </p>
      ) : (
        <ul className="space-y-2">
          {active.map((l) => (
            <li key={l.id} className="rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge variant={CONFIDENCE_VARIANT[l.confidenceLabel] ?? "outline"}>
                      {l.confidenceLabel.replace(/_/g, " ")}
                    </Badge>
                    <Badge variant="outline">{l.category}</Badge>
                    {l.direction === "cautions" && (
                      <Badge variant="destructive">cautions</Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {formatDate(l.createdAt)}
                      {l.playKey ? ` · ${l.playKey}` : ""}
                      {l.gapType ? ` · ${l.gapType}` : ""}
                    </span>
                  </p>
                  <p className="font-medium">{l.statement}</p>
                  {l.rationale && (
                    <p className="mt-1 text-muted-foreground">{l.rationale}</p>
                  )}
                  {l.sourceActionOutcomeIds.length > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {l.sourceActionOutcomeIds.length} measured outcome
                      {l.sourceActionOutcomeIds.length === 1 ? "" : "s"} cited
                    </p>
                  )}
                </div>
                <RetireLearningButton learningId={l.id} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {retired.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-lg font-medium">Retired</h2>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {retired.map((l) => (
              <li key={l.id} className="rounded-md border border-dashed px-3 py-2">
                <span className="line-through">{l.statement}</span>
                {l.retiredReason ? ` — ${l.retiredReason}` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
