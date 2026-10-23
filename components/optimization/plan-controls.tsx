"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  buildPlanAction,
  prepareMeasurementAction,
  runInitialAnalysisAction,
  transitionOpportunityAction,
} from "@/app/projects/[id]/optimization/actions";

type Result = { ok: true; data: unknown } | { ok: false; error: { message: string } };

function useAction() {
  const [pending, start] = useTransition();
  const go = (fn: () => Promise<Result>, success: string) =>
    start(async () => {
      const r = await fn();
      if (r.ok) toast.success(success);
      else toast.error(r.error.message);
    });
  return { pending, go };
}

export function BuildPlanButton({ projectId }: { projectId: string }) {
  const { pending, go } = useAction();
  return (
    <Button variant="outline" disabled={pending} onClick={() => go(() => buildPlanAction({ projectId }), "Plan refreshed.")}>
      {pending ? "Refreshing…" : "Refresh plan from findings"}
    </Button>
  );
}

export function InitialAnalysisButton({ projectId }: { projectId: string }) {
  const { pending, go } = useAction();
  return (
    <Button variant="outline" disabled={pending} onClick={() => go(() => runInitialAnalysisAction({ projectId }), "Analysis done and plan built.")}>
      {pending ? "Analyzing…" : "Run initial analysis"}
    </Button>
  );
}

export function PrepareMeasurementForm({
  projectId,
  versions,
}: {
  projectId: string;
  versions: { id: string; label: string }[];
}) {
  const { pending, go } = useAction();
  const [versionId, setVersionId] = useState(versions[0]?.id ?? "");
  const [budget, setBudget] = useState("10");
  if (versions.length === 0) {
    return <p className="text-sm text-muted-foreground">Freeze a prompt set first; baseline waves measure a frozen version.</p>;
  }
  return (
    <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
      <div className="grid gap-1">
        <Label htmlFor="prep-version">Prompt set version</Label>
        <Select value={versionId} onValueChange={setVersionId}>
          <SelectTrigger id="prep-version">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {versions.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="prep-budget">Budget per wave (USD)</Label>
        <Input id="prep-budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
      </div>
      <Button
        disabled={pending || !versionId}
        onClick={() =>
          go(
            () => prepareMeasurementAction({ projectId, promptSetVersionId: versionId, budgetUsdPerWave: Number(budget) }),
            "Instrument pinned, cohort frozen, wave 1 started, wave 2 scheduled in 7 days."
          )
        }
      >
        {pending ? "Starting…" : "Prepare measurement"}
      </Button>
      <p className="text-xs text-muted-foreground sm:col-span-3">
        Starts a paid run now on the pinned instrument and schedules a second one in 7 days.
      </p>
    </div>
  );
}

const NEXT: Record<string, { to: string; label: string }[]> = {
  proposed: [{ to: "approved", label: "Approve" }, { to: "dismissed", label: "Dismiss" }],
  approved: [{ to: "in_progress", label: "Start" }, { to: "dismissed", label: "Dismiss" }],
  in_progress: [{ to: "implemented", label: "Mark implemented" }, { to: "dismissed", label: "Dismiss" }],
  implemented: [],
  measuring: [{ to: "closed", label: "Close" }],
  closed: [],
  dismissed: [{ to: "proposed", label: "Reopen" }],
};

export function OpportunityTransition({ opportunityId, status }: { opportunityId: string; status: string }) {
  const { pending, go } = useAction();
  const [note, setNote] = useState("");
  const moves = NEXT[status] ?? [];
  if (moves.length === 0) {
    return status === "implemented" ? (
      <span className="text-xs text-muted-foreground">Link the intervention to start measuring.</span>
    ) : null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {moves.some((m) => m.to === "dismissed") && (
        <Input aria-label="Reason" placeholder="Reason (required to dismiss)" value={note} onChange={(e) => setNote(e.target.value)} className="h-8 w-48 text-xs" />
      )}
      {moves.map((m) => (
        <Button
          key={m.to}
          size="sm"
          variant={m.to === "approved" ? "default" : "outline"}
          disabled={pending}
          onClick={() => go(() => transitionOpportunityAction({ opportunityId, to: m.to, note: note || undefined }), `${m.label}: done.`)}
        >
          {m.label}
        </Button>
      ))}
    </div>
  );
}
