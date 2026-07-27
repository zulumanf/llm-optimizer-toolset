"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy } from "lucide-react";
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
import { duplicatePromptSet } from "@/app/prompts/actions";

interface Props {
  sourceSetId?: string;
  sourceVersionId?: string;
  sourceName: string;
}

/** Duplicates a live set — or seeds a new set from a frozen version. */
export function DuplicateSetDialog({ sourceSetId, sourceVersionId, sourceName }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(`${sourceName} (copy)`);
  const [error, setErrorMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); setErrorMsg(null); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Copy className="size-4" /> Duplicate
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Duplicate {sourceVersionId ? "from version" : "set"}</DialogTitle>
          <DialogDescription>
            Prompts are copied into a new working set. Frozen versions are not
            carried over.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="dup-name">New set name</Label>
          <Input id="dup-name" value={name} onChange={(e) => setName(e.target.value)} />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={pending || name.trim().length === 0}
            onClick={() =>
              startTransition(async () => {
                const result = await duplicatePromptSet({
                  setId: sourceSetId,
                  versionId: sourceVersionId,
                  newName: name,
                });
                if (result.ok) {
                  toast.success("Set duplicated.");
                  setOpen(false);
                  router.push(
                    `/projects/${result.data.projectId}/prompts/${result.data.id}`
                  );
                } else {
                  setErrorMsg(result.error.message);
                }
              })
            }
          >
            {pending ? "Duplicating…" : "Duplicate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
