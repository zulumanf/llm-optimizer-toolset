"use client";

/**
 * THE approval control (C2, docs/pilot-launch-plan.md).
 *
 * One component, one server action, for every surface that decides a
 * workflow approval — the inbox, the spec-018 run page, and the automation
 * run page. Two divergent copies previously enforced different rationale
 * rules and called different actions against the same table.
 *
 * Deciding does two things atomically from the operator's point of view:
 * writes an immutable decision, and signals the paused workflow to resume
 * (approve) or stop safely (reject). The rationale is mandatory because the
 * decision is evidence a client report may later rest on.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { decideApprovalAction } from "@/app/workflows/actions";

const MIN_RATIONALE_CHARS = 3;

interface ApprovalDecisionProps {
  approvalId: string;
  summary?: string;
  riskLevel?: string;
  requiredRole?: string;
  requestedAt?: string;
  dueAt?: string | null;
  /** Render only the decision controls — for embedding in a surface that
   * already shows the approval's context (badges, artifact, evidence). */
  compact?: boolean;
}

export function ApprovalDecision({
  approvalId,
  summary,
  riskLevel,
  requiredRole,
  requestedAt,
  dueAt,
  compact = false,
}: ApprovalDecisionProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rationale, setRationale] = useState("");

  const overdue = dueAt != null && new Date(dueAt) < new Date();
  const ready = rationale.trim().length >= MIN_RATIONALE_CHARS;

  const decide = (decision: "approved" | "rejected") =>
    startTransition(async () => {
      const result = await decideApprovalAction({ approvalId, decision, rationale });
      if (result.ok) {
        toast.success(
          decision === "approved"
            ? "Approved — the workflow resumes from here."
            : "Rejected — the workflow stops safely and nothing is sent."
        );
        setRationale("");
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });

  const controls = (
    <>
      <div className="space-y-1">
        <Label htmlFor={`rationale-${approvalId}`}>
          Rationale{" "}
          <span className="text-muted-foreground">
            (required — it is recorded permanently)
          </span>
        </Label>
        <Textarea
          id={`rationale-${approvalId}`}
          value={rationale}
          onChange={(event) => setRationale(event.target.value)}
          placeholder="What you checked, and what you concluded"
          rows={2}
        />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => decide("approved")} disabled={pending || !ready}>
          {pending ? "Recording…" : "Approve"}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => decide("rejected")}
          disabled={pending || !ready}
        >
          Reject
        </Button>
      </div>
    </>
  );

  if (compact) return <div className="space-y-3">{controls}</div>;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {riskLevel && (
            <Badge
              variant={
                riskLevel === "critical" || riskLevel === "high"
                  ? "destructive"
                  : "default"
              }
            >
              {riskLevel} risk
            </Badge>
          )}
          {requiredRole && <Badge variant="outline">{requiredRole}</Badge>}
          {requestedAt && (
            <span className="text-xs text-muted-foreground">
              requested {requestedAt.slice(0, 10)}
              {dueAt &&
                (overdue
                  ? ` · OVERDUE since ${dueAt.slice(0, 10)}`
                  : ` · due ${dueAt.slice(0, 10)}`)}
            </span>
          )}
        </div>
        {summary && <p className="text-sm">{summary}</p>}
        {controls}
      </CardContent>
    </Card>
  );
}
