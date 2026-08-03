"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ClipboardList, Stamp } from "lucide-react";
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
import { approvePlan, composePlan } from "@/app/plans/actions";

/** Compose (or re-compose, superseding) the 90-day plan from open findings. */
export function ComposePlanButton({
  projectId,
  supersedes,
}: {
  projectId: string;
  supersedes: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant={supersedes ? "outline" : "default"}>
          <ClipboardList className="size-4" />
          {supersedes ? "Re-compose plan" : "Compose plan"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {supersedes ? "Re-compose the plan?" : "Compose a 90-day plan?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {supersedes
              ? "The current plan will be superseded — two live plans are two answers to the same question. The superseded plan stays readable."
              : "Plays are composed from this client's open gap findings with the current baseline snapshot. Exclusions are always shown with reasons."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await composePlan({ projectId });
                if (result.ok) {
                  toast.success("Plan composed.");
                  setOpen(false);
                  router.refresh();
                } else {
                  toast.error(result.error.message);
                }
              })
            }
          >
            {pending ? "Composing…" : "Compose"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ApprovePlanButton({ planId }: { planId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await approvePlan({ planId });
          if (result.ok) {
            toast.success("Plan approved — client export is now enabled.");
            router.refresh();
          } else {
            toast.error(result.error.message);
          }
        })
      }
    >
      <Stamp className="size-4" />
      {pending ? "Approving…" : "Approve plan"}
    </Button>
  );
}
