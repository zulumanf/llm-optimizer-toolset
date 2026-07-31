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
import { Textarea } from "@/components/ui/textarea";
import { createCampaign } from "@/app/campaigns/actions";

export function CampaignFormDialog({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [hypothesis, setHypothesis] = useState("");

  const submit = () => {
    startTransition(async () => {
      const result = await createCampaign({
        projectId,
        name,
        objective,
        hypothesis: hypothesis.trim() || undefined,
      });
      if (result.ok) {
        toast.success("Campaign created as draft.");
        setOpen(false);
        setName("");
        setObjective("");
        setHypothesis("");
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1 h-4 w-4" /> New campaign
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New campaign</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="campaign-name">Name</Label>
            <Input
              id="campaign-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Manhattan luxury seller visibility"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="campaign-objective">Objective</Label>
            <Textarea
              id="campaign-objective"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="What should be true when this campaign succeeds?"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="campaign-hypothesis">Hypothesis (optional)</Label>
            <Textarea
              id="campaign-hypothesis"
              value={hypothesis}
              onChange={(e) => setHypothesis(e.target.value)}
              placeholder="Why the planned work should move the metrics"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={submit}
            disabled={pending || !name.trim() || !objective.trim()}
          >
            {pending ? "Saving…" : "Create draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
