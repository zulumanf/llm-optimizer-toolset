import { Section } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { MeasurementSection } from "@/lib/reports/measurement-v2";
import { intervalText, METRIC_LABELS, pct } from "@/lib/measurement/format";

const VERDICT_LABEL: Record<string, string> = {
  improvement_observed: "improvement observed",
  no_detectable_change: "no detectable change",
  negative_change_observed: "negative change observed",
  inconclusive: "inconclusive",
  not_comparable: "not comparable",
};

const points = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)} pts`);

/** Report v2 measurement block: per model, with intervals; nulls shown. */
export function MeasurementSectionView({ m }: { m: MeasurementSection }) {
  const subject = m.estimates.filter((e) => e.isSubject);
  return (
    <Section title="Measured visibility, by AI model" description="Share of sampled answers, with a 95% statistical interval over prompts.">
      {subject.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead>Metric</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead className="text-right">95% interval</TableHead>
              <TableHead className="text-right">Answers</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {subject.map((e) => (
              <TableRow key={`${e.model}-${e.metric}`}>
                <TableCell className="text-xs">{e.provider} · {e.model}</TableCell>
                <TableCell className="text-sm">{METRIC_LABELS[e.metric] ?? e.metric}</TableCell>
                <TableCell className="text-right tabular-nums">{pct(e.rate)}</TableCell>
                <TableCell className="text-right text-xs tabular-nums">{intervalText(e.low, e.high)}</TableCell>
                <TableCell className="text-right tabular-nums">{e.numerator}/{e.denominator}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {m.changes.length > 0 && (
        <ul className="mt-3 grid gap-1 text-sm">
          {m.changes.map((c) => (
            <li key={`${c.provider}-${c.model}`} className="tabular-nums">
              <span className="text-xs text-muted-foreground">{c.provider} · {c.model}:</span>{" "}
              {c.status === "measured" ? `${points(c.estimate)} recommended since last run (95% interval ${points(c.low)} to ${points(c.high)}, ${c.prompts} prompts)` : c.note}
            </li>
          ))}
        </ul>
      )}
      {m.mde && m.mde.value !== null && (
        <p className="mt-2 text-xs text-muted-foreground tabular-nums">
          With {m.mde.prompts} prompts × {m.mde.repetitions} answers, a change smaller than about {(m.mde.value * 100).toFixed(0)} points is unlikely to be detected.
        </p>
      )}
      {m.experiments.length > 0 && (
        <ul className="mt-3 grid gap-1 text-sm">
          {m.experiments.map((x) => (
            <li key={x.planId}>
              <Badge variant="secondary">{VERDICT_LABEL[x.verdict] ?? x.verdict}</Badge> {x.interventionType.replaceAll("_", " ")} — {x.explanation}
            </li>
          ))}
        </ul>
      )}
      {m.outcomes.length > 0 && (
        <ul className="mt-3 grid gap-1 text-sm tabular-nums">
          {m.outcomes.map((o) => (
            <li key={o.periodStart}>
              {o.periodStart} → {o.periodEnd}: {o.qualifiedLeads ?? "—"} qualified leads
              {o.aiDiscoveryMentions !== null && `, ${o.aiDiscoveryMentions} said AI`} ({o.provenance === "self_reported" ? "client-reported" : "client system"})
            </li>
          ))}
        </ul>
      )}
      {m.nextActions.length > 0 && (
        <ol className="mt-3 list-decimal pl-5 text-sm">
          {m.nextActions.map((a) => <li key={a.title}>{a.title}: {a.recommendedAction}</li>)}
        </ol>
      )}
      <ul className="mt-3 list-disc pl-5 text-xs text-muted-foreground">
        {m.limitations.map((l) => <li key={l}>{l}</li>)}
      </ul>
    </Section>
  );
}
