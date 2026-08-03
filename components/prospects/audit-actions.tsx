"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Copy, Globe, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { publishAudit, revokeAudit } from "@/app/prospects/actions";

export function PublishAuditButton({ prospectId }: { prospectId: string }) {
  const [pending, startTransition] = useTransition();
  const publish = () => {
    startTransition(async () => {
      const result = await publishAudit({ prospectId });
      if (result.ok) {
        toast.success("Audit published — share link is ready below.");
        return;
      }
      // Stale-benchmark gate (spec 042): surface the age and let the
      // operator explicitly acknowledge before publishing anyway.
      if (result.error.message.includes("freshness window")) {
        const proceed = window.confirm(
          `${result.error.message}\n\nPublish anyway? The acknowledgment is recorded.`
        );
        if (proceed) {
          const retried = await publishAudit({ prospectId, acknowledgeStale: true });
          if (retried.ok) toast.success("Audit published with a stale-benchmark acknowledgment.");
          else toast.error(retried.error.message);
        }
        return;
      }
      toast.error(result.error.message);
    });
  };
  return (
    <Button size="sm" onClick={publish} disabled={pending}>
      <Globe className="size-4" /> {pending ? "Publishing…" : "Publish audit page"}
    </Button>
  );
}

export function CopyAuditLink({ token }: { token: string }) {
  const copy = () => {
    const url = `${window.location.origin}/audit/${token}`;
    void navigator.clipboard.writeText(url);
    toast.success("Share link copied.");
  };
  return (
    <Button size="sm" variant="outline" onClick={copy}>
      <Copy className="size-4" /> Copy link
    </Button>
  );
}

export function RevokeAuditButton({ auditId }: { auditId: string }) {
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState("");
  const revoke = () => {
    startTransition(async () => {
      const result = await revokeAudit({ auditId, reason });
      if (result.ok) toast.success("Audit revoked — the link no longer resolves.");
      else toast.error(result.error.message);
    });
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Revocation reason"
        className="w-56"
      />
      <Button
        size="sm"
        variant="destructive"
        onClick={revoke}
        disabled={pending || !reason.trim()}
      >
        <ShieldOff className="size-4" /> Revoke
      </Button>
    </div>
  );
}
