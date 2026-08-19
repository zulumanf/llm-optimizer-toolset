"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { CalendarClock, CalendarOff, Check, Mail, MailOpen, Pencil, Send } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  approveOutreachDraft,
  cancelScheduledSend,
  createOutreachDraft,
  scheduleDraftSend,
  sendProspectDraft,
} from "@/app/prospects/actions";

const DEFAULT_PURPOSE =
  "AI-visibility benchmark findings relevant to their team's market position";

export interface DraftContactOption {
  id: string;
  name: string;
  email: string | null;
  isPrimary: boolean;
  doNotContact: boolean;
}

/** Sentinel for "no specific person — the account's business address". */
const ACCOUNT_DEFAULT = "account";

function ContactSelect({
  contacts,
  value,
  onChange,
}: {
  contacts: DraftContactOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder="Who is this for?" />
      </SelectTrigger>
      <SelectContent>
        {contacts
          .filter((c) => !c.doNotContact)
          .map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
              {c.email ? ` · ${c.email}` : " · no email on file"}
              {c.isPrimary ? " · primary" : ""}
            </SelectItem>
          ))}
        <SelectItem value={ACCOUNT_DEFAULT}>
          Account default (business address)
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

/**
 * Generate binds the draft to a PERSON (plan 3.3) so the per-contact
 * do-not-contact gate and the send ledger see who was actually written to —
 * an unbound draft falls back to the business address and the contact gate
 * never fires.
 */
