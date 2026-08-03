"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { computeProspectScore, overrideProspectScore } from "@/app/prospects/actions";

export function ScoreActions({
  prospectId,
  hasScore,
  hasOverride,
}: {
  prospectId: string;
  hasScore: boolean;
  hasOverride: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [score, setScore] = useState("");
  const [reason, setReason] = useState("");

  const compute = () => {
    startTransition(async () => {
      const result = await computeProspectScore({ prospectId });
      if (result.ok) {
        const value = (result.data as { score: number | null }).score;
        toast.success(
          value === null
            ? "Computed — nothing measurable yet; the breakdown says what is missing."
            : `Score computed: ${value}.`
        );
      } else toast.error(result.error.message);
    });
  };

  const clearOverride = () => {
    startTransition(async () => {
      const result = await overrideProspectScore({
        prospectId,
        score: null,
        reason: "Override cleared — computed score stands.",
      });
      if (result.ok) toast.success("Override cleared.");
      else toast.error(result.error.message);
    });
  };

  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={compute} disabled={pending}>
        {hasScore ? "Recompute" : "Compute score"}
      </Button>
      {hasOverride ? (
        <Button variant="ghost" size="sm" onClick={clearOverride} disabled={pending}>
          Clear override
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOverrideOpen(true)}
          disabled={pending}
        >
          Override
        </Button>
      )}

      <Dialog open={overrideOpen} onOpenChange={setOverrideOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Override the prospect score</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="override-score">Score (0–100)</Label>
              <Input
                id="override-score"
                type="number"
                min={0}
                max={100}
                value={score}
                onChange={(e) => setScore(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="override-reason">Reason (recorded permanently)</Label>
              <Input
                id="override-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why the computed score is wrong for this prospect"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              The computed score is kept and shown alongside the override.
            </p>
          </div>
          <DialogFooter>
            <Button
              disabled={pending || score === "" || reason.trim().length < 3}
              onClick={() => {
                setOverrideOpen(false);
                startTransition(async () => {
                  const result = await overrideProspectScore({
                    prospectId,
                    score: Number(score),
                    reason,
                  });
                  if (result.ok) toast.success("Override recorded.");
                  else toast.error(result.error.message);
                });
              }}
            >
              Record override
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
