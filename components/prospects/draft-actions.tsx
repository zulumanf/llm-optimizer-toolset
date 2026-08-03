"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Check, Mail, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  approveOutreachDraft,
  createOutreachDraft,
  sendProspectDraft,
} from "@/app/prospects/actions";

export function GenerateDraftButton({ prospectId }: { prospectId: string }) {
  const [pending, startTransition] = useTransition();
  const generate = () => {
    startTransition(async () => {
      const result = await createOutreachDraft({ prospectId, channel: "email" });
      if (result.ok) toast.success(`Draft v${result.data.version} generated for review.`);
      else toast.error(result.error.message);
    });
  };
  return (
    <Button size="sm" variant="outline" onClick={generate} disabled={pending}>
      <Mail className="size-4" /> {pending ? "Generating…" : "Generate reply-first draft"}
    </Button>
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
