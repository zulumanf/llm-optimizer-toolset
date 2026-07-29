"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Repeat } from "lucide-react";
import { replayDeadLetter } from "@/app/automation/actions";
import { Button } from "@/components/ui/button";

/**
 * Replay a dead-lettered delivery. Safe because consumption is idempotent: the
 * unique (event, subscription) index means a replay cannot start a second run of
 * work that already succeeded.
 */
export function ReplayDeadLetterButton({ attemptId }: { attemptId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await replayDeadLetter(attemptId);
          if (!result.ok) {
            toast.error(result.error.message);
            return;
          }
          toast.success(
            result.data.replayed
              ? "Re-armed. The next dispatch retries it."
              : "It was no longer dead-lettered."
          );
          router.refresh();
        })
      }
    >
      <Repeat className="mr-1.5 size-3.5" />
      {pending ? "Replaying…" : "Replay"}
    </Button>
  );
}
