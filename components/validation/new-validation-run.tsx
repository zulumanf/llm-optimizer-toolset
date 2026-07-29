"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ClipboardCheck } from "lucide-react";
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
import { createClientValidationRun } from "@/app/evidence/actions";

interface Props {
  projectId: string;
  versions: { id: string; label: string }[];
}

export function NewValidationRunButton({ projectId, versions }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [versionId, setVersionId] = useState(versions[0]?.id ?? "");
  const [count, setCount] = useState("5");
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); setError(null); }}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={versions.length === 0}>
          <ClipboardCheck className="size-4" /> New validation run
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a client validation run</DialogTitle>
          <DialogDescription>
            Prompts are drawn from the frozen set with a recorded seed, so the
            selection is reproducible and demonstrably not cherry-picked.
            Holdout prompts are excluded.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Frozen benchmark version</Label>
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
          <div className="w-40 space-y-1.5">
            <Label htmlFor="vr-count">Prompts to sample</Label>
            <Input
              id="vr-count"
              type="number"
              min={1}
              max={20}
              value={count}
              onChange={(e) => setCount(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={pending || !versionId}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const result = await createClientValidationRun({
                  projectId,
                  promptSetVersionId: versionId,
                  promptCount: Number(count),
                });
                if (result.ok) {
                  toast.success(
                    `Validation run created (seed ${result.data.seed}).`
                  );
                  setOpen(false);
                  router.refresh();
                } else {
                  setError(result.error.message);
                }
              })
            }
          >
            {pending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
