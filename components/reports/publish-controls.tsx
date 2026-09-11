"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Lock, RefreshCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import {
  publishReport,
  regenerateReportDraft,
  deleteDraft,
} from "@/app/reports/actions";

interface Props {
  reportId: string;
  pendingReview: number;
  /** QA preflight (spec 065): warnings publish only when acknowledged;
   * blockers disable publish entirely. */
  preflightWarnings: string[];
  preflightBlockers: string[];
}

export function PublishControls({
  reportId,
  pendingReview,
  preflightWarnings,
  preflightBlockers,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [warningsAcknowledged, setWarningsAcknowledged] = useState(false);
  const [pending, startTransition] = useTransition();

  const act = (
    fn: () => Promise<{ ok: boolean; error?: { message: string } }>,
    done: string,
    redirect?: string
  ) =>
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        toast.success(done);
        setOpen(false);
        if (redirect) router.push(redirect);
        else router.refresh();
      } else {
        toast.error(result.error?.message ?? "Action failed.");
      }
    });

  return (
    <div className="flex gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          act(() => regenerateReportDraft({ reportId }), "Draft re-snapshotted.")
        }
      >
        <RefreshCcw className="size-4" /> Regenerate
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => act(() => deleteDraft({ reportId }), "Draft discarded.", "..")}
      >
        <Trash2 className="size-4" /> Discard
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogTrigger asChild>
          <Button size="sm" disabled={pending}>
            <Lock className="size-4" /> Publish
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish this report?</AlertDialogTitle>
            <AlertDialogDescription>
              Publishing runs the evidence gate (every numeric claim must carry
              a resolvable citation) and then locks the report forever — it
              becomes immutable at the database level.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {preflightBlockers.length > 0 && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
              <p className="font-medium">QA preflight blocks publishing:</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {preflightBlockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          )}
          {preflightWarnings.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
              <input
                type="checkbox"
                id="ack-preflight"
                checked={warningsAcknowledged}
                onChange={(e) => setWarningsAcknowledged(e.target.checked)}
                className="mt-0.5 size-4"
              />
              <Label htmlFor="ack-preflight" className="font-normal">
                I acknowledge {preflightWarnings.length} QA warning
                {preflightWarnings.length === 1 ? "" : "s"} (recorded in the
                audit log):
                <span className="mt-1 block text-xs text-muted-foreground">
                  {preflightWarnings.join(" · ")}
                </span>
              </Label>
            </div>
          )}
          {pendingReview > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
              <input
                type="checkbox"
                id="ack-pending"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-0.5 size-4"
              />
              <Label htmlFor="ack-pending" className="font-normal">
                I acknowledge {pendingReview} classification
                {pendingReview === 1 ? "" : "s"} in this period still await
                review and are flagged in coverage (recorded in the audit log).
              </Label>
            </div>
          )}
          <AlertDialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              disabled={
                pending ||
                preflightBlockers.length > 0 ||
                (pendingReview > 0 && !acknowledged) ||
                (preflightWarnings.length > 0 && !warningsAcknowledged)
              }
              onClick={() =>
                act(
                  () =>
                    publishReport({
                      reportId,
                      acknowledgePendingReviews: acknowledged,
                      acknowledgeWarnings: warningsAcknowledged,
                    }),
                  "Published — the report is now immutable."
                )
              }
            >
              {pending ? "Publishing…" : "Publish forever"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
