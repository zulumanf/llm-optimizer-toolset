import { EmptyState } from "@/components/layout/page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { RosterMetric, RosterRow } from "@/lib/organizations/service";
import { intervalText, pct } from "@/lib/measurement/format";

function cell(metrics: RosterMetric[]) {
  if (metrics.length === 0) return <span className="text-muted-foreground">not measured</span>;
  return (
    <ul className="grid gap-1">
      {metrics.map((m) => (
        <li key={`${m.provider}-${m.model}`} className="tabular-nums">
          {pct(m.rate)} <span className="text-xs text-muted-foreground">({intervalText(m.low, m.high)}) · {m.numerator}/{m.denominator} · {m.provider}</span>
        </li>
      ))}
    </ul>
  );
}

/** Read-only roster: each member's latest market-benchmark estimates, per AI model, with 95% intervals. */
export function RosterTable({ rows }: { rows: RosterRow[] }) {
  if (rows.length === 0) return <EmptyState message="No agents or teams in this organization yet." />;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Agent or team</TableHead>
            <TableHead>Market</TableHead>
            <TableHead>Recommended by AI</TableHead>
            <TableHead>Mentioned by AI</TableHead>
            <TableHead>Measured</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.companyId}>
              <TableCell className="text-sm">
                {r.name} <span className="block text-xs text-muted-foreground">{r.level}</span>
              </TableCell>
              <TableCell className="text-sm">{r.market ?? "—"}</TableCell>
              <TableCell className="text-sm">{cell(r.recommended)}</TableCell>
              <TableCell className="text-sm">{cell(r.mentioned)}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{r.measuredAt ? r.measuredAt.toLocaleDateString() : "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export const ROSTER_NOTE =
  "Share of sampled answers from AI models queried through their APIs for local buyer questions, with a 95% statistical interval. It describes what the models said in the sample, not how many buyers saw it.";
