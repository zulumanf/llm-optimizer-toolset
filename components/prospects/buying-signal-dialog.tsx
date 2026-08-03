"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import { addBuyingSignal, archiveBuyingSignal } from "@/app/prospects/actions";
import { BUYING_SIGNAL_KINDS, PROVENANCE_LABELS } from "@/lib/prospects/constants";

export function BuyingSignalDialog({ prospectId }: { prospectId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState<string>("team_expansion");
  const [label, setLabel] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [observedOn, setObservedOn] = useState("");
  const [provenance, setProvenance] = useState<string>("publicly_sourced");

  const submit = () => {
    startTransition(async () => {
      const result = await addBuyingSignal({
        prospectId,
        kind,
        label,
        sourceUrl,
        observedOn,
        provenance,
      });
      if (result.ok) {
        toast.success("Buying signal recorded.");
        setOpen(false);
        setLabel("");
        setSourceUrl("");
        setObservedOn("");
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="size-4" /> Add buying signal
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add buying signal</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Kind</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BUYING_SIGNAL_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k.replaceAll("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="buying-label">What happened</Label>
            <Input
              id="buying-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Posted a marketing-manager opening on LinkedIn"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="buying-source">Source URL (required)</Label>
              <Input
                id="buying-source"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://…"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="buying-date">Observed on (required)</Label>
              <Input
                id="buying-date"
                type="date"
                value={observedOn}
                onChange={(e) => setObservedOn(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Provenance</Label>
            <Select value={provenance} onValueChange={setProvenance}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVENANCE_LABELS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p.replaceAll("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              No source or date, no signal — both are required, and score contribution
              decays as the signal ages.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={submit}
            disabled={pending || !label.trim() || !sourceUrl.trim() || !observedOn}
          >
            {pending ? "Saving…" : "Save signal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ArchiveBuyingSignalButton({ signalId }: { signalId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await archiveBuyingSignal({ signalId });
          if (result.ok) toast.success("Signal archived.");
          else toast.error(result.error.message);
        })
      }
    >
      Archive
    </Button>
  );
}
