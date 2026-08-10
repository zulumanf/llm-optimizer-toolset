"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUpRight } from "lucide-react";
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
import { promoteProspect } from "@/app/prospects/actions";

/** The close's side effect (spec 057): converts the benchmark project into
 * the client project — pre-signing baseline included — and locks the
 * territory. Deliberate, never a hidden consequence of a stage click. */
export function PromoteButton({ prospectId }: { prospectId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [withAgreement, setWithAgreement] = useState("yes");

  const submit = () =>
    startTransition(async () => {
      const result = await promoteProspect({
        prospectId,
        createAgreement: withAgreement === "yes",
      });
      if (result.ok) {
        toast.success(
          "Promoted. The pre-signing benchmark is now the client's baseline."
        );
        setOpen(false);
        router.push(`/projects/${result.data.projectId}`);
      } else {
        toast.error(result.error.message);
      }
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <ArrowUpRight className="size-4" /> Promote to client
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Promote to client</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          The benchmark project becomes the client project — every pre-signing
          capture, score, and tracked competitor stays attached, so the first
          client report has a real comparable baseline. Onboarding intake
          continues on the project afterwards.
        </p>
        <div className="space-y-1">
          <Label htmlFor="promote-agreement">Territory exclusivity</Label>
          <Select value={withAgreement} onValueChange={setWithAgreement}>
            <SelectTrigger id="promote-agreement">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="yes">
                Create an active agreement for this market now
              </SelectItem>
              <SelectItem value="no">
                No exclusivity (sold without territory protection)
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Promoting…" : "Promote"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
