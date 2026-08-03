"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { archiveContact, updateContact } from "@/app/prospects/actions";

export function ContactActions({
  contactId,
  isPrimary,
  doNotContact,
}: {
  contactId: string;
  isPrimary: boolean;
  doNotContact: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [dncOpen, setDncOpen] = useState(false);
  const [dncReason, setDncReason] = useState("");

  const act = (fn: () => Promise<{ ok: boolean; error?: { message: string } }>, done: string) => {
    startTransition(async () => {
      const result = await fn();
      if (result.ok) toast.success(done);
      else toast.error(result.error?.message ?? "Something went wrong.");
    });
  };

  return (
    <div className="flex items-center justify-end gap-1">
      {!isPrimary && (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() =>
            act(() => updateContact({ contactId, isPrimary: true }), "Primary contact updated.")
          }
        >
          Make primary
        </Button>
      )}
      {doNotContact ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() =>
            act(
              () => updateContact({ contactId, doNotContact: false }),
              "Do-not-contact flag lifted."
            )
          }
        >
          Allow contact
        </Button>
      ) : (
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => setDncOpen(true)}>
          Do not contact
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => act(() => archiveContact({ contactId }), "Contact archived.")}
      >
        Archive
      </Button>

      <Dialog open={dncOpen} onOpenChange={setDncOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Flag contact as do-not-contact</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="dnc-reason">Reason</Label>
            <Input
              id="dnc-reason"
              value={dncReason}
              onChange={(e) => setDncReason(e.target.value)}
              placeholder="Asked us to stop / bounced / legal request…"
            />
            <p className="text-xs text-muted-foreground">
              Drafts addressed to this person can no longer be approved or recorded as sent.
            </p>
          </div>
          <DialogFooter>
            <Button
              disabled={pending || !dncReason.trim()}
              onClick={() => {
                setDncOpen(false);
                act(
                  () =>
                    updateContact({ contactId, doNotContact: true, doNotContactReason: dncReason }),
                  "Contact flagged do-not-contact."
                );
                setDncReason("");
              }}
            >
              Flag contact
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
