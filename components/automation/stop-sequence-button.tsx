"use client";

import { CircleStop } from "lucide-react";
import { stopOutreachSequence } from "@/app/automation/actions";
import { Button } from "@/components/ui/button";
import { useAction } from "@/lib/hooks/use-action";

/**
 * Stop a sequence by hand. Permanent: a stopped sequence cannot be resumed, so
 * continuing requires creating a new one — which forces a fresh decision.
 */
export function StopSequenceButton({ sequenceId }: { sequenceId: string }) {
  const { pending, run } = useAction();

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        run(
          () =>
            stopOutreachSequence({
              sequenceId,
              detail: "stopped by an operator from the outreach page",
            }),
          {
            success: "Sequence stopped. Queued drafts were cancelled.",
            refresh: true,
          }
        )
      }
    >
      <CircleStop className="mr-1.5 size-3.5" />
      {pending ? "Stopping…" : "Stop"}
    </Button>
  );
}
