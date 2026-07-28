"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createBriefFromFinding } from "@/app/content/actions";

interface Props {
  findings: { id: string; label: string }[];
}

export function NewBriefButton({ findings }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [findingId, setFindingId] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); setError(null); }}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={findings.length === 0}>
          <Sparkles className="size-4" /> New brief from finding
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Brief a content asset</DialogTitle>
          <DialogDescription>
            The brief agent picks the asset type and outline from the gap
            finding and your approved claims only. Takes ~30s.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Gap finding to address</Label>
          <Select value={findingId} onValueChange={setFindingId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent>
              {findings.map((f) => (
                <SelectItem key={f.id} value={f.id}>{f.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={pending || !findingId}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const result = await createBriefFromFinding({ findingId });
                if (result.ok) {
                  toast.success("Brief created.");
                  setOpen(false);
                  router.push(`content/${result.data.assetId}`);
                } else {
                  setError(result.error.message);
                }
              })
            }
          >
            {pending ? "Briefing…" : "Create brief"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
