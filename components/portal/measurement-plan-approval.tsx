"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { approveMeasurementPlan } from "@/app/portal/[projectId]/actions";
import { ONBOARDING_COPY } from "@/lib/portal/client-copy";

/**
 * The binding approval (spec 155 R3). The ONE place in the portal that uses a
 * confirmation dialog: approving fixes the exact questions and how success is
 * measured for the whole engagement, so it deserves a deliberate second step.
 */
export function MeasurementPlanApproval({
  projectId,
  versionId,
  protocolId,
  questionCount,
  setLabel,
}: {
  projectId: string;
  versionId: string;
  protocolId: string;
  questionCount: number;
  setLabel: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const router = useRouter();

  const approve = () => {
    setError(null);
    start(async () => {
      try {
        const r = await approveMeasurementPlan(projectId, versionId, protocolId, true);
        if (r.ok) router.refresh();
        else setError(r.error.message);
      } catch {
        setError(ONBOARDING_COPY.genericError);
      }
    });
  };

  return (
    <div className="space-y-3">
      <AlertDialog onOpenChange={(open) => !open && setChecked(false)}>
        <AlertDialogTrigger asChild>
          <Button className="h-11 w-full sm:w-auto" disabled={pending}>
            {pending ? "Approving…" : "Approve measurement plan"}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve your measurement plan?</AlertDialogTitle>
            <AlertDialogDescription>
              This fixes these {questionCount} questions ({setLabel}) and how success is measured for the whole
              engagement. Every result — your starting point and every later measurement — uses exactly this plan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-foreground"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            <span>I&apos;ve reviewed the questions, what counts as a recommendation, the method and the success target.</span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11">Not yet</AlertDialogCancel>
            <AlertDialogAction className="h-11" disabled={!checked || pending} onClick={approve}>
              Approve
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
