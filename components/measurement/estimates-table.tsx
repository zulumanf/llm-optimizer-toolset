import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/layout/page";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { NamedEstimateRow } from "@/db/measurement";
import { INTERVAL_LABEL } from "@/lib/measurement/constants";
import { instrumentLabel, intervalText, METRIC_LABELS, pct } from "@/lib/measurement/format";

const SHOWN_METRICS = ["recommendation_rate", "mention_rate", "owned_citation_rate", "share_of_voice"];

/**
 * Per-model estimates with statistical intervals (spec 151). One row per
 * company × metric × model: never blended. The interval is statistical
 * (prompt-clustered bootstrap) and is NOT classifier confidence.
 */
export function EstimatesTable({ rows }: { rows: NamedEstimateRow[] }) {
  const shown = rows.filter((r) => SHOWN_METRICS.includes(r.metric));
  if (shown.length === 0) {
    return (
      <EmptyState message="No per-model estimates for this run yet. They appear once the run is scored under the current scoring version; older runs need a rescore (scripts/rescore.ts)." />
    );
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Company</TableHead>
            <TableHead>Metric</TableHead>
            <TableHead>Model</TableHead>
            <TableHead className="text-right">Estimate</TableHead>
            <TableHead className="text-right">{INTERVAL_LABEL}</TableHead>
            <TableHead className="text-right">Answers</TableHead>
            <TableHead className="text-right">Prompts</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((r) => (
            <TableRow key={`${r.companyId}-${r.metric}-${r.instrumentKey}`}>
              <TableCell className="text-sm">
                {r.companyName} {r.isSubject && <Badge variant="secondary">client</Badge>}
              </TableCell>
              <TableCell className="text-sm">{METRIC_LABELS[r.metric] ?? r.metric}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {instrumentLabel(r.provider, r.model)}
                {r.servedModels.length > 0 && r.servedModels.join(",") !== r.model && (
                  <span className="block">served: {r.servedModels.join(", ")}</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{pct(r.rate)}</TableCell>
              <TableCell className="text-right text-xs tabular-nums">
                {r.metric === "share_of_voice" ? "not a binomial rate" : intervalText(r.clusteredLow, r.clusteredHigh)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {r.numerator}/{r.denominator}
                {r.excludedEcho > 0 && (
                  <span className="block text-xs text-muted-foreground">{r.excludedEcho} echo answers excluded</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{r.distinctPrompts}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
