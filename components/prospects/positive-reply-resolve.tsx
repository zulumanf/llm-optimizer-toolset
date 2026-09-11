"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
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
import { Textarea } from "@/components/ui/textarea";
import { resolvePositiveReply } from "@/app/prospects/actions";

/** The human records how a positive reply was handled; the item leaves Today. */
export function PositiveReplyResolve({ prospectId, replyId, businessName }: { prospectId: string; replyId: string; businessName: string }) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState("");
  const [pending, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">Mark handled</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>How was {businessName}&apos;s reply handled?</DialogTitle>
          <DialogDescription>
            One line of fact: what you sent or decided. The reply itself stays on record.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor={`outcome-${replyId}`}>Outcome</Label>
          <Textarea
            id={`outcome-${replyId}`}
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            placeholder="Report delivered 9/4; proposed first change + offer by email; waiting on reply."
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button
            disabled={pending || outcome.trim().length < 3}
            onClick={() =>
              start(async () => {
                const r = await resolvePositiveReply({ prospectId, replyId, outcome });
                if (r.ok) {
                  toast.success("Recorded");
                  setOpen(false);
                  setOutcome("");
                } else {
                  toast.error(r.error.message);
                }
              })
            }
          >
            {pending ? "Recording…" : "Record"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
