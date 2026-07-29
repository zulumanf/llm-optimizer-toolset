"use client";

/**
 * The durable approval control (spec 018 Part 6/9).
 *
 * Deciding here does two things atomically from the operator's point of view:
 * writes an immutable decision, and signals the paused workflow to resume. A
 * rationale is mandatory — an approval with no reason is not evidence, and
 * this queue exists to produce evidence.
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

export function ApprovalDecision({
  approvalId,
  summary,
  riskLevel,
  requiredRole,
  requestedAt,
  dueAt,
}: {
  approvalId: string;
  summary: string;
  riskLevel: string;
  requiredRole: string;
  requestedAt: string;
  dueAt: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rationale, setRationale] = useState("");

  const overdue = dueAt !== null && new Date(dueAt) < new Date();

  const decide = (decision: "approved" | "rejected") =>
    startTransition(async () => {
      const result = await decideApprovalAction({ approvalId, decision, rationale });
      if (result.ok) {
        toast.success(
          decision === "approved"
            ? "Approved — the workflow will resume."
            : "Rejected — the workflow will stop safely."
        );
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={riskLevel === "critical" || riskLevel === "high" ? "destructive" : "default"}>
            {riskLevel} risk
          </Badge>
          <Badge variant="outline">{requiredRole}</Badge>
          <span className="text-xs text-muted-foreground">
            requested {requestedAt.slice(0, 10)}
            {dueAt && (overdue ? ` · OVERDUE since ${dueAt.slice(0, 10)}` : ` · due ${dueAt.slice(0, 10)}`)}
          </span>
        </div>
        <p className="text-sm">{summary}</p>
        <div className="space-y-1">
          <Label htmlFor={`rationale-${approvalId}`}>
            Rationale <span className="text-muted-foreground">(required — it is recorded permanently)</span>
          </Label>
          <Textarea
            id={`rationale-${approvalId}`}
            value={rationale}
            onChange={(event) => setRationale(event.target.value)}
            placeholder="Why this decision?"
            rows={2}
          />
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => decide("approved")}
            disabled={pending || rationale.trim().length === 0}
          >
            Approve
          </Button>
          <Button
            variant="outline"
            onClick={() => decide("rejected")}
            disabled={pending || rationale.trim().length === 0}
          >
            Reject
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
