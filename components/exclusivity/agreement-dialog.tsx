"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
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
import { createAgreement } from "@/app/exclusivity/actions";

interface ScopeDraft {
  marketId: string;
  marketLabel: string;
  serviceCategory: string;
  segment: string;
}

interface Props {
  projects: { id: string; name: string }[];
  markets: { id: string; name: string; parentName: string | null }[];
}

export function AgreementDialog({ projects, markets }: Props) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [projectId, setProjectId] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [graceDays, setGraceDays] = useState("0");
  const [scopes, setScopes] = useState<ScopeDraft[]>([]);
  const [scopeMarket, setScopeMarket] = useState("");
  const [scopeCategory, setScopeCategory] = useState("");
  const [scopeSegment, setScopeSegment] = useState("");

  const addScope = () => {
    const market = markets.find((m) => m.id === scopeMarket);
    if (!market) {
      toast.error("Pick a market for the scope.");
      return;
    }
    setScopes((prev) => [
      ...prev,
      {
        marketId: market.id,
        marketLabel: market.name,
        serviceCategory: scopeCategory.trim(),
        segment: scopeSegment.trim(),
      },
    ]);
    setScopeMarket("");
    setScopeCategory("");
    setScopeSegment("");
  };

  const submit = () => {
    startTransition(async () => {
      const result = await createAgreement({
        projectId,
        startsOn,
        endsOn: endsOn || null,
        gracePeriodDays: Number(graceDays) || 0,
        scopes: scopes.map((s) => ({
          marketId: s.marketId,
          serviceCategory: s.serviceCategory || null,
          segment: s.segment || null,
        })),
      });
      if (result.ok) {
        toast.success("Agreement recorded.");
        setOpen(false);
        setScopes([]);
        setProjectId("");
        setStartsOn("");
        setEndsOn("");
        setGraceDays("0");
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1 h-4 w-4" /> New agreement
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New exclusivity agreement</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Client</Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger>
                <SelectValue placeholder="Select client" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="agr-starts">Starts</Label>
              <Input
                id="agr-starts"
                type="date"
                value={startsOn}
                onChange={(e) => setStartsOn(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agr-ends">Ends (blank = open)</Label>
              <Input
                id="agr-ends"
                type="date"
                value={endsOn}
                onChange={(e) => setEndsOn(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agr-grace">Grace days</Label>
              <Input
                id="agr-grace"
                type="number"
                min={0}
                value={graceDays}
                onChange={(e) => setGraceDays(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm font-medium">Protected scopes</p>
            {scopes.length === 0 && (
              <p className="text-sm text-muted-foreground">
                None yet — an agreement protects at least one market scope.
              </p>
            )}
            {scopes.map((s, i) => (
              <div key={`${s.marketId}-${i}`} className="flex items-center gap-2 text-sm">
                <span>
                  {s.marketLabel} · {s.serviceCategory || "all services"} ·{" "}
                  {s.segment || "all segments"}
                </span>
                <button
                  type="button"
                  aria-label="Remove scope"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setScopes((prev) => prev.filter((_, j) => j !== i))}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <div className="grid grid-cols-3 gap-2">
              <Select value={scopeMarket} onValueChange={setScopeMarket}>
                <SelectTrigger>
                  <SelectValue placeholder="Market" />
                </SelectTrigger>
                <SelectContent>
                  {markets.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                      {m.parentName ? ` — ${m.parentName}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                placeholder="Category (blank = all)"
                value={scopeCategory}
                onChange={(e) => setScopeCategory(e.target.value)}
              />
              <Input
                placeholder="Segment (blank = all)"
                value={scopeSegment}
                onChange={(e) => setScopeSegment(e.target.value)}
              />
            </div>
            <Button type="button" variant="outline" size="sm" onClick={addScope}>
              Add scope
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={submit}
            disabled={pending || !projectId || !startsOn || scopes.length === 0}
          >
            {pending ? "Saving…" : "Record agreement"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
