"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
import { createProspect } from "@/app/prospects/actions";
import { PROSPECT_TYPES } from "@/lib/prospects/constants";

interface Props {
  launches: { id: string; name: string }[];
}

export function ProspectDialog({ launches }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [launchId, setLaunchId] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [prospectType, setProspectType] = useState<string>("team");
  const [teamLeader, setTeamLeader] = useState("");
  const [website, setWebsite] = useState("");

  const submit = () => {
    startTransition(async () => {
      const result = await createProspect({
        launchId,
        businessName,
        prospectType,
        teamLeader: teamLeader || undefined,
        website: website || undefined,
      });
      if (result.ok) {
        toast.success("Prospect added.");
        setOpen(false);
        router.push(`/prospects/${result.data.prospectId}`);
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={launches.length === 0}>
          <Plus className="size-4" /> New prospect
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New prospect</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Launch</Label>
            <Select value={launchId} onValueChange={setLaunchId}>
              <SelectTrigger>
                <SelectValue placeholder="Which market launch?" />
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
            <Label htmlFor="prospect-name">Business name</Label>
            <Input
              id="prospect-name"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder="The Rivera Team"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={prospectType} onValueChange={setProspectType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROSPECT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t.replaceAll("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="prospect-leader">Team leader</Label>
            <Input
              id="prospect-leader"
              value={teamLeader}
              onChange={(e) => setTeamLeader(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="prospect-website">Website</Label>
            <Input
              id="prospect-website"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://…"
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={pending || !businessName.trim() || !launchId}>
            {pending ? "Adding…" : "Add prospect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
