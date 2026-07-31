"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { checkProspect } from "@/app/exclusivity/actions";
import type { CheckOutcome } from "@/lib/exclusivity/service";

interface Props {
  markets: { id: string; name: string; parentName: string | null }[];
  isAdmin: boolean;
}

const VERDICT_STYLE: Record<string, "destructive" | "secondary" | "outline"> = {
  direct: "destructive",
  partial: "secondary",
  possible: "outline",
};

export function CheckForm({ markets, isAdmin }: Props) {
  const [pending, startTransition] = useTransition();
  const [prospectName, setProspectName] = useState("");
  const [marketId, setMarketId] = useState("");
  const [category, setCategory] = useState("");
  const [segment, setSegment] = useState("");
  const [rationale, setRationale] = useState("");
  const [outcome, setOutcome] = useState<CheckOutcome | null>(null);

  const submit = (decision?: "override") => {
    if (!prospectName.trim() || !marketId) {
      toast.error("Prospect name and market are required.");
      return;
    }
    startTransition(async () => {
      const result = await checkProspect({
        prospectName,
        marketId,
        serviceCategory: category.trim() || null,
        segment: segment.trim() || null,
        ...(decision
          ? { decision, overrideRationale: rationale }
          : {}),
      });
      if (result.ok) {
        setOutcome(result.data);
        if (result.data.decision === "clear") toast.success("No conflicts.");
        else if (result.data.decision === "override")
          toast.success("Conflict overridden and recorded.");
        else toast.warning("Conflicts found — check recorded as blocked.");
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="prospect-name">Prospect</Label>
          <Input
            id="prospect-name"
            value={prospectName}
            onChange={(e) => setProspectName(e.target.value)}
            placeholder="Prospect name"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Market</Label>
          <Select value={marketId} onValueChange={setMarketId}>
            <SelectTrigger>
              <SelectValue placeholder="Select market" />
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
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="check-category">Service category</Label>
          <Input
            id="check-category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="e.g. residential_sales (blank = all)"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="check-segment">Segment</Label>
          <Input
            id="check-segment"
            value={segment}
            onChange={(e) => setSegment(e.target.value)}
            placeholder="e.g. luxury (blank = all)"
          />
        </div>
      </div>
      <Button onClick={() => submit()} disabled={pending}>
        {pending ? "Checking…" : "Check for conflicts"}
      </Button>

      {outcome && (
        <div className="rounded-md border p-4">
          {outcome.result.conflicts.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <ShieldCheck className="h-4 w-4 text-[var(--success,#16a34a)]" />
              No conflicts with any active agreement.
            </p>
          ) : (
            <div className="space-y-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                <ShieldAlert className="h-4 w-4 text-destructive" />
                {outcome.result.conflicts.length} conflict
                {outcome.result.conflicts.length > 1 ? "s" : ""} — recorded as{" "}
                <Badge
                  variant={outcome.decision === "override" ? "secondary" : "destructive"}
                >
                  {outcome.decision}
                </Badge>
              </p>
              <ul className="space-y-2">
                {outcome.result.conflicts.map((c) => (
                  <li key={c.scopeId} className="flex items-start gap-2 text-sm">
                    <Badge variant={VERDICT_STYLE[c.verdict] ?? "outline"}>
                      {c.verdict}
                      {c.gracePeriod ? " · grace" : ""}
                    </Badge>
                    <span className="text-muted-foreground">{c.reason}</span>
                  </li>
                ))}
              </ul>
              {isAdmin && outcome.decision === "blocked" && (
                <div className="space-y-2 border-t pt-3">
                  <Label htmlFor="override-rationale">
                    Override rationale (recorded immutably)
                  </Label>
                  <Textarea
                    id="override-rationale"
                    value={rationale}
                    onChange={(e) => setRationale(e.target.value)}
                    placeholder="Why signing this prospect does not violate the agreement"
                  />
                  <Button
                    variant="destructive"
                    disabled={pending || !rationale.trim()}
                    onClick={() => submit("override")}
                  >
                    Override and record
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
