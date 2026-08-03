"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import { generateMarketPrompts, installMarketPack } from "@/app/prompts/actions";
import { MARKET_PACKS } from "@/lib/markets/packs";

interface Report {
  created: number;
  skippedExisting: number;
  skippedByCap: number;
  excluded: { name: string; reason: string }[];
}

export function GenerateMarketDialog({ setId }: { setId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [packKey, setPackKey] = useState<string>(MARKET_PACKS[0]?.key ?? "");
  const [report, setReport] = useState<Report | null>(null);

  const pack = MARKET_PACKS.find((p) => p.key === packKey);

  const submit = () => {
    startTransition(async () => {
      // Install the pack's geography first (idempotent), so launches and
      // exclusivity checks can target the same markets the prompts probe.
      const install = await installMarketPack({ packKey });
      if (!install.ok) {
        toast.error(install.error.message);
        return;
      }
      const result = await generateMarketPrompts({ setId, packKey });
      if (result.ok) {
        setReport(result.data as Report);
        toast.success(`Generated ${(result.data as Report).created} prompt(s).`);
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setReport(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <MapPin className="size-4" /> Generate from market pack
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Generate city-specific prompts</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Market pack</Label>
            <Select value={packKey} onValueChange={setPackKey}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MARKET_PACKS.map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    {p.cityName} (v{p.version})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {pack && (
            <p className="text-xs text-muted-foreground">
              {pack.templates.length} templates over {pack.cityName} and its neighborhoods;
              duplicates already in the set are skipped. Installing also materializes the
              city&apos;s market hierarchy for launches and exclusivity checks.
            </p>
          )}
          {report && (
            <div className="rounded-md border p-3 text-sm space-y-1">
              <p>
                Created <strong>{report.created}</strong> · already in set{" "}
                <strong>{report.skippedExisting}</strong> · over cap{" "}
                <strong>{report.skippedByCap}</strong>
              </p>
              {report.excluded.length > 0 && (
                <p className="text-muted-foreground">
                  Excluded: {report.excluded.map((e) => e.name).join(", ")} (ambiguous place
                  names)
                </p>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={pending || !packKey}>
            {pending ? "Generating…" : "Install pack & generate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
