"use client";

/**
 * Manual claim extraction for an already-held source (D3). Crawled pages
 * deliberately do not auto-extract — a fan-out must not silently spend
 * tokens on every page — so the operator chooses which sources are worth an
 * extraction pass.
 */
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { requestClaimExtraction } from "@/app/knowledge/actions";

export function ExtractClaimsButton({
  sourceArtifactId,
  projectId,
}: {
  sourceArtifactId: string;
  projectId: string;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 text-xs"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await requestClaimExtraction({ sourceArtifactId, projectId });
          if (result.ok) {
            toast.success(
              "Extraction queued — proposed claims land under Knowledge for review."
            );
          } else {
            toast.error(result.error.message);
          }
        })
      }
    >
      {pending ? "Queuing…" : "Extract claims"}
    </Button>
  );
}
