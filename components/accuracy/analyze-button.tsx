"use client";

import { ShieldAlert } from "lucide-react";
import { BackgroundAction } from "@/components/jobs/background-action";

export function AnalyzeAccuracyButton({
  runId,
  runLabel,
}: {
  runId: string;
  runLabel: string;
}) {
  return (
    <BackgroundAction
      type="analyze_accuracy"
      runId={runId}
      label={`Analyze "${runLabel}"`}
      workingLabel="Auditing answers…"
      icon={<ShieldAlert className="size-4" />}
    />
  );
}
