"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Send } from "lucide-react";
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
import { recordReportDelivery } from "@/app/reports/actions";

const CHANNEL_LABELS: Record<string, string> = {
  manual_email: "Email (sent from my mailbox)",
  portal: "Client read it in the portal",
  other: "Other",
};

/** Records that a published report reached the client (spec 051). The send
 * itself stays in the operator's mail client; this is the receipt. */
export function DeliveryDialog({ reportId }: { reportId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [channel, setChannel] = useState<string>("manual_email");
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState("");

  const submit = () => {
    startTransition(async () => {
      const result = await recordReportDelivery({
        reportId,
        channel,
        recipient,
        note: note || undefined,
      });
      if (result.ok) {
        toast.success("Delivery recorded.");
        setOpen(false);
        setRecipient("");
        setNote("");
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Send className="size-4" /> Record delivery
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record a delivery</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="delivery-channel">How it reached the client</Label>
            <Select value={channel} onValueChange={setChannel}>
              <SelectTrigger id="delivery-channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(CHANNEL_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="delivery-recipient">Who received it</Label>
            <Input
              id="delivery-recipient"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="maria@rivera-team.com"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="delivery-note">Note (optional)</Label>
            <Input
              id="delivery-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Sent with the quarterly call agenda"
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={pending || recipient.trim().length < 3}>
            {pending ? "Recording…" : "Record delivery"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
