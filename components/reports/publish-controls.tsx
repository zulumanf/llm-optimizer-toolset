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
}

export function PublishControls({ reportId, pendingReview }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
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
              disabled={pending || (pendingReview > 0 && !acknowledged)}
              onClick={() =>
                act(
                  () =>
                    publishReport({
                      reportId,
                      acknowledgePendingReviews: acknowledged,
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