export function GenerateDraftButton({
  prospectId,
  contacts,
}: {
  prospectId: string;
  contacts: DraftContactOption[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const primary = contacts.find((c) => c.isPrimary && !c.doNotContact);
  const [contactId, setContactId] = useState<string>(primary?.id ?? ACCOUNT_DEFAULT);

  const generate = () => {
    startTransition(async () => {
      const result = await createOutreachDraft({
        prospectId,
        channel: "email",
        contactId: contactId === ACCOUNT_DEFAULT ? undefined : contactId,
      });
      if (result.ok) {
        toast.success(`Draft v${result.data.version} generated for review.`);
        setOpen(false);
      } else {
        toast.error(result.error.message);
      }
    });
  };

  // No contacts recorded: generate directly, addressed to the account.
  if (contacts.length === 0) {
    return (
      <Button size="sm" variant="outline" onClick={generate} disabled={pending}>
        <Mail className="size-4" /> {pending ? "Generating…" : "Generate reply-first draft"}
      </Button>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Mail className="size-4" /> Generate reply-first draft
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Who is this email for?</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Recipient</Label>
          <ContactSelect contacts={contacts} value={contactId} onChange={setContactId} />
          <p className="text-xs text-muted-foreground">
            The do-not-contact and suppression checks run against this person
            when the send is recorded.
          </p>
        </div>
        <DialogFooter>
          <Button onClick={generate} disabled={pending}>
            {pending ? "Generating…" : "Generate draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Editing writes a NEW version through the same pipeline as generation
 * (plan 3.2) — drafts are versioned rows, and approval re-runs the
 * prohibited-phrase gate on whatever text the operator saved.
 */
export function EditDraftButton({
  prospectId,
  draft,
  contacts,
}: {
  prospectId: string;
  draft: { subject: string | null; body: string; contactId: string | null };
  contacts: DraftContactOption[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [body, setBody] = useState(draft.body);
  const [contactId, setContactId] = useState<string>(draft.contactId ?? ACCOUNT_DEFAULT);

  const save = () => {
    startTransition(async () => {
      const result = await createOutreachDraft({
        prospectId,
        channel: "email",
        contactId: contactId === ACCOUNT_DEFAULT ? undefined : contactId,
        subject: subject || undefined,
        body,
      });
      if (result.ok) {
        toast.success(`Saved as v${result.data.version} — approve it to make it sendable.`);
        setOpen(false);
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Pencil className="size-4" /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit draft (saves as a new version)</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {contacts.length > 0 && (
            <div className="space-y-1.5">
              <Label>Recipient</Label>
              <ContactSelect
                contacts={contacts}
                value={contactId}
                onChange={setContactId}
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="draft-subject">Subject</Label>
            <Input
              id="draft-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="draft-body">Body</Label>
            <Textarea
              id="draft-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
              className="font-sans"
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={pending || body.trim().length === 0}>
            {pending ? "Saving…" : "Save new version"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ApproveDraftButton({ draftId }: { draftId: string }) {
  const [pending, startTransition] = useTransition();
  const approve = () => {
    startTransition(async () => {
      const result = await approveOutreachDraft({ draftId });
      if (result.ok) toast.success("Draft approved — this exact text is what a human may send.");
      else toast.error(result.error.message);
    });
  };
  return (
    <Button size="sm" onClick={approve} disabled={pending}>
      <Check className="size-4" /> Approve
    </Button>
  );
}

/**
 * Assisted-manual send (plan 3.5): opens the operator's own mail app with
 * the approved text — recipient, subject, body, audit link included —
 * prefilled. The platform still transmits nothing; Record sent remains the
 * step that writes the gate ledger.
 */
export function OpenInMailButton({
  recipientEmail,
  subject,
  body,
}: {
  recipientEmail: string | null;
  subject: string | null;
  body: string;
}) {
  const href = `mailto:${recipientEmail ?? ""}?subject=${encodeURIComponent(
    subject ?? ""
  )}&body=${encodeURIComponent(body)}`;
  return (
    <Button size="sm" variant="outline" asChild>
      <a href={href}>
        <MailOpen className="size-4" /> Open in mail app
      </a>
    </Button>
  );
}

/**
 * The platform's own transmission (spec 091): sends the approved text
 * through the connected Gmail mailbox, behind the full gate chain. The
 * dialog is the human click PRINCIPLES #8 requires for this exact send.
 */
export function SendViaGmailButton({ draftId }: { draftId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [purpose, setPurpose] = useState(DEFAULT_PURPOSE);

  const send = () => {
    startTransition(async () => {
      const result = await sendProspectDraft({
        draftId,
        channel: "gmail",
        businessPurpose: purpose,
      });
      if (result.ok) {
        toast.success("Sent via Gmail — gate ledger written.");
        setOpen(false);
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Send className="size-4" /> Send via Gmail
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send this approved email now?</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="send-purpose">Business purpose (recorded on the send ledger)</Label>
          <Textarea
            id="send-purpose"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            rows={2}
          />
          <p className="text-xs text-muted-foreground">
            Every gate re-runs before transmission: suppression, do-not-contact,
            re-contact windows, territory, sender identity, daily cap.
          </p>
        </div>
        <DialogFooter>
          <Button onClick={send} disabled={pending || purpose.trim().length < 10}>
            {pending ? "Sending…" : "Send now"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Schedule the transmission of an approved draft (spec 091). The named
 * time and stated purpose are the human confirmation the worker executes;
 * the gate still re-runs in full when the time arrives.
 */
export function ScheduleSendButton({ draftId }: { draftId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [sendAt, setSendAt] = useState("");
  const [purpose, setPurpose] = useState(DEFAULT_PURPOSE);

  const schedule = () => {
    startTransition(async () => {
      const result = await scheduleDraftSend({
        draftId,
        sendAt: new Date(sendAt).toISOString(),
        businessPurpose: purpose,
      });
      if (result.ok) {
        toast.success(
          `Scheduled — sends via Gmail around ${new Date(sendAt).toLocaleString()}.`
        );
        setOpen(false);
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <CalendarClock className="size-4" /> Schedule send
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule this approved email</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="schedule-at">Send at</Label>
            <Input
              id="schedule-at"
              type="datetime-local"
              value={sendAt}
              onChange={(e) => setSendAt(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              The worker checks roughly every 10 minutes, so the send lands
              shortly after this time. Up to 30 days ahead.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="schedule-purpose">
              Business purpose (recorded on the send ledger)
            </Label>
            <Textarea
              id="schedule-purpose"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={schedule}
            disabled={pending || !sendAt || purpose.trim().length < 10}
          >
            {pending ? "Scheduling…" : "Schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CancelScheduledSendButton({ draftId }: { draftId: string }) {
  const [pending, startTransition] = useTransition();
  const cancel = () => {
    startTransition(async () => {
      const result = await cancelScheduledSend({ draftId });
      if (result.ok) toast.success("Schedule cancelled — the draft stays approved.");
      else toast.error(result.error.message);
    });
  };
  return (
    <Button size="sm" variant="outline" onClick={cancel} disabled={pending}>
      <CalendarOff className="size-4" /> {pending ? "Cancelling…" : "Cancel schedule"}
    </Button>
  );
}

export function RecordSentButton({ draftId }: { draftId: string }) {
  const [pending, startTransition] = useTransition();
  const record = () => {
    // The gated path (spec 043): a human sent it from their own mailbox;
    // recording it through sendProspectDraft leaves the full gate ledger
    // (suppression, DNC, prohibited phrases) instead of a bare timestamp.
    const businessPurpose = window.prompt(
      "Business purpose for contacting this recipient (recorded on the send ledger):",
      "AI-visibility benchmark findings relevant to their team's market position"
    );
    if (!businessPurpose || businessPurpose.trim().length < 10) {
      toast.error("A business purpose of at least 10 characters is required.");
      return;
    }
    startTransition(async () => {
      const result = await sendProspectDraft({
        draftId,
        channel: "manual",
        businessPurpose,
      });
      if (result.ok) toast.success("Recorded as sent — gate ledger written.");
      else toast.error(result.error.message);
    });
  };
  return (
    <Button size="sm" variant="outline" onClick={record} disabled={pending}>
      <Send className="size-4" /> Record sent
    </Button>
  );
}
