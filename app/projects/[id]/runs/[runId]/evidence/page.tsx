import { PageHeader, PageShell } from "@/components/layout/page";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRun } from "@/db/runs";
import { sql } from "@/db/client";
import { Badge } from "@/components/ui/badge";
import {
  drilldown,
  DRILLDOWN_METRICS,
  type DrilldownMetric,
} from "@/lib/evidence/observations";
import { verifyRunIntegrity } from "@/lib/evidence/integrity";
import { SCORING_VERSION } from "@/lib/constants";
import { formatDate } from "@/lib/format";
import { EvidenceTools } from "@/components/evidence/evidence-tools";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "positive", label: "Positive" },
  { key: "negative", label: "Negative" },
  { key: "recommended", label: "Recommended" },
  { key: "top3", label: "Top three" },
  { key: "reviewed", label: "Needs/had review" },
] as const;

export default async function EvidencePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; runId: string }>;
  searchParams: Promise<{ metric?: string; company?: string; provider?: string; filter?: string }>;
}) {
  const { id: projectId, runId } = await params;
  const search = await searchParams;
  const run = await getRun(runId);
  if (!run || run.projectId !== projectId) notFound();

  const metric: DrilldownMetric = (DRILLDOWN_METRICS as readonly string[]).includes(
    search.metric ?? ""
  )
    ? (search.metric as DrilldownMetric)
    : "mention_rate";
  const filter = search.filter ?? "all";

  const result = await drilldown({
    runId,
    metric,
    companyId: search.company,
    provider: search.provider,
    scoringVersion: SCORING_VERSION,
  });
  if (!result) notFound();

  const integrity = await verifyRunIntegrity(runId);
  const tampered =
    integrity.mismatchedResponses.length + integrity.mismatchedArtifacts.length;

  const [latestExport] = await sql`
    select id, sha256 from evidence_exports
    where run_id = ${runId} and status = 'completed'
    order by completed_at desc limit 1
  `;

  const companies = await sql`
    select distinct c.id, c.name from scores s join companies c on c.id = s.company_id
    where s.run_id = ${runId} order by c.name
  `;
  const providers = [...new Set(result.rows.map((r) => r.provider))];

  const visible = result.rows.filter((r) => {
    if (filter === "positive") return r.positive;
    if (filter === "negative") return !r.positive;
    if (filter === "recommended") return r.recommended;
    if (filter === "top3") return r.topThree;
    if (filter === "reviewed") return r.needsReview;
    return true;
  });

  const href = (patch: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    const merged = { metric, company: search.company, provider: search.provider, filter, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v && v !== "all") q.set(k, v);
    const qs = q.toString();
    return `/projects/${projectId}/runs/${runId}/evidence${qs ? `?${qs}` : ""}`;
  };

  return (
    <PageShell>
      <PageHeader
        crumbs={[
          { label: run.label, href: `/projects/${projectId}/runs/${runId}` },
          { label: "evidence" },
        ]}
        title={`${result.companyName} — ${metric.replace(/_/g, " ")}`}
        description={
          <>
          <span className="mt-1 block text-2xl font-semibold tabular-nums text-foreground">
            {result.numerator} / {result.denominator}
            <span className="ml-3 text-sm text-muted-foreground">
              {result.value == null ? "—" : `${(result.value * 100).toFixed(1)}%`}
            </span>
          </span>
          <span className="mt-1 block text-xs">
            Every eligible observation is listed below — the {result.numerator}{" "}
            positives and the {result.denominator - result.numerator} negatives.
            Scoring {SCORING_VERSION} ·{" "}
            {run.startedAt ? formatDate(run.startedAt) : ""}
            {result.storedValue != null && (
              <>
                {" "}· stored score{" "}
                {result.matchesStored ? (
                  <span className="text-success">reproduced exactly</span>
                ) : (
                  <span className="text-destructive">
                    MISMATCH (stored {(result.storedValue * 100).toFixed(1)}% of{" "}
                    {result.storedSampleSize})
                  </span>
                )}
              </>
            )}
            {" "}· integrity:{" "}
            {tampered === 0 ? (
              <span className="text-success">
                {integrity.checkedResponses} hashes verified
              </span>
            ) : (
              <span className="text-destructive">{tampered} MISMATCHES</span>
            )}
          </span>
          </>
        }
        actions={
          <EvidenceTools
            runId={runId}
            projectId={projectId}
            latestExport={
              latestExport
                ? {
                    exportId: latestExport.id as string,
                    sha256: latestExport.sha256 as string,
                  }
                : null
            }
          />
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        {DRILLDOWN_METRICS.map((m) => (
          <Link key={m} href={href({ metric: m, filter: "all" })}>
            <Badge variant={m === metric ? "default" : "outline"}>
              {m.replace(/_/g, " ")}
            </Badge>
          </Link>
        ))}
        <span className="mx-1 text-muted-foreground">·</span>
        {companies.map((c) => (
          <Link key={c.id as string} href={href({ company: c.id as string })}>
            <Badge
              variant={
                (search.company ?? result.companyId) === c.id ? "default" : "outline"
              }
            >
              {c.name as string}
            </Badge>
          </Link>
        ))}
        <span className="mx-1 text-muted-foreground">·</span>
        <Link href={href({ provider: undefined })}>
          <Badge variant={!search.provider ? "default" : "outline"}>all providers</Badge>
        </Link>
        {providers.map((p) => (
          <Link key={p} href={href({ provider: p })}>
            <Badge variant={search.provider === p ? "default" : "outline"}>{p}</Badge>
          </Link>
        ))}
        <span className="mx-1 text-muted-foreground">·</span>
        {FILTERS.map((f) => (
          <Link key={f.key} href={href({ filter: f.key })}>
            <Badge variant={filter === f.key ? "secondary" : "outline"}>{f.label}</Badge>
          </Link>
        ))}
      </div>

      <div className="mb-6 overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs">
            <tr>
              <th className="p-2">Prompt</th>
              <th className="p-2">Category</th>
              <th className="p-2">Provider · model</th>
              <th className="p-2">Rep</th>
              <th className="p-2">Result</th>
              <th className="p-2">Pos</th>
              <th className="p-2">Confidence</th>
              <th className="p-2">Review</th>
              <th className="p-2">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.responseId} className="border-t">
                <td className="max-w-md truncate p-2">{r.promptText}</td>
                <td className="p-2">
                  {r.promptCategory}
                  {r.isHoldout && <Badge variant="outline" className="ml-1">holdout</Badge>}
                </td>
                <td className="p-2">{r.provider} · {r.model}</td>
                <td className="p-2 tabular-nums">{r.repetition}</td>
                <td className="p-2">
                  {r.positive ? (
                    <Badge>{metric === "mention_rate" ? "mentioned" : metric === "recommendation_rate" ? "recommended" : "cited"}</Badge>
                  ) : (
                    <Badge variant="outline">absent</Badge>
                  )}
                </td>
                <td className="p-2 tabular-nums">{r.listPosition ?? "—"}</td>
                <td className="p-2 tabular-nums">
                  {r.confidence == null ? "—" : r.confidence.toFixed(2)}
                </td>
                <td className="p-2">{r.needsReview ? "pending" : "clear"}</td>
                <td className="p-2">
                  <Link
                    href={`/projects/${projectId}/runs/${runId}/responses/${r.responseId}`}
                    className="text-xs underline"
                  >
                    raw
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mb-8 text-xs text-muted-foreground">
        Showing {visible.length} of {result.denominator} eligible observations
        {filter !== "all" ? ` (filter: ${filter})` : ""} · errors are excluded
        from denominators (docs/06); holdout observations listed separately
        below.
      </p>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Per-prompt stability</h2>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs">
              <tr>
                <th className="p-2">Exact prompt</th>
                <th className="p-2">Appearances</th>
                <th className="p-2">Label</th>
              </tr>
            </thead>
            <tbody>
              {result.perPrompt.map((p) => (
                <tr key={p.promptId} className="border-t">
                  <td className="max-w-md truncate p-2">
                    {p.promptText}
                    {p.isHoldout && <Badge variant="outline" className="ml-1">holdout</Badge>}
                  </td>
                  <td className="p-2 tabular-nums">
                    {p.stability.appearances} of {p.stability.observations}
                  </td>
                  <td className="p-2">
                    <Badge
                      variant={
                        p.stability.label === "established"
                          ? "default"
                          : p.stability.label === "absent"
                            ? "outline"
                            : "secondary"
                      }
                    >
                      {p.stability.label}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {result.holdoutRows.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-2 text-lg font-medium">
            Holdout observations ({result.holdoutRows.length})
          </h2>
          <p className="text-xs text-muted-foreground">
            Excluded from all standard metric denominators; reported separately:
            {" "}{result.holdoutRows.filter((r) => r.positive).length} of{" "}
            {result.holdoutRows.length} positive for this metric.
          </p>
        </section>
      )}
    </PageShell>
  );
}
