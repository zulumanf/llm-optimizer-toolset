"use client";

/**
 * Settle a contradiction (D2, docs/pilot-launch-plan.md). The detector
 * could raise contradictions but nothing could ever resolve one — the queue
 * only grew. Resolution requires a note: "settled" with no record of how is
 * a contradiction waiting to be re-litigated.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { resolveClaimContradiction } from "@/app/knowledge/actions";

export function ResolveContradiction({ contradictionId }: { contradictionId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState("");
  const [pending, startTransition] = useTransition();

  const ready = resolution.trim().length >= 3;

  const submit = (status: "resolved" | "dismissed") =>
    startTransition(async () => {
      const result = await resolveClaimContradiction({
        contradictionId,
        status,
        resolution,
      });
      if (result.ok) {
        toast.success(
          status === "resolved" ? "Contradiction resolved." : "Contradiction dismissed."
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
        className="mt-2 h-7 text-xs"
        onClick={() => setOpen(true)}
      >
        Settle…
      </Button>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border p-2">
      <Textarea
        value={resolution}
        onChange={(event) => setResolution(event.target.value)}
        rows={2}
        placeholder="How was it settled? e.g. approved the corrected claim with effective dates"
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
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
