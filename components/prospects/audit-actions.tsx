"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Copy, Globe, ShieldOff, TimerOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { expireAudit, publishAudit, revokeAudit } from "@/app/prospects/actions";

export function PublishAuditButton({ prospectId }: { prospectId: string }) {
  const [pending, startTransition] = useTransition();
  // Publish-time quality flags (PR B): the audit went out, but the operator
  // should reconsider sending it — e.g. rank tracks visibility here (weak
  // pitch, consider disqualifying) or no human finding was recorded. Long
  // duration: these are the disqualify-before-sending signal.
  const surfaceWarnings = (warnings: string[]) => {
    for (const warning of warnings) {
      toast.warning(warning, { duration: 15000 });
    }
  };
  const publish = () => {
    startTransition(async () => {
      const result = await publishAudit({ prospectId });
      if (result.ok) {
        toast.success(
          result.data.replaced
            ? "Republished — same link, updated content."
            : "Audit published — share link is ready below."
        );
        surfaceWarnings(result.data.warnings);
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
          if (retried.ok) {
            toast.success("Audit published with a stale-benchmark acknowledgment.");
            surfaceWarnings(retried.data.warnings);
          } else toast.error(retried.error.message);
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

/**
 * The url is built server-side from APP_URL (plan 3.1/1.2) — never from
 * window.location, which is localhost on the operator's machine. No APP_URL
 * → no copy button pretending the link is sendable.
 */
export function CopyAuditLink({ url }: { url: string | null }) {
  const copy = () => {
    if (!url) {
      toast.error(
        "APP_URL is not configured — the copied link would point at localhost. Set it in the environment first."
      );
      return;
    }
    void navigator.clipboard.writeText(url);
    toast.success("Share link copied.");
  };
  return (
    <Button size="sm" variant="outline" onClick={copy}>
      <Copy className="size-4" /> Copy link
    </Button>
  );
}

export function ExpireAuditButton({ auditId }: { auditId: string }) {
  const [pending, startTransition] = useTransition();
  const expire = () => {
    startTransition(async () => {
      const result = await expireAudit({ auditId });
      if (result.ok) toast.success("Link expired — the page no longer resolves.");
      else toast.error(result.error.message);
    });
  };
  return (
    <Button size="sm" variant="outline" onClick={expire} disabled={pending}>
      <TimerOff className="size-4" /> Expire link
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
