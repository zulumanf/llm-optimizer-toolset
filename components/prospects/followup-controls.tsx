"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  pauseFollowupSequence,
  resumeFollowupSequence,
  setAllFollowupsPaused,
  stopFollowupSequence,
} from "@/app/prospects/actions";

type Result = { ok: true } | { ok: false; error: { message: string } };

function useAct(): [boolean, (label: string, fn: () => Promise<Result>) => void] {
  const [pending, start] = useTransition();
  const router = useRouter();
  const act = (label: string, fn: () => Promise<Result>): void => {
    start(async () => {
      const r = await fn();
      if (r.ok) {
        toast.success(label);
        router.refresh();
      } else toast.error(r.error.message);
    });
  };
  return [pending, act];
}

export function FollowupSequenceControls({
  sequenceId,
  status,
}: {
  sequenceId: string;
  status: "active" | "paused" | "replied" | "stopped" | "complete";
}) {
  const [pending, act] = useAct();
  const terminal = status === "replied" || status === "stopped" || status === "complete";
  return (
    <div className="flex flex-wrap gap-2">
      {status === "active" && (
        <Button size="sm" variant="outline" disabled={pending}
          onClick={() => act("Sequence paused", () => pauseFollowupSequence({ sequenceId, reason: "operator pause" }))}>
          Pause
        </Button>
      )}
      {status === "paused" && (
        <Button size="sm" variant="outline" disabled={pending}
          onClick={() => act("Sequence resumed", () => resumeFollowupSequence({ sequenceId }))}>
          Resume
        </Button>
      )}
      {!terminal && (
        <Button size="sm" variant="destructive" disabled={pending}
          onClick={() => {
            if (window.confirm("Cancel every future touch for this prospect? This cannot be undone.")) {
              act("Sequence stopped", () => stopFollowupSequence({ sequenceId, reason: "operator stop" }));
            }
          }}>
          Stop sequence
        </Button>
      )}
    </div>
  );
}

export function FollowupPauseAll({ activeCount, pausedAllCount }: { activeCount: number; pausedAllCount: number }) {
  const [pending, act] = useAct();
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={pending || activeCount === 0}
        onClick={() => {
          if (window.confirm(`Pause all ${activeCount} active follow-up sequences?`)) {
            act("All sequences paused", () => setAllFollowupsPaused({ paused: true }));
          }
        }}>
        Pause all ({activeCount})
      </Button>
      <Button size="sm" variant="outline" disabled={pending || pausedAllCount === 0}
        onClick={() => act("Sequences resumed", () => setAllFollowupsPaused({ paused: false }))}>
        Resume all ({pausedAllCount})
      </Button>
    </div>
  );
}
