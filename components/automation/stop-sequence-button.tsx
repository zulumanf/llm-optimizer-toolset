"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CircleStop } from "lucide-react";
import { stopOutreachSequence } from "@/app/automation/actions";
import { Button } from "@/components/ui/button";

/**
 * Stop a sequence by hand. Permanent: a stopped sequence cannot be resumed, so
 * continuing requires creating a new one — which forces a fresh decision.
 */
export function StopSequenceButton({ sequenceId }: { sequenceId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await stopOutreachSequence({
            sequenceId,
            detail: "stopped by an operator from the outreach page",
          });
          if (!result.ok) {
            toast.error(result.error.message);
            return;
          }
          toast.success("Sequence stopped. Queued drafts were cancelled.");
          router.refresh();
        })
      }
    >
      <CircleStop className="mr-1.5 size-3.5" />
      {pending ? "Stopping…" : "Stop"}
    </Button>
  );
}
