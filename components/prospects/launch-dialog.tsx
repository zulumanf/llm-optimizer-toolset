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
import { createLaunch } from "@/app/prospects/actions";

interface Props {
  markets: { id: string; name: string; parentName: string | null }[];
}

export function LaunchDialog({ markets }: Props) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [marketId, setMarketId] = useState("");
  const [priceSegment, setPriceSegment] = useState("");
  const [serviceCategory, setServiceCategory] = useState("");

  const submit = () => {
    startTransition(async () => {
      const result = await createLaunch({
        name,
        marketId,
        priceSegment: priceSegment || undefined,
        serviceCategory: serviceCategory || undefined,
      });
      if (result.ok) {
        toast.success("Launch created.");
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
          <Plus className="size-4" /> New launch
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New market launch</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="launch-name">Name</Label>
            <Input
              id="launch-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Manhattan luxury residential"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Market</Label>
            <Select value={marketId} onValueChange={setMarketId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick from the exclusivity market tree" />
              </SelectTrigger>
              <SelectContent>
                {markets.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                    {m.parentName ? ` (${m.parentName})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="launch-segment">Price segment</Label>
            <Input
              id="launch-segment"
              value={priceSegment}
              onChange={(e) => setPriceSegment(e.target.value)}
              placeholder="luxury"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="launch-service">Service category</Label>
            <Input
              id="launch-service"
              value={serviceCategory}
              onChange={(e) => setServiceCategory(e.target.value)}
              placeholder="residential brokerage"
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={pending || !name.trim() || !marketId}>
            {pending ? "Creating…" : "Create launch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
