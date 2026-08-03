"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createIntervention } from "@/app/attribution/actions";

const OFFSETS = ["+2w", "+6w", "+12w"] as const;

interface Props {
  projectId: string;
  versions: { id: string; label: string }[];
}

export function CreateInterventionDialog({ projectId, versions }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState("");
  const [shippedAt, setShippedAt] = useState(new Date().toISOString().slice(0, 10));
  const [urls, setUrls] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [versionId, setVersionId] = useState(versions[0]?.id ?? "");
  const [offsets, setOffsets] = useState<string[]>([...OFFSETS]);
  const [error, setError] = useState<string | null>(null);

  const submit = () =>
    startTransition(async () => {
      setError(null);
      const result = await createIntervention({
        projectId,
        title,
        shippedAt,
        urls: urls
          .split(/[,\n]/)
          .map((u) => u.trim())
          .filter((u) => u.length > 0),
        promptSetVersionId: versionId,
        postOffsets: offsets,
        hypothesis: hypothesis.trim() || undefined,
      });
      if (result.ok) {
        toast.success(
          result.data.baselineWeak
            ? "Recorded — baseline is weak (fewer than 2 runs ≥1 week apart), flagged on the verdicts."
            : `Recorded — ${result.data.baselineRunIds.length} baseline runs, ${result.data.scheduledOffsets.length} post runs scheduled.`
        );
        setOpen(false);
        router.push(`/projects/${projectId}/interventions/${result.data.interventionId}`);
      } else {
        setError(result.error.message);
      }
    });

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); setError(null); }}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" /> Record intervention
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record an intervention</DialogTitle>
          <DialogDescription>
            Baselines are the two most recent completed runs of the target
            version before the ship date; post runs re-run the same frozen
            instrument on schedule.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="int-title">What shipped</Label>
            <Input
              id="int-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Comparison page: Lumina vs Acme"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="int-hypothesis">Hypothesis (optional)</Label>
            <Input
              id="int-hypothesis"
              value={hypothesis}
              onChange={(e) => setHypothesis(e.target.value)}
              placeholder="The comparison page should lift recommendation rate for comparison prompts"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="int-date">Shipped on</Label>
              <Input
                id="int-date"
                type="date"
                value={shippedAt}
                onChange={(e) => setShippedAt(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Target frozen version</Label>
              <Select value={versionId} onValueChange={setVersionId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  {versions.map((v) => (
                    <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="int-urls">URLs (comma-separated, optional)</Label>
            <Input
              id="int-urls"
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              placeholder="https://lumina.com/vs/acme"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Post runs</Label>
            <div className="flex gap-4">
              {OFFSETS.map((offset) => (
                <label key={offset} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={offsets.includes(offset)}
                    onChange={(e) =>
                      setOffsets((prev) =>
                        e.target.checked
                          ? [...prev, offset]
                          : prev.filter((o) => o !== offset)
                      )
                    }
                    className="size-4"
                  />
                  {offset}
                </label>
              ))}
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={pending || !versionId || title.trim().length === 0}
          >
            {pending ? "Recording…" : "Record"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
