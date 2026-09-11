"use client";

import { Repeat } from "lucide-react";
import { replayDeadLetter } from "@/app/automation/actions";
import { Button } from "@/components/ui/button";
import { useAction } from "@/lib/hooks/use-action";

/**
 * Replay a dead-lettered delivery. Safe because consumption is idempotent: the
 * unique (event, subscription) index means a replay cannot start a second run of
 * work that already succeeded.
 */
export function ReplayDeadLetterButton({ attemptId }: { attemptId: string }) {
  const { pending, run } = useAction();

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        run(() => replayDeadLetter(attemptId), {
          success: (data) =>
            data.replayed
              ? "Re-armed. The next dispatch retries it."
              : "It was no longer dead-lettered.",
          refresh: true,
        })
      }
    >
      <Repeat className="mr-1.5 size-3.5" />
      {pending ? "Replaying…" : "Replay"}
    </Button>
  );
}
