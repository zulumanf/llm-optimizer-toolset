/**
 * The approvals inbox (C2, docs/pilot-launch-plan.md).
 *
 * Every undecided workflow approval across every client, decidable inline —
 * previously approvals were only decidable from individual run pages, so an
 * operator had to know which runs were waiting. Ordered by urgency; recent
 * decisions stay visible below because they are the evidence trail.
 */
import Link from "next/link";
import {
  pendingApprovalsAcrossRuns,
  recentApprovalDecisions,
} from "@/db/workflow";
import { AUTOMATION_WORKFLOWS } from "@/lib/automation/workflows";
import { ApprovalDecision } from "@/components/approvals/approval-decision";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

/** The automation run page shows richer context (test actions, exceptions,
 * would-have-happened payloads); the spec-018 page fits its templates. */
function runHref(definitionKey: string, runId: string): string {
  const isAutomation = AUTOMATION_WORKFLOWS.some((w) => w.key === definitionKey);
  return isAutomation ? `/automation/runs/${runId}` : `/workflows/${runId}`;
}

export default async function ApprovalsPage() {
  const [pending, decided] = await Promise.all([
    pendingApprovalsAcrossRuns(),
    recentApprovalDecisions(10),
  ]);
  const now = Date.now();

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Approvals</h1>
        <p className="text-sm text-muted-foreground">
          {pending.length === 0
            ? "nothing waiting"
            : `${pending.length} waiting · ${
                pending.filter((a) => a.dueAt && a.dueAt.getTime() < now).length
              } overdue`}
        </p>
      </div>

      {pending.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          No approvals are waiting on you. Paused workflows appear here the
          moment they need a human decision.
        </div>
      ) : (
        <div className="space-y-4">
          {pending.map((approval) => (
            <div key={approval.id}>
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {approval.projectName ?? "Platform"}
                </span>
                <span>·</span>
                <Link
                  href={runHref(approval.definitionKey, approval.runId)}
                  className="underline-offset-2 hover:underline"
                >
                  {approval.definitionKey}
                </Link>
                <Badge variant="outline" className="text-[10px]">
                  {approval.actionType}
                </Badge>
              </div>
              <ApprovalDecision
                approvalId={approval.id}
                summary={approval.summary}
                riskLevel={approval.riskLevel}
                requiredRole={approval.requiredRole}
                requestedAt={approval.requestedAt.toISOString()}
                dueAt={approval.dueAt?.toISOString() ?? null}
              />
            </div>
          ))}
        </div>
      )}

      <section className="mt-10">
        <h2 className="mb-2 text-lg font-medium">Recent decisions</h2>
        {decided.length === 0 ? (
          <p className="text-sm text-muted-foreground">No decisions recorded yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {decided.map((d) => (
              <li key={d.id} className="flex items-start gap-3 p-3 text-sm">
                <Badge
                  variant={d.decision === "approved" ? "default" : "destructive"}
                  className="mt-0.5 shrink-0"
                >
                  {d.decision}
                </Badge>
                <div className="min-w-0">
                  <p className="truncate">
                    <span className="text-muted-foreground">
                      {d.projectName ?? "Platform"} ·{" "}
                    </span>
                    <Link
                      href={runHref(d.definitionKey, d.runId)}
                      className="underline-offset-2 hover:underline"
                    >
                      {d.summary}
                    </Link>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {d.decidedByName ?? "unknown"} ·{" "}
                    {d.decidedAt.toISOString().slice(0, 16).replace("T", " ")}
                    {d.rationale ? ` — “${d.rationale}”` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
