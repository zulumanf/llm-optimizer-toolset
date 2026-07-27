"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { reviewMention } from "@/app/classification/actions";
import { SENTIMENTS, type Sentiment } from "@/lib/constants";
import type { ReviewQueueItem } from "@/db/mentions";

export function ReviewCard({ item }: { item: ReviewQueueItem }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [mentioned, setMentioned] = useState(item.mentioned);
  const [recommended, setRecommended] = useState(item.recommended);
  const [position, setPosition] = useState<string>(
    item.listPosition != null ? String(item.listPosition) : ""
  );
  const [sentiment, setSentiment] = useState<Sentiment>(item.sentiment);

  const submit = (verdict: "confirm" | "correct") =>
    startTransition(async () => {
      const result = await reviewMention({
        mentionId: item.id,
        verdict,
        corrections:
          verdict === "correct"
            ? {
                mentioned,
                recommended,
                listPosition: position === "" ? null : Number(position),
                sentiment,
              }
            : undefined,
      });
      if (result.ok) {
        toast.success(verdict === "confirm" ? "Confirmed." : "Correction saved.");
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{item.companyName}</span>
          <Badge variant="outline">conf {Number(item.confidence).toFixed(2)}</Badge>
          <Badge variant="secondary">{item.provider} · {item.model}</Badge>
          <span className="text-muted-foreground">{item.runLabel}</span>
          <Link
            href={`/projects/${item.projectId}/runs/${item.runId}/responses/${item.responseId}`}
            className="ml-auto text-xs text-muted-foreground underline hover:text-foreground"
          >
            full response
          </Link>
        </div>

        {item.excerpt && (
          <blockquote className="border-l-2 pl-3 font-mono text-sm text-muted-foreground">
            “{item.excerpt}”
          </blockquote>
        )}

        <div className="flex flex-wrap items-center gap-4 text-sm">
          <span>
            mentioned: <strong>{String(item.mentioned)}</strong>
          </span>
          <span>
            recommended: <strong>{String(item.recommended)}</strong>
          </span>
          <span>
            position: <strong>{item.listPosition ?? "—"}</strong>
          </span>
          <span>
            sentiment: <strong>{item.sentiment}</strong>
          </span>
        </div>

        {editing && (
          <div className="flex flex-wrap items-end gap-4 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id={`m-${item.id}`}
                checked={mentioned}
                onChange={(e) => setMentioned(e.target.checked)}
                className="size-4"
              />
              <Label htmlFor={`m-${item.id}`}>mentioned</Label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id={`r-${item.id}`}
                checked={recommended}
                onChange={(e) => setRecommended(e.target.checked)}
                className="size-4"
              />
              <Label htmlFor={`r-${item.id}`}>recommended</Label>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor={`p-${item.id}`}>position</Label>
              <Input
                id={`p-${item.id}`}
                type="number"
                min={1}
                value={position}
                onChange={(e) => setPosition(e.target.value)}
                className="w-16"
              />
            </div>
            <div className="flex items-center gap-2">
              <Label>sentiment</Label>
              <Select value={sentiment} onValueChange={(v) => setSentiment(v as Sentiment)}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SENTIMENTS.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          {editing ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={pending}>
                Back
              </Button>
              <Button size="sm" onClick={() => submit("correct")} disabled={pending}>
                Save correction
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => setEditing(true)} disabled={pending}>
                Correct…
              </Button>
              <Button size="sm" onClick={() => submit("confirm")} disabled={pending}>
                Confirm as parsed
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
