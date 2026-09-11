"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { approveAuditRefresh, dismissAuditRefresh } from "@/app/prospects/actions";
import type { RefreshQueueItem } from "@/lib/prospects/refresh";

function pct(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${Math.round(value * 100)}%`;
}

function DeltaLine({ item }: { item: RefreshQueueItem }) {
  const delta = item.delta;
  if (!delta) return null;
  return (
    <p className="text-sm tabular-nums">
      Rec share {pct(delta.recommendationRate.old)} → {pct(delta.recommendationRate.new)}
      {delta.topRival && (
        <>
          {" · "}Top rival: {delta.topRival.name} {pct(delta.topRival.rate.old)} →{" "}
          {pct(delta.topRival.rate.new)}
        </>
      )}
      {" · "}
      {delta.claimStillTrue ? (
        <span className="text-muted-foreground">claim holds</span>
      ) : (
        <span className="font-medium text-destructive">
          claim flipped — they now lead; recheck the pitch before approving
        </span>
      )}
    </p>
  );
}

export function RefreshCard({ item }: { item: RefreshQueueItem }) {
  const [pending, startTransition] = useTransition();
  const [decided, setDecided] = useState(false);
  const prior = item.priorHumanFinding;
  const [text, setText] = useState(prior?.text ?? "");
  const [sourceLabel, setSourceLabel] = useState(prior?.sourceLabel ?? "");
  const [sourceUrl, setSourceUrl] = useState(prior?.sourceUrl ?? "");
  const [sourceDate, setSourceDate] = useState(prior?.sourceDate ?? "");
  const [ackStale, setAckStale] = useState(false);
  const [ackReason, setAckReason] = useState("");

  const warnings = item.preflight.filter((c) => c.level === "warn" && !c.ok);
  const isStale = warnings.some((c) => c.id === "benchmark_fresh");
  const needsAttention = item.status === "needs_attention";

  const approve = () => {
    startTransition(async () => {
      const result = await approveAuditRefresh({
        candidateId: item.id,
        humanFinding: { text, sourceLabel, sourceUrl, sourceDate },
        ...(ackStale ? { acknowledgeStale: true } : {}),
        ...(ackReason.trim().length >= 10
          ? { acknowledgeWarnings: { reason: ackReason.trim() } }
          : {}),
      });
      if (result.ok) {
        toast.success("Audit republished — same link, fresh data.");
        setDecided(true);
      } else {
        toast.error(result.error.message);
      }
    });
  };

  const hold = () => {
    startTransition(async () => {
      const result = await dismissAuditRefresh({ candidateId: item.id });
      if (result.ok) {
        toast.success("Held — next week's run will prepare a fresh one.");
        setDecided(true);
      } else {
        toast.error(result.error.message);
      }
    });
  };

  if (decided) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-lg">{item.businessName}</CardTitle>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {item.publishedAt && (
              <span>
                published {new Date(item.publishedAt).toLocaleDateString()} ·{" "}
                {item.viewCount} view{item.viewCount === 1 ? "" : "s"}
              </span>
            )}
            {needsAttention ? (
              <Badge variant="destructive">needs attention</Badge>
            ) : (
              <Badge variant="secondary">ready</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {needsAttention ? (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {item.error ?? "Preparation failed."} Resolve from the prospect page.
          </p>
        ) : (
          <>
            <DeltaLine item={item} />
            {item.findingTitle && (
              <p className="text-sm">
                <span className="font-medium">Finding:</span> {item.findingTitle}
              </p>
            )}
            {warnings.map((warning) => (
              <p
                key={warning.id}
                className="flex items-start gap-2 text-sm text-muted-foreground"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden />
                {warning.detail}
              </p>
            ))}

            <div className="grid gap-2">
              <Label htmlFor={`hf-${item.id}`}>
                Human finding — one verified observation, in your words (required)
              </Label>
              <Textarea
                id={`hf-${item.id}`}
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={3}
                placeholder="What you verified about their public footprint, with the source below."
              />
              <div className="grid gap-2 sm:grid-cols-3">
                <Input
                  aria-label="Source label"
                  value={sourceLabel}
                  onChange={(event) => setSourceLabel(event.target.value)}
                  placeholder="Source label"
                />
                <Input
                  aria-label="Source URL"
                  value={sourceUrl}
                  onChange={(event) => setSourceUrl(event.target.value)}
                  placeholder="https://source"
                />
                <Input
                  aria-label="Source date"
                  value={sourceDate}
                  onChange={(event) => setSourceDate(event.target.value)}
                  placeholder="YYYY-MM-DD"
                />
              </div>
            </div>

            {isStale && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={ackStale}
                  onChange={(event) => setAckStale(event.target.checked)}
                  className="size-4"
                />
                Publish despite the stale benchmark (recorded in the audit log)
              </label>
            )}
            {warnings.length > 0 && (
              <div className="grid gap-1">
                <Label htmlFor={`ack-${item.id}`}>
                  Reason to publish over the warnings (10+ characters; required if
                  publish refuses without it)
                </Label>
                <Textarea
                  id={`ack-${item.id}`}
                  value={ackReason}
                  onChange={(event) => setAckReason(event.target.value)}
                  rows={2}
                  placeholder="Why this is safe to ship anyway."
                />
              </div>
            )}
          </>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          {!needsAttention && (
            <Button onClick={approve} disabled={pending}>
              <CheckCircle2 className="size-4" aria-hidden />
              {pending ? "Publishing…" : "Approve & publish"}
            </Button>
          )}
          <Button variant="outline" onClick={hold} disabled={pending}>
            Hold
          </Button>
          <Button variant="ghost" asChild>
            <Link href={`/prospects/${item.prospectId}`}>
              Open prospect <ArrowRight className="size-4" aria-hidden />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
