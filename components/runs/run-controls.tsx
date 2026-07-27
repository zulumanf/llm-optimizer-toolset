"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCcw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { retryFailedCells, cancelRun } from "@/app/runs/actions";
import type { RunStatus } from "@/db/runs";

interface Props {
  runId: string;
  status: RunStatus;
  hasFailures: boolean;
}

export function RunControls({ runId, status, hasFailures }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const act = (fn: () => Promise<{ ok: boolean; error?: { message: string } }>) =>
    startTransition(async () => {
      const result = await fn();
      if (result.ok) router.refresh();
      else toast.error(result.error?.message ?? "Action failed.");
    });

  const canRetry =
    hasFailures && ["partial", "completed", "failed"].includes(status);
  const canCancel = status === "pending" || status === "running";

  if (!canRetry && !canCancel) return null;

  return (
    <div className="flex shrink-0 gap-2">
      {canRetry && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => act(() => retryFailedCells({ runId }))}
        >
          <RotateCcw className="size-4" /> Retry failed
        </Button>
      )}
      {canCancel && (
        <Button
          size="sm"
          variant="destructive"
          disabled={pending}
          onClick={() => act(() => cancelRun({ runId }))}
        >
          <XCircle className="size-4" /> Cancel
        </Button>
      )}
    </div>
  );
}
