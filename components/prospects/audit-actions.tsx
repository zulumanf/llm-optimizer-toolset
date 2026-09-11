"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Copy, Globe, ShieldOff, TimerOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { expireAudit, publishAudit, revokeAudit, revokeReportAccess } from "@/app/prospects/actions";

/** Server-side reason minimum (publishAudit's acknowledgeWarnings schema) —
 * mirrored here so the button disables instead of round-tripping a 400. */
const ACK_REASON_MIN = 10;

export function PublishAuditButton({ prospectId }: { prospectId: string }) {
  const [pending, startTransition] = useTransition();
  // Ack-with-reason gate (spec 052, wired 2026-08-14): the server refuses
  // disqualification signals — weak pitch, dead source link, partial run —
  // until the operator supplies a written reason, recorded in the audit
  // log. This dialog is that path; hard blockers (mock data, evidence gate,
  // unfinished run) never offer it and stay plain errors.
  const [ackGate, setAckGate] = useState<{
    message: string;
    ackStale: boolean;
  } | null>(null);
  const [reason, setReason] = useState("");
  // Publish-time quality flags (PR B): the audit went out, but the operator
  // should reconsider sending it — e.g. rank tracks visibility here (weak
  // pitch, consider disqualifying) or no human finding was recorded. Long
  // duration: these are the disqualify-before-sending signal.
  const surfaceWarnings = (warnings: string[]) => {
    for (const warning of warnings) {
      toast.warning(warning, { duration: 15000 });
    }
  };
  const closeAckGate = () => {
    setAckGate(null);
    setReason("");
  };
  const publish = (opts: { ackStale?: boolean; reason?: string } = {}) => {
    startTransition(async () => {
      const payload = {
        prospectId,
        ...(opts.ackStale ? { acknowledgeStale: true } : {}),
        ...(opts.reason ? { acknowledgeWarnings: { reason: opts.reason } } : {}),
      };
      const result = await publishAudit(payload);
      if (result.ok) {
        closeAckGate();
        toast.success(
          result.data.replaced
            ? "Republished — same link, updated content."
            : "Audit published — share link is ready below."
        );
        surfaceWarnings(result.data.warnings);
        return;
      }
      const message = result.error.message;
      // Stale-benchmark gate (spec 042): surface the age and let the
      // operator explicitly acknowledge before publishing anyway. The retry
      // keeps any warning acknowledgment already typed — the server checks
      // staleness first, so this can precede the warnings dialog.
      if (message.includes("freshness window")) {
        const proceed = window.confirm(
          `${message}\n\nPublish anyway? The acknowledgment is recorded.`
        );
        if (proceed) {
          const retried = await publishAudit({ ...payload, acknowledgeStale: true });
          if (retried.ok) {
            closeAckGate();
            toast.success("Audit published with a stale-benchmark acknowledgment.");
            surfaceWarnings(retried.data.warnings);
          } else if (retried.error.message.includes("acknowledge with a reason")) {
            setAckGate({ message: retried.error.message, ackStale: true });
          } else toast.error(retried.error.message);
        }
        return;
      }
      if (message.includes("acknowledge with a reason")) {
        setAckGate({ message, ackStale: Boolean(opts.ackStale) });
        return;
      }
      toast.error(message);
    });
  };
  return (
    <>
      <Button size="sm" onClick={() => publish()} disabled={pending}>
        <Globe className="size-4" /> {pending ? "Publishing…" : "Publish audit page"}
      </Button>
      <AlertDialog
        open={ackGate !== null}
        onOpenChange={(open) => {
          if (!open) closeAckGate();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish over disqualification signals?</AlertDialogTitle>
            <AlertDialogDescription>{ackGate?.message}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="ack-warnings-reason">
              Reason for publishing anyway (recorded in the audit log)
            </Label>
            <Input
              id="ack-warnings-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. verified the source by hand in a browser"
            />
          </div>
          <AlertDialogFooter>
            <Button variant="ghost" onClick={closeAckGate} disabled={pending}>
              Cancel
            </Button>
            <Button
              disabled={pending || reason.trim().length < ACK_REASON_MIN}
              onClick={() =>
                publish({ ackStale: ackGate?.ackStale, reason: reason.trim() })
              }
            >
              {pending ? "Publishing…" : "Publish anyway"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
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

/** Spec 134: burn the invitation and every report session while the audit
 * stays published — mint a fresh link afterwards to re-deliver. */
export function RevokeReportAccessButton({ prospectId }: { prospectId: string }) {
  const [pending, startTransition] = useTransition();
  const revoke = () => {
    startTransition(async () => {
      const result = await revokeReportAccess({ prospectId, reason: "Operator revoked report access" });
      if (result.ok) toast.success(`Report access revoked — ${result.data.sessionsRevoked} session(s) ended; mint a new link to re-deliver.`);
      else toast.error(result.error.message);
    });
  };
  return (
    <Button size="sm" variant="outline" onClick={revoke} disabled={pending}>
      <ShieldOff className="size-4" /> Revoke access
    </Button>
  );
}
