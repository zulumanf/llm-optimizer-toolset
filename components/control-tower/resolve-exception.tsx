"use client";

/**
 * Inline exception resolution (C3, docs/pilot-launch-plan.md).
 *
 * Exceptions were surfaced in three places and resolvable in none — the
 * resolve actions existed with zero UI callers, so the queue only ever grew.
 * This is the single resolve control: a short expander with a mandatory
 * resolution note, because "resolved" with no record of what was done is a
 * silent failure with paperwork.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { resolveExceptionAction } from "@/app/workflows/actions";

export function ResolveException({ exceptionId }: { exceptionId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState("");
  const [pending, startTransition] = useTransition();

  const ready = resolution.trim().length >= 3;

  const submit = (status: "resolved" | "dismissed") =>
    startTransition(async () => {
      const result = await resolveExceptionAction({ exceptionId, status, resolution });
      if (result.ok) {
        toast.success(
          status === "resolved" ? "Exception resolved." : "Exception dismissed."
        );
        setOpen(false);
        setResolution("");
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });

  if (!open) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        onClick={() => setOpen(true)}
      >
        Resolve…
      </Button>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border p-2">
      <Textarea
        value={resolution}
        onChange={(event) => setResolution(event.target.value)}
        rows={2}
        placeholder="What was done about it? (recorded permanently)"
        className="text-sm"
      />
      <div className="flex gap-2">
        <Button size="sm" onClick={() => submit("resolved")} disabled={pending || !ready}>
          {pending ? "Recording…" : "Resolved"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => submit("dismissed")}
          disabled={pending || !ready}
        >
          Dismiss
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
