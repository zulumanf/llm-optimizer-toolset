"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createBenchmarkProject,
  generateFindings,
  linkBenchmark,
} from "@/app/prospects/actions";

interface RunOption {
  id: string;
  label: string;
  projectName: string;
  status: string;
}

export function BenchmarkLink({
  prospectId,
  runs,
}: {
  prospectId: string;
  runs: RunOption[];
}) {
  const [pending, startTransition] = useTransition();
  const [runId, setRunId] = useState("");

  const submit = () => {
    startTransition(async () => {
      const result = await linkBenchmark({ prospectId, runId });
      if (result.ok) toast.success("Benchmark linked.");
      else toast.error(result.error.message);
    });
  };

  if (runs.length === 0) return null;

  return (
    <div className="flex items-center gap-2">
      <Select value={runId} onValueChange={setRunId}>
        <SelectTrigger className="w-72">
          <SelectValue placeholder="Link a scored run…" />
        </SelectTrigger>
        <SelectContent>
          {runs.map((r) => (
            <SelectItem key={r.id} value={r.id}>
              {r.label} · {r.projectName} ({r.status})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" variant="outline" onClick={submit} disabled={pending || !runId}>
        {pending ? "Linking…" : "Link run"}
      </Button>
    </div>
  );
}

/** Phase 2.1: mint a dedicated kind='prospect' project so a fresh benchmark
 * can be configured and run when no existing run covers this company. */
export function CreateBenchmarkProjectButton({ prospectId }: { prospectId: string }) {
  const [pending, startTransition] = useTransition();
  const create = () => {
    startTransition(async () => {
      const result = await createBenchmarkProject({ prospectId });
      if (result.ok) {
        toast.success(
          `Benchmark project created (${result.data.competitorsTracked} competitor(s) pre-tracked). Build the prompt set, then run.`
        );
      } else toast.error(result.error.message);
    });
  };
  return (
    <Button size="sm" variant="outline" onClick={create} disabled={pending}>
      {pending ? "Creating…" : "Create benchmark project"}
    </Button>
  );
}

export function GenerateFindingsButton({ benchmarkId }: { benchmarkId: string }) {
  const [pending, startTransition] = useTransition();
  const generate = () => {
    startTransition(async () => {
      const result = await generateFindings({ benchmarkId });
      if (result.ok) {
        toast.success(
          result.data.candidateCount > 0
            ? `${result.data.candidateCount} candidate finding(s) generated.`
            : "No defensible findings in this data — the sample may be too small or the gap too narrow."
        );
      } else toast.error(result.error.message);
    });
  };
  return (
    <Button size="sm" variant="outline" onClick={generate} disabled={pending}>
      {pending ? "Analyzing…" : "Generate findings"}
    </Button>
  );
}
