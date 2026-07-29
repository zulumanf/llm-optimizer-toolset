import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { attentionFeed, clientCostRollup } from "@/db/operations";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

const SEVERITY_VARIANT = {
  urgent: "destructive",
  attention: "default",
  info: "outline",
} as const;

const KIND_LABEL: Record<string, string> = {
  review_queue: "Review queue",
  run_failed: "Run failure",
  job_failed: "Job failure",
  accuracy_high: "Factual problem",
  scheduled_run_due: "Measurement due",
  approvals_waiting: "Approvals",
  content_waiting: "Content",
  cycle_halted: "Cycle stopped",
  no_subject: "Setup",
  no_baseline: "Setup",
  never_run: "Setup",
  stale_client: "Drift",
  gaps_open: "Opportunities",
};

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

export default async function OperationsPage() {
  const [{ items, metrics }, costs] = await Promise.all([
    attentionFeed(),
    clientCostRollup(),
  ]);

  const urgent = items.filter((i) => i.severity === "urgent");
  const attention = items.filter((i) => i.severity === "attention");
  const info = items.filter((i) => i.severity === "info");

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Today</h1>
        <Link
          href="/onboarding"
          className="text-sm text-muted-foreground underline hover:text-foreground"
        >
          Onboard a client
        </Link>
      </div>
      <p className="mb-6 text-sm text-muted-foreground">
        What needs you across every client, ordered by urgency. Severity is
        assigned by rule, not by feel — measurement breakage and live factual
        problems outrank queued work, which outranks setup hygiene.
      </p>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Tile
          label="Active clients"
          value={String(metrics.activeClients)}
          sub={`${metrics.clientsNeedingAttention} need attention`}
        />
        <Tile label="Runs (7d)" value={String(metrics.runs7d)} />
        <Tile
          label="Spend (7d)"
          value={`$${metrics.spend7d.toFixed(2)}`}
          sub={`$${metrics.spend30d.toFixed(2)} in 30d`}
        />
        <Tile
          label="Pending reviews"
          value={String(metrics.pendingReviews)}
          sub="blocks scoring"
        />
        <Tile
          label="Failed jobs"
          value={String(metrics.failedJobs)}
          sub={metrics.failedJobs > 0 ? "worker needs a look" : "queue healthy"}
        />
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
          <CheckCircle2 className="size-8 text-success" />
          <p className="text-sm text-muted-foreground">
            Nothing needs you right now across {metrics.activeClients} client
            {metrics.activeClients === 1 ? "" : "s"}.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {[
            { title: "Urgent", rows: urgent },
            { title: "Needs a decision", rows: attention },
            { title: "Hygiene & opportunities", rows: info },
          ]
            .filter((group) => group.rows.length > 0)
            .map((group) => (
              <section key={group.title}>
                <h2 className="mb-2 text-lg font-medium">
                  {group.title}{" "}
                  <span className="text-sm font-normal text-muted-foreground">
                    ({group.rows.length})
                  </span>
                </h2>
                <div className="divide-y rounded-lg border">
                  {group.rows.map((row, index) => (
                    <Link
                      key={`${row.projectId}-${row.kind}-${index}`}
                      href={row.href}
                      className="flex items-start gap-3 p-3 transition-colors hover:bg-accent/50"
                    >
                      <Badge
                        variant={SEVERITY_VARIANT[row.severity]}
                        className="mt-0.5 shrink-0"
                      >
                        {KIND_LABEL[row.kind] ?? row.kind}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{row.projectName}</p>
                        <p className="text-sm text-muted-foreground">{row.detail}</p>
                      </div>
                    </Link>
                  ))}
                </div>
              </section>
            ))}
        </div>
      )}

      {costs.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-lg font-medium">
            Cost per client{" "}
            <span className="text-sm font-normal text-muted-foreground">
              (provider spend — the margin input)
            </span>
          </h2>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs">
                <tr>
                  <th className="p-2">Client</th>
                  <th className="p-2 text-right">Runs (7d)</th>
                  <th className="p-2 text-right">Spend (7d)</th>
                  <th className="p-2 text-right">Spend (30d)</th>
                </tr>
              </thead>
              <tbody>
                {costs.map((row) => (
                  <tr key={row.projectId} className="border-t">
                    <td className="p-2">
                      <Link
                        href={`/projects/${row.projectId}`}
                        className="hover:underline"
                      >
                        {row.projectName}
                      </Link>
                    </td>
                    <td className="p-2 text-right tabular-nums">{row.runs7d}</td>
                    <td className="p-2 text-right tabular-nums">
                      ${row.spend7d.toFixed(2)}
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      ${row.spend30d.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Provider tokens only — search-tool fees are billed separately by the
            provider and are not included (docs/audits).
          </p>
        </section>
      )}
    </div>
  );
}
