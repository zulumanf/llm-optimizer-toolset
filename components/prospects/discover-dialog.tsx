"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Radar } from "lucide-react";
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
import { runProspectDiscovery } from "@/app/prospects/actions";

export function DiscoverDialog({
  launches,
  providers,
}: {
  launches: { id: string; name: string }[];
  providers: string[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [launchId, setLaunchId] = useState<string>(launches[0]?.id ?? "");
  const [provider, setProvider] = useState<string>(providers[0] ?? "");
  const [segment, setSegment] = useState("");

  const submit = () => {
    startTransition(async () => {
      const result = await runProspectDiscovery({
        launchId,
        provider,
        segment: segment || undefined,
      });
      if (result.ok) {
        const { candidateCount } = result.data as { candidateCount: number };
        toast.success(`${candidateCount} candidate(s) found — review them below.`);
        setOpen(false);
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={launches.length === 0}>
          <Radar className="size-4" /> Discover
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Discover prospects</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Launch</Label>
              <Select value={launchId} onValueChange={setLaunchId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {launches.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="discover-segment">Segment / neighborhood (optional)</Label>
            <Input
              id="discover-segment"
              value={segment}
              onChange={(e) => setSegment(e.target.value)}
              placeholder="luxury condos, Brickell, …"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Results land as pending candidates with their source, retrieval date, and
            confidence — nothing becomes a prospect without your approval.
          </p>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={pending || !launchId || !provider}>
            {pending ? "Discovering…" : "Run discovery"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
