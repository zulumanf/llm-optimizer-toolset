"use client";

import { Check, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAction } from "@/lib/hooks/use-action";
import {
  createTaskFromSiteFinding,
  dismissSiteFinding,
  reopenSiteFinding,
} from "@/app/technical/actions";

export function FindingActions({
  findingId,
  status,
}: {
  findingId: string;
  status: "open" | "task_created" | "dismissed";
}) {
  const { pending, run } = useAction();

  const act = (
    action: (
      input: unknown
    ) => Promise<{ ok: true; data: unknown } | { ok: false; error?: { message: string } }>,
    success: string
  ) => run(() => action({ findingId }), { success });

  if (status === "task_created") return null;
  if (status === "dismissed") {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => act(reopenSiteFinding, "Reopened.")}
      >
        <Undo2 className="size-4" /> Reopen
      </Button>
    );
  }
  return (
    <div className="flex shrink-0 gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => act(createTaskFromSiteFinding, "Task suggested.")}
      >
        <Check className="size-4" /> Create task
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        aria-label="Dismiss finding"
        onClick={() => act(dismissSiteFinding, "Dismissed.")}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
