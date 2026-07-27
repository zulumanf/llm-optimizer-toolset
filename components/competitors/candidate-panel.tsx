"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  trackBrandCandidate,
  dismissBrandCandidate,
} from "@/app/competitors/actions";
import type { BrandCandidate } from "@/db/competitors";

interface Props {
  projectId: string;
  candidates: BrandCandidate[];
}

export function CandidatePanel({ projectId, candidates }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const act = (fn: () => Promise<{ ok: boolean; error?: { message: string } }>, done: string) =>
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        toast.success(done);
        router.refresh();
      } else {
        toast.error(result.error?.message ?? "Action failed.");
      }
    });

  return (
    <div className="flex flex-wrap gap-2">
      {candidates.map((candidate) => (
        <div
          key={candidate.id}
          className="flex items-center gap-2 rounded-md border px-3 py-2"
        >
          <span className="text-sm font-medium">{candidate.name}</span>
          <Badge variant="outline">{candidate.hitCount} hits</Badge>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              act(
                () =>
                  trackBrandCandidate({
                    candidateId: candidate.id,
                    projectId,
                    tier: "secondary",
                  }),
                "Tracked — backfilling recent runs."
              )
            }
          >
            Track
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              act(
                () => dismissBrandCandidate({ candidateId: candidate.id }),
                "Dismissed."
              )
            }
          >
            Dismiss
          </Button>
        </div>
      ))}
    </div>
  );
}
