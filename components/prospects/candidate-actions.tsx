"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { confirmCompanyLink, reviewDiscoveryCandidate } from "@/app/prospects/actions";

export function CandidateActions({ candidateId }: { candidateId: string }) {
  const [pending, startTransition] = useTransition();

  const review = (decision: "approve" | "dismiss") => {
    startTransition(async () => {
      const result = await reviewDiscoveryCandidate({ candidateId, decision });
      if (result.ok) {
        const { outcome } = result.data as { outcome: string };
        toast.success(
          outcome === "approved"
            ? "Prospect created."
            : outcome === "duplicate"
              ? "Already in this launch — recorded as duplicate."
              : "Candidate dismissed."
        );
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <div className="flex items-center gap-1">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => review("approve")}>
        Approve
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => review("dismiss")}>
        Dismiss
      </Button>
    </div>
  );
}

export function ConfirmLinkButton({
  prospectId,
  companyId,
  companyName,
}: {
  prospectId: string;
  companyId: string;
  companyName: string;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await confirmCompanyLink({ prospectId, companyId });
          if (result.ok) toast.success(`Linked to ${companyName}.`);
          else toast.error(result.error.message);
        })
      }
    >
      {pending ? "Linking…" : `Link to ${companyName}`}
    </Button>
  );
}
