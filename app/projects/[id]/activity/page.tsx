import { PageHeader, PageShell } from "@/components/layout/page";
import { notFound } from "next/navigation";
import { History } from "lucide-react";
import { getProject } from "@/db/projects";
import { projectActivity } from "@/db/audit";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

/** "audit_log speak" → operator language: "task.approve" reads as
 * "task · approve". The raw action stays visible — this is a record, not
 * a narrative. */
function actionParts(action: string): { entity: string; verb: string } {
  const dot = action.indexOf(".");
  if (dot === -1) return { entity: "", verb: action };
  return { entity: action.slice(0, dot), verb: action.slice(dot + 1) };
}

export default async function ProjectActivityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();
  const rows = await projectActivity(id);

  const byDay = new Map<string, typeof rows>();
  for (const row of rows) {
    const day = new Date(row.at).toLocaleDateString(undefined, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(row);
  }

  return (
    <PageShell>
      <PageHeader
        crumbs={[{ label: "Projects", href: "/projects" }, { label: project.name, href: `/projects/${id}` }, { label: "Activity" }]}
        title="Activity"
        description={
          <>
          Everything recorded for this client, newest first — the answer to
          &quot;what did we do in March?&quot; without reconstructing it from
          memory. Rows older than Aug 2026 were labeled retroactively; a few
          platform-level actions may be absent.
          </>
        }
      />
      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
          <History className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Nothing recorded yet. Every material change — runs, tasks,
            reports, approvals — lands here as it happens.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {[...byDay.entries()].map(([day, dayRows]) => (
            <section key={day}>
              <h2 className="mb-2 text-sm font-medium text-muted-foreground">{day}</h2>
              <ul className="space-y-1">
                {dayRows.map((row) => {
                  const { entity, verb } = actionParts(row.action);
                  return (
                    <li
                      key={row.id}
                      className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm"
                    >
                      <span className="tabular-nums text-xs text-muted-foreground">
                        {new Date(row.at).toLocaleTimeString(undefined, {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      {entity && <Badge variant="outline">{entity.replaceAll("_", " ")}</Badge>}
                      <span>{verb.replaceAll("_", " ")}</span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {row.userName ?? "system"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </PageShell>
  );
}
