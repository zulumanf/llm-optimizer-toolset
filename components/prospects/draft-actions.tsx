"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Check, Mail, MailOpen, Pencil, Send } from "lucide-react";
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
  createOutreachDraft,
  sendProspectDraft,
} from "@/app/prospects/actions";

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
            <Label>Subject</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Body</Label>
            <Textarea
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
