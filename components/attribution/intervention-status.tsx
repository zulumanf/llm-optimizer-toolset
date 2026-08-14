"use client";

/**
 * Intervention lifecycle controls + badge (spec 062). Blocking demands a
 * reason — the queue item it creates is only as useful as the sentence in it.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { setInterventionStatus } from "@/app/attribution/actions";
import type { InterventionStatus } from "@/lib/attribution/lifecycle";

export function InterventionStatusBadge({
  status,
  blockedReason,
}: {
  status: InterventionStatus;
  blockedReason?: string | null;
}) {
  switch (status) {
    case "retested":
      return <Badge>retested</Badge>;
    case "retest_pending":
      return <Badge variant="secondary">retest pending</Badge>;
    case "blocked":
      return (
        <Badge variant="destructive" title={blockedReason ?? undefined}>
          blocked
        </Badge>
      );
    case "cancelled":
      return <Badge variant="outline">cancelled</Badge>;
    default:
      return <Badge variant="outline">shipped</Badge>;
  }
}

export function InterventionStatusControls({
  interventionId,
  status,
}: {
  interventionId: string;
  status: InterventionStatus;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [blockOpen, setBlockOpen] = useState(false);
  const [reason, setReason] = useState("");

  const act = (input: Record<string, unknown>, done?: () => void) => {
    startTransition(async () => {
      const result = await setInterventionStatus(input);
      if (result.ok) {
        done?.();
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });
  };

  const terminal = status === "retested" || status === "cancelled";
  if (terminal) return null;

  return (
    <div className="flex items-center gap-2">
      {status === "blocked" ? (
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => act({ interventionId, action: "unblock" })}
        >
          Unblock
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => setBlockOpen(true)}
        >
          Block
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => {
          if (window.confirm("Cancel this measurement? The record stays, terminally.")) {
            act({ interventionId, action: "cancel" });
          }
        }}
      >
        Cancel measurement
      </Button>

      <Dialog open={blockOpen} onOpenChange={setBlockOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Block this intervention</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="block-reason">Why is the retest blocked?</Label>
            <Textarea
              id="block-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. client rolled the page back; waiting on redeploy"
              maxLength={500}
            />
            <p className="text-xs text-muted-foreground">
              The reason lands in the control-tower queue verbatim.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBlockOpen(false)}>
              Keep as is
            </Button>
            <Button
              disabled={pending || reason.trim().length === 0}
              onClick={() =>
                act({ interventionId, action: "block", reason: reason.trim() }, () => {
                  setBlockOpen(false);
                  setReason("");
                })
              }
            >
              Block
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
