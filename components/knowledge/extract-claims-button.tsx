"use client";

/**
 * Manual claim extraction for an already-held source (D3). Crawled pages
 * deliberately do not auto-extract — a fan-out must not silently spend
 * tokens on every page — so the operator chooses which sources are worth an
 * extraction pass.
 */
import { Button } from "@/components/ui/button";
import { useAction } from "@/lib/hooks/use-action";
import { requestClaimExtraction } from "@/app/knowledge/actions";

export function ExtractClaimsButton({
  sourceArtifactId,
  projectId,
}: {
  sourceArtifactId: string;
  projectId: string;
}) {
  const { pending, run } = useAction();
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 text-xs"
      disabled={pending}
      onClick={() =>
        run(() => requestClaimExtraction({ sourceArtifactId, projectId }), {
          success:
            "Extraction queued — proposed claims land under Knowledge for review.",
        })
      }
    >
      {pending ? "Queuing…" : "Extract claims"}
    </Button>
  );
}
