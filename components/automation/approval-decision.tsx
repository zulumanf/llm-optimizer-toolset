"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { decideAutomationApproval } from "@/app/automation/actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

/**
 * Approve or reject, with a mandatory rationale.
 *
 * The rationale is not friction for its own sake: the decision becomes an
 * immutable record that a client report may later rest on, and "approved" with no
 * reason is not a decision anyone can defend a year later.
 */
export function ApprovalDecision({ approvalId }: { approvalId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rationale, setRationale] = useState("");

  function decide(decision: "approved" | "rejected") {
    startTransition(async () => {
      const result = await decideAutomationApproval({ approvalId, decision, rationale });
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      toast.success(
        decision === "approved"
          ? "Approved. The run resumes from here."
          : "Rejected. The run stops safely and nothing was sent."
      );
      setRationale("");
      router.refresh();
    });
  }

  const ready = rationale.trim().length >= 3;

  return (
    <div>
      <Label htmlFor={`rationale-${approvalId}`} className="text-xs">
        Rationale (recorded permanently)
      </Label>
      <Textarea
        id={`rationale-${approvalId}`}
        value={rationale}
        onChange={(event) => setRationale(event.target.value)}
        rows={2}
        placeholder="what you checked, and what you concluded"
        className="mt-1"
      />
      <div className="mt-2 flex gap-2">
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
    </div>
  );
}
