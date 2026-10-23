import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { portalResults } from "@/lib/portal/delivery";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Caveats, IntervalText, NoEngagement, PendingResults, RateStatement, SectionCard, pctText } from "@/components/portal/delivery-blocks";
import { formatDate } from "@/lib/format";
import type { SegmentRow } from "@/lib/engagements/delivery-rules";

export const dynamic = "force-dynamic";

function SegmentTable({ caption, rows }: { caption: string; rows: SegmentRow[] }) {
  if (rows.length === 0 || (rows.length === 1 && rows[0]!.segment === "Unspecified")) return null;
  return (
    <div className="overflow-x-auto">
      <h3 className="mb-1 text-sm font-medium" aria-hidden="true">{caption}</h3>
      <Table>
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Segment</TableHead>
            <TableHead scope="col" className="text-right">Questions</TableHead>
            <TableHead scope="col" className="text-right">Recommended</TableHead>
            <TableHead scope="col" className="text-right">Rate</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.segment}>
              <TableCell>{r.segment}</TableCell>
              <TableCell className="text-right tabular-nums">{r.questions}</TableCell>
              <TableCell className="text-right tabular-nums">{r.recommended} of {r.answers}</TableCell>
              <TableCell className="text-right tabular-nums">{r.rate === null ? "—" : pctText(r.rate)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

const CHANGE_LABEL = { gained: "Now recommended", lost: "No longer recommended", steady: "No change" } as const;

/** Results (spec 154): the locked baseline, the latest comparable
 * measurement, segments, competitors and every question with its original
 * answers. External tools appear separately and are never blended in. */
export default async function PortalResultsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const r = await portalResults(await getCurrentUser(), projectId);
  if (!r) return <NoEngagement />;
  const s = r.summary;
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">Results</h2>
        <p className="text-sm text-muted-foreground">How often AI answers actively recommend you, on the questions you approved.</p>
      </div>

      {s.status === "pending" || !s.baseline ? (
        <PendingResults nextMeasurementOn={s.nextMeasurementOn} protocolAccepted={Boolean(r.protocol)} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <SectionCard title="Starting point">
            <RateStatement rate={s.baseline} heading="Locked baseline" />
          </SectionCard>
          <SectionCard title="Latest comparable measurement">
            {s.latest && !s.latest.isBaseline ? (
              <div className="space-y-2">
                <RateStatement rate={s.latest} heading={`Comparability: ${s.latest.comparabilityGrade.replace(/_/g, " ")}`} />
                {s.change && (
                  <p className="text-sm">
                    Change: {s.change.delta >= 0 ? "+" : ""}{pctText(s.change.delta)}<IntervalText interval={s.change.interval} />. Observed movement, not proof of cause.
                  </p>
                )}
                {r.comparability && r.comparability.reasons.length > 0 && (
                  <p className="text-xs text-muted-foreground">Differences from the baseline: {r.comparability.reasons.join("; ")}.</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No later comparable measurement yet{s.nextMeasurementOn ? ` — next one ${formatDate(new Date(`${s.nextMeasurementOn}T12:00:00Z`))}` : ""}. No change is shown until one exists.</p>
            )}
          </SectionCard>
        </div>
      )}

      {r.nonComparable.length > 0 && (
        <p className="rounded-md border p-3 text-sm">
          {r.nonComparable.length} measurement(s) used a different instrument from the baseline and are not compared: {r.nonComparable.map((n) => `${formatDate(n.at)} (${n.reasons.join("; ") || "instrument differs"})`).join(" · ")}.
        </p>
      )}

      {r.segments && (
        <SectionCard title="By price band and neighborhood">
          <div className="space-y-4">
            <SegmentTable caption="Recommendations by price band" rows={r.segments.priceTier} />
            <SegmentTable caption="Recommendations by neighborhood" rows={r.segments.neighborhood} />
          </div>
        </SectionCard>
      )}

      {r.competitors.length > 0 && s.baseline && (
        <SectionCard title="Same questions, same answers: the names you are compared with">
          <ul className="space-y-1 text-sm">
            {r.competitors.map((c) => (
              <li key={c.name} className="flex justify-between gap-3 tabular-nums">
                <span>{c.name}</span>
                <span>{c.baseline} of {s.baseline!.answers} at baseline{c.latest !== null ? ` · ${c.latest} latest` : ""}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {r.questions.length > 0 && (
        <SectionCard title={`Every question (${r.questions.length})`}>
          <details>
            <summary className="cursor-pointer text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Show each question and read the original answers</summary>
            <ul className="mt-3 space-y-2">
              {r.questions.map((q) => (
                <li key={q.promptId} className="rounded-md border p-3 text-sm">
                  <p className="font-medium">{q.text}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {[q.priceTier, q.neighborhood].filter(Boolean).join(" · ")}{q.priceTier || q.neighborhood ? " · " : ""}
                    Recommended you in {q.recommended} of {q.answers}
                    {q.competitorRecommended.length > 0 ? ` · ${q.competitorRecommended.map((c) => `${c.name} ${c.count}`).join(", ")}` : ""}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {q.change && <Badge variant={q.change === "gained" ? "default" : q.change === "lost" ? "destructive" : "secondary"}>{CHANGE_LABEL[q.change]}</Badge>}
                    {q.responseIds.slice(0, 6).map((id, n) => (
                      <Link key={id} href={`/portal/${projectId}/answers/${id}`} className="text-xs underline-offset-2 hover:underline">Answer {n + 1}</Link>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </details>
        </SectionCard>
      )}

      {r.protocol && (
        <SectionCard title={`Agreed measurement protocol (v${r.protocol.version})`} action={{ href: `/portal/${projectId}/approvals#protocol`, label: "Full protocol" }}>
          <p className="text-sm">{r.protocol.providerLabel} · {r.protocol.model} · {r.protocol.repetitions} repetition(s) · {r.protocol.geographicContext}</p>
          <p className="mt-1 text-sm text-muted-foreground">Success criteria: {r.protocol.successCriteria}</p>
          <p className="mt-1 text-xs text-muted-foreground">Whether the success criteria are met is decided together under this protocol — not by this page.</p>
        </SectionCard>
      )}

      <SectionCard title="Independent measurements">
        {r.external.length === 0 ? (
          <p className="text-sm text-muted-foreground">None shared. Your results above do not depend on any third-party tool.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {r.external.map((x) => (
              <li key={x.id} className="rounded-md border p-3">
                <p className="font-medium">{x.providerLabel}{x.instrument ? ` — ${x.instrument}` : ""}</p>
                <p className="text-xs text-muted-foreground">
                  {x.capturedFrom} to {x.capturedTo}{x.promptCount !== null ? ` · ${x.promptCount} prompts` : ""} · {x.distinguishesRecommendation === "yes" ? "distinguishes recommendations from mentions" : "may count mentions, not only recommendations"} · checked by Recommended First
                </p>
                {x.summary && <p className="mt-1">{x.summary}</p>}
                <p className="mt-1 text-xs text-muted-foreground">A different instrument from ours; shown separately, never combined. {x.referenceUrl && <a className="underline" href={x.referenceUrl} rel="noopener noreferrer" target="_blank">Source</a>}</p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <Caveats caveats={r.caveats} />
    </div>
  );
}
