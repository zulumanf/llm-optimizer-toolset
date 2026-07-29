"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { queueRunJob, pollRunJobs } from "@/app/jobs/actions";
import type { BackgroundJobType } from "@/lib/jobs/enqueue";

/**
 * A button that hands work to the job queue and watches it (UX pass).
 * The page stays usable and the operator can navigate away — the work
 * survives, because it lives in Postgres rather than in a request.
 */
export function BackgroundAction({
  type,
  runId,
  label,
  workingLabel,
  icon,
  variant = "default",
  requiresWorkerNote = true,
}: {
  type: BackgroundJobType;
  runId: string;
  label: string;
  workingLabel: string;
  icon?: React.ReactNode;
  variant?: "default" | "outline" | "secondary";
  requiresWorkerNote?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [watching, setWatching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    const result = await pollRunJobs({ runId, types: [type] });
    if (!result.ok) return;
    const [latest] = result.data.jobs;
    if (!latest || latest.status === "queued" || latest.status === "running") {
      timer.current = setTimeout(poll, 2500);
      return;
    }
    setWatching(false);
    if (latest.status === "done") {
      toast.success(`${label} finished.`);
      router.refresh();
    } else if (latest.status === "failed") {
      toast.error(
        `${label} failed: ${latest.lastError?.slice(0, 160) ?? "unknown error"}`
      );
    }
  }, [runId, type, label, router]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant={variant}
        disabled={pending || watching}
        onClick={() =>
          startTransition(async () => {
            const result = await queueRunJob({ type, runId });
            if (!result.ok) {
              toast.error(result.error.message);
              return;
            }
            setWatching(true);
            toast.success(
              result.data.alreadyQueued
                ? `${label} is already running — watching it.`
                : `${label} queued. You can keep working.`
            );
            timer.current = setTimeout(poll, 2000);
          })
        }
      >
        {watching ? (
          <>
            <Loader2 className="size-4 animate-spin" /> {workingLabel}
          </>
        ) : (
          <>
            {icon} {label}
          </>
        )}
      </Button>
      {watching && requiresWorkerNote && (
        <span className="text-[11px] text-muted-foreground">
          runs in the worker · safe to navigate away
        </span>
      )}
    </div>
  );
}
