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
import { createMarket } from "@/app/exclusivity/actions";
import { MARKET_KINDS } from "@/lib/exclusivity/constants";

const NO_PARENT = "__root__";

interface Props {
  markets: { id: string; name: string; parentName: string | null }[];
}

export function MarketDialog({ markets }: Props) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<string>("neighborhood");
  const [parentId, setParentId] = useState<string>(NO_PARENT);

  const submit = () => {
    startTransition(async () => {
      const result = await createMarket({
        name,
        kind,
        parentId: parentId === NO_PARENT ? null : parentId,
        aliases: [],
      });
      if (result.ok) {
        toast.success("Market added.");
        setOpen(false);
        setName("");
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="mr-1 h-4 w-4" /> Add market
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add market</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="market-name">Name</Label>
            <Input
              id="market-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Tribeca"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Kind</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MARKET_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Parent market (containment)</Label>
            <Select value={parentId} onValueChange={setParentId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PARENT}>None (top level)</SelectItem>
                {markets.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                    {m.parentName ? ` — ${m.parentName}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={pending || !name.trim()}>
            {pending ? "Saving…" : "Add market"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
