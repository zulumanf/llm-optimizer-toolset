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
import { addAuthoritySignal } from "@/app/prospects/actions";
import {
  AUTHORITY_SIGNAL_KINDS,
  PROVENANCE_LABELS,
  SIGNAL_SOURCE_TYPES,
} from "@/lib/prospects/constants";

export function SignalDialog({ prospectId }: { prospectId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState<string>("ranking");
  const [label, setLabel] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [provenance, setProvenance] = useState<string>("publicly_sourced");
  const [sourceType, setSourceType] = useState<string>("unclassified");
  const [scope, setScope] = useState<string>("local");

  const submit = () => {
    startTransition(async () => {
      const result = await addAuthoritySignal({
        prospectId,
        kind,
        label,
        sourceUrl: sourceUrl || undefined,
        provenance,
        sourceType: sourceType === "unclassified" ? undefined : sourceType,
        scope,
      });
      if (result.ok) {
        toast.success("Signal recorded.");
        setOpen(false);
        setLabel("");
        setSourceUrl("");
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="size-4" /> Add signal
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add authority signal</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Kind</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTHORITY_SIGNAL_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k.replaceAll("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="signal-label">Statement</Label>
            <Input
              id="signal-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Ranked #3 Manhattan team by 2025 closed volume (The Real Deal)"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="signal-source">Source URL</Label>
            <Input
              id="signal-source"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://…"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Market scope</Label>
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">local — this market</SelectItem>
                <SelectItem value="global">global — brand/nationwide</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Global evidence is shown for context but never counted as local authority.
            </p>
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
              Verified needs a source URL. Estimated and AI-inferred are labeled as such everywhere.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Evidence classification</Label>
            <Select value={sourceType} onValueChange={setSourceType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unclassified">unclassified</SelectItem>
                {SIGNAL_SOURCE_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t.replaceAll("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Sponsored coverage and self-reported claims are kept but badged
              and weighted below independent sources on the audit page.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={pending || !label.trim()}>
            {pending ? "Saving…" : "Save signal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
