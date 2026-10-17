import { StatGrid, Stat } from "@/components/layout/page";
import type { GoldReport } from "@/lib/evaluation/gold";
import { intervalText, pct } from "@/lib/measurement/format";

/** Classifier precision/recall vs human truth (unanimous or adjudicated pairs only). */
export function GoldReportView({ report }: { report: GoldReport }) {
  const r = report.recommended;
  const m = report.mentioned;
  return (
    <div className="grid gap-3">
      <StatGrid columns={4}>
        <Stat label="Recommended: precision" value={pct(r.precision)} hint={`95% CI ${intervalText(r.precisionInterval?.[0], r.precisionInterval?.[1])}`} />
        <Stat label="Recommended: recall" value={pct(r.recall)} hint={`95% CI ${intervalText(r.recallInterval?.[0], r.recallInterval?.[1])}`} />
        <Stat label="Mentioned: precision" value={pct(m.precision)} hint={`95% CI ${intervalText(m.precisionInterval?.[0], m.precisionInterval?.[1])}`} />
        <Stat label="Mentioned: recall" value={pct(m.recall)} hint={`95% CI ${intervalText(m.recallInterval?.[0], m.recallInterval?.[1])}`} />
      </StatGrid>
      <p className="text-xs text-muted-foreground tabular-nums">
        {r.validatedPairs} of {report.items} pairs validated (two agreeing people, or adjudicated) · {r.singleAnnotatorPairs} labelled by one
        person only (not counted) · {r.disputedPairs} disputed · agreement between annotators (kappa, recommended):{" "}
        {report.kappaRecommended === null ? "n/a" : report.kappaRecommended.toFixed(2)}
      </p>
    </div>
  );
}
