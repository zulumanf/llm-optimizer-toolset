"use client";

import { ScanSearch } from "lucide-react";
import { BackgroundAction } from "@/components/jobs/background-action";

export function AnalyzeRunButton({ runId, runLabel }: { runId: string; runLabel: string }) {
  return (
    <BackgroundAction
      type="analyze_gaps"
      runId={runId}
      label={`Analyze "${runLabel}"`}
      workingLabel="Analyzing…"
      icon={<ScanSearch className="size-4" />}
    />
  );
}
