import { getCurrentUser } from "@/lib/auth";
import { portalPlan } from "@/lib/portal/delivery";
import { Badge } from "@/components/ui/badge";
import { SectionCard, dayText } from "@/components/portal/delivery-blocks";
import { WORK_STATE_LABELS, type WorkState } from "@/lib/engagements/delivery-rules";
import { formatDate } from "@/lib/format";
import { requirePortalPage } from "@/lib/security/page-gates";

export const dynamic = "force-dynamic";

const STATE_VARIANT: Record<WorkState, "default" | "secondary" | "outline" | "destructive"> = {
  proposed: "secondary",
  in_progress: "default",
  blocked: "destructive",
  completed: "outline",
  dropped: "secondary",
};

/** The client's 90-day plan (spec 154): published plans only, by phase,
 * with owner, date, why, dependencies and proof of delivery. */
export default async function PortalPlanPage({ params }: { params: Promise<{ projectId: string }> }) {
  await requirePortalPage((await params).projectId);
  const { projectId } = await params;
  const plan = await portalPlan(await getCurrentUser(), projectId);
  if (!plan) {
    return (
      <div className="space-y-2">
        <h2 className="text-lg font-medium">90-day plan</h2>
        <p className="rounded-md border border-dashed p-8 text-sm text-muted-foreground">
          Your plan is built from your measured starting point and reviewed with you before it appears here.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">{plan.title}</h2>
        <p className="text-sm text-muted-foreground">{plan.publishedAt ? `Published ${formatDate(plan.publishedAt)}. ` : ""}What we will do, when, who owns it, and the proof once it is done.</p>
      </div>
      {plan.phases.map((ph) => (
        <SectionCard key={ph.key} title={`${ph.label} · ${ph.title}`}>
          <p className="mb-3 text-xs tabular-nums text-muted-foreground">
            {dayText(ph.from)} – {dayText(ph.to)} · {ph.progress.completed} of {ph.progress.total} done{ph.progress.blocked > 0 ? ` · ${ph.progress.blocked} waiting` : ""}
          </p>
          {ph.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing scheduled in this phase yet.</p>
          ) : (
            <ul className="space-y-2">
              {ph.items.map((i) => (
                <li key={i.id} className="rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="font-medium">{i.title}</p>
                    <Badge variant={STATE_VARIANT[i.state]}>{WORK_STATE_LABELS[i.state]}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">Owner: {i.owner}{i.dueOn ? ` · due ${dayText(i.dueOn)}` : ""}{i.dependsOn.length > 0 ? ` · after: ${i.dependsOn.join(", ")}` : ""}</p>
                  {i.waitingNote && <p className="mt-1">Waiting: {i.waitingNote}</p>}
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Why this is in the plan</summary>
                    <p className="mt-1 text-muted-foreground">{i.why}</p>
                    {i.evidenceCount > 0 && <p className="mt-1 text-xs text-muted-foreground">Backed by {i.evidenceCount} stored answer(s).</p>}
                  </details>
                  {i.state === "completed" && (
                    <p className="mt-1 break-words text-xs">
                      {i.now ? `Now: ${i.now}` : "Delivered."}
                      {i.targetUrl && <> · <a className="underline" href={i.targetUrl} rel="noopener noreferrer" target="_blank">where</a></>}
                      {i.proofUrl && <> · <a className="underline" href={i.proofUrl} rel="noopener noreferrer" target="_blank">proof</a></>}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      ))}
    </div>
  );
}
