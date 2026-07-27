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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { addCompetitor } from "@/app/competitors/actions";

interface Props {
  projectId: string;
  companies: { id: string; name: string }[];
}

export function AddCompetitorDialog({ projectId, companies }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [companyId, setCompanyId] = useState("");
  const [tier, setTier] = useState<"primary" | "secondary">("primary");
  const [error, setError] = useState<string | null>(null);

  const submit = () =>
    startTransition(async () => {
      setError(null);
      const result = await addCompetitor({ projectId, companyId, tier });
      if (result.ok) {
        toast.success(
          `Competitor added — backfilling ${result.data.backfilledRuns} recent run${result.data.backfilledRuns === 1 ? "" : "s"}.`
        );
        setOpen(false);
        router.refresh();
      } else {
        setError(result.error.message);
      }
    });

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); setError(null); }}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" /> Add competitor
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Track a competitor</DialogTitle>
          <DialogDescription>
            Pick an existing company (add new ones under Companies). Recent
            runs are re-parsed so its metrics appear retroactively.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Company</Label>
            <Select value={companyId} onValueChange={setCompanyId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={companies.length === 0 ? "No untracked companies" : "Select…"} />
              </SelectTrigger>
              <SelectContent>
                {companies.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Tier</Label>
            <Select value={tier} onValueChange={(v) => setTier(v as "primary" | "secondary")}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="primary">primary</SelectItem>
                <SelectItem value="secondary">secondary</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !companyId}>
            {pending ? "Adding…" : "Add & backfill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
