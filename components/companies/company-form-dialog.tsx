"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Pencil } from "lucide-react";
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
import { upsertCompany } from "@/app/classification/actions";

interface Props {
  mode: "create" | "edit";
  isAdmin: boolean;
  company?: {
    id: string;
    name: string;
    aliases: string[];
    domain: string | null;
    isSelf: boolean;
  };
}

export function CompanyFormDialog({ mode, isAdmin, company }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(company?.name ?? "");
  const [aliases, setAliases] = useState(company?.aliases.join(", ") ?? "");
  const [domain, setDomain] = useState(company?.domain ?? "");
  const [isSelf, setIsSelf] = useState(company?.isSelf ?? false);
  const [error, setError] = useState<string | null>(null);

  const submit = () =>
    startTransition(async () => {
      setError(null);
      const result = await upsertCompany({
        id: company?.id,
        name,
        aliases: aliases
          .split(",")
          .map((a) => a.trim())
          .filter((a) => a.length > 0),
        domain: domain.trim() || undefined,
        isSelf,
      });
      if (result.ok) {
        toast.success(mode === "create" ? "Company added." : "Company updated.");
        setOpen(false);
        router.refresh();
      } else {
        setError(result.error.message);
      }
    });

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); setError(null); }}>
      <DialogTrigger asChild>
        {mode === "create" ? (
          <Button size="sm">
            <Plus className="size-4" /> Add company
          </Button>
        ) : (
          <Button size="icon-sm" variant="ghost" aria-label="Edit company">
            <Pencil className="size-4" />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "Add company" : "Edit company"}</DialogTitle>
          <DialogDescription>
            Aliases are matched with word boundaries, case-insensitively.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="co-name">Canonical name</Label>
            <Input id="co-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="co-aliases">Aliases (comma-separated)</Label>
            <Input
              id="co-aliases"
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              placeholder="parva.com, Parva App"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="co-domain">Domain (for citation attribution)</Label>
            <Input
              id="co-domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="parva.com"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="co-self"
              checked={isSelf}
              disabled={!isAdmin}
              onChange={(e) => setIsSelf(e.target.checked)}
              className="size-4"
            />
            <Label htmlFor="co-self">
              This is Parva (is_self{isAdmin ? "" : " — admin only"})
            </Label>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || name.trim().length === 0}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
