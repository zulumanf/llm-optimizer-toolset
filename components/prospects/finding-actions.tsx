"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { reviewFinding } from "@/app/prospects/actions";

export function FindingActions({ findingId }: { findingId: string }) {
  const [pending, startTransition] = useTransition();

  const review = (decision: "approved" | "rejected", makePrimary: boolean) => {
    startTransition(async () => {
      const result = await reviewFinding({ findingId, decision, makePrimary });
      if (result.ok) {
        toast.success(decision === "approved" ? "Finding approved." : "Finding rejected.");
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" onClick={() => review("approved", true)} disabled={pending}>
        Approve as primary
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => review("approved", false)}
        disabled={pending}
      >
        Approve
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => review("rejected", false)}
        disabled={pending}
      >
        Reject
      </Button>
    </div>
  );
}
