import { portalReports } from "@/lib/portal/service";
import { portalUpdates } from "@/lib/portal/delivery";
import { getCurrentUser } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { SectionCard, dayText } from "@/components/portal/delivery-blocks";
import { formatDate } from "@/lib/format";
import { requirePortalPage } from "@/lib/security/page-gates";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = { welcome: "Welcome", weekly: "Weekly update", final_review: "Day-90 review" };

/** Reports (spec 031 + 154): the archive of updates we sent, check-ins with
 * notes and action items, and published reports. Drafts never appear. The
 * CSV/HTML downloads ride the existing project-scoped routes. */
export default async function PortalReportsPage({ params }: { params: Promise<{ projectId: string }> }) {
  await requirePortalPage((await params).projectId);
  const { projectId } = await params;
  const user = await getCurrentUser();
  const [reports, updates] = await Promise.all([portalReports(user, projectId), portalUpdates(user, projectId)]);

  return (
    <div className="space-y-6">
      {updates && (
        <>
          <SectionCard title="Updates we sent you">
            {updates.updates.length === 0 ? (
              <p className="text-sm text-muted-foreground">Your first weekly update arrives at the end of week one.</p>
            ) : (
              <ul className="space-y-2">
                {updates.updates.map((u) => (
                  <li key={u.id}>
                    <details className="rounded-md border p-3">
                      <summary className="cursor-pointer text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <span className="font-medium">{KIND_LABEL[u.kind] ?? u.kind}</span>
                        <span className="text-muted-foreground">{u.periodEnd ? ` · week ending ${dayText(u.periodEnd)}` : ""}{u.sentAt ? ` · sent ${formatDate(u.sentAt)}` : ""}</span>
                      </summary>
                      <div className="mt-2 space-y-2 text-sm">
                        {u.body.sections.map((s) => (
                          <div key={s.title}>
                            <p className="font-medium">{s.title}</p>
                            {s.lines.length === 0 ? <p className="text-muted-foreground">Nothing to report.</p> : (
                              <ul className="list-disc break-words pl-5">{s.lines.map((l, n) => <li key={n}>{l}</li>)}</ul>
                            )}
                          </div>
                        ))}
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Check-ins">
            <p className="mb-2 text-sm text-muted-foreground">We meet every two weeks{updates.nextCheckinDue ? `; the next is due around ${dayText(updates.nextCheckinDue)}` : ""}.</p>
            {updates.meetings.length === 0 ? (
              <p className="text-sm text-muted-foreground">No check-ins scheduled yet.</p>
            ) : (
              <ul className="space-y-2">
                {updates.meetings.map((m) => (
                  <li key={m.id} className="rounded-md border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{m.kind === "kickoff" ? "Kickoff" : m.kind === "final_review" ? "Day-90 review" : "Check-in"} · {formatDate(m.scheduledFor)}</span>
                      <Badge variant={m.status === "held" ? "outline" : "secondary"}>{m.status === "held" ? "Held" : "Upcoming"}</Badge>
                    </div>
                    {m.agenda && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Agenda</summary>
                        <p className="mt-1 whitespace-pre-line text-muted-foreground">{m.agenda}</p>
                      </details>
                    )}
                    {m.notes && <p className="mt-2 whitespace-pre-line">{m.notes}</p>}
                    {m.actionItems.length > 0 && (
                      <ul className="mt-2 list-disc pl-5">
                        {m.actionItems.map((a, n) => <li key={n}>{a.owner === "client" ? "You" : "Recommended First"}: {a.text}{a.dueOn ? ` (by ${dayText(a.dueOn)})` : ""}</li>)}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </>
      )}

      <SectionCard title="Published reports">
        {reports.length === 0 ? (
          <p className="text-sm text-muted-foreground">No published reports yet.</p>
        ) : (
          <ul className="space-y-2">
            {reports.map((report) => (
              <li key={report.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
                <div>
                  <p className="font-medium">{report.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {report.periodStart} → {report.periodEnd} · published {formatDate(report.publishedAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{report.kind.replace(/_/g, " ")}</Badge>
                  <a className="text-xs underline hover:no-underline" href={`/api/reports/${report.id}/html`} target="_blank" rel="noopener noreferrer">View report</a>
                  <a className="text-xs underline hover:no-underline" href={`/api/reports/${report.id}/csv`}>CSV</a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
