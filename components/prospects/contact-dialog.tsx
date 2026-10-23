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
import { Textarea } from "@/components/ui/textarea";
import { ContactProvenanceChoice } from "@/components/prospects/contact-provenance-choice";
import { addContact } from "@/app/prospects/actions";
import {
  CONTACT_CHANNELS,
  CONTACT_SOURCE_MAX_LENGTH,
  DEFAULT_CONTACT_ENTRY_PROVENANCE,
  isSendReadyProvenance,
  type ContactEntryProvenance,
} from "@/lib/prospects/constants";

export function ContactDialog({ prospectId }: { prospectId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [linkedin, setLinkedin] = useState("");
  const [preferredChannel, setPreferredChannel] = useState<string>("email");
  const [provenance, setProvenance] = useState<ContactEntryProvenance>(
    DEFAULT_CONTACT_ENTRY_PROVENANCE
  );
  const [source, setSource] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);

  // A send-ready label vouches for an address — it needs an address and a
  // stated source (stored in the contact's notes, the existing convention).
  const sendReady = isSendReadyProvenance(provenance);
  const sendReadyIncomplete = sendReady && (!email.trim() || !source.trim());

  const submit = () => {
    startTransition(async () => {
      const result = await addContact({
        prospectId,
        name,
        role: role || undefined,
        email: email || undefined,
        phone: phone || undefined,
        linkedin: linkedin || undefined,
        preferredChannel,
        provenance,
        notes: source.trim() ? `Source: ${source.trim()}` : undefined,
        isPrimary,
      });
      if (result.ok) {
        toast.success("Contact added.");
        setOpen(false);
        setName("");
        setRole("");
        setEmail("");
        setPhone("");
        setLinkedin("");
        setProvenance(DEFAULT_CONTACT_ENTRY_PROVENANCE);
        setSource("");
        setIsPrimary(false);
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="size-4" /> Add contact
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add contact</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="contact-name">Name</Label>
              <Input
                id="contact-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ana Rivera"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contact-role">Role</Label>
              <Input
                id="contact-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="Team leader"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="contact-email">Email</Label>
              <Input
                id="contact-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ana@riverateam.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contact-phone">Phone</Label>
              <Input
                id="contact-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 …"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="contact-linkedin">LinkedIn URL</Label>
            <Input
              id="contact-linkedin"
              value={linkedin}
              onChange={(e) => setLinkedin(e.target.value)}
              placeholder="https://linkedin.com/in/…"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Preferred channel</Label>
            <Select value={preferredChannel} onValueChange={setPreferredChannel}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTACT_CHANNELS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c.replaceAll("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <ContactProvenanceChoice
            name="contact-provenance"
            legend="How do you know this email?"
            value={provenance}
            onChange={setProvenance}
          />
          <div className="space-y-1.5">
            <Label htmlFor="contact-source">
              Source{sendReady ? " (required)" : ""}
            </Label>
            <Textarea
              id="contact-source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              rows={2}
              maxLength={CONTACT_SOURCE_MAX_LENGTH}
              placeholder="https://riverateam.com/team — where you saw this address, or who confirmed it"
            />
            <p className="text-xs text-muted-foreground">
              Saved in the contact&apos;s notes so anyone can re-check it later.
            </p>
            {sendReadyIncomplete && (
              <p className="text-xs text-destructive">
                A send-ready label needs the email address and where you checked it.
              </p>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isPrimary}
              onChange={(e) => setIsPrimary(e.target.checked)}
            />
            Primary contact — outreach drafts default to this person
          </label>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={pending || !name.trim() || sendReadyIncomplete}>
            {pending ? "Saving…" : "Save contact"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
