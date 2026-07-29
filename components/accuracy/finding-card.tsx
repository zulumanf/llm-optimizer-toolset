"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { setFindingStatus, createCorrectionTask } from "@/app/accuracy/actions";

interface Props {
  finding: {
    id: string;
    kind: string;
    severity: string;
    quote: string;
    rationale: string;
    status: string;
    claimText: string | null;
    promptText: string;
    runLabel: string;
    confidence: number;
    createdAt: string;
    evidenceHref: string;
  };
}

const SEVERITY_VARIANT: Record<string, "destructive" | "default" | "secondary"> = {
  high: "destructive",
  medium: "default",
  low: "secondary",
};

export function AccuracyFindingCard({ finding }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const act = (
    fn: () => Promise<{ ok: boolean; error?: { message: string } }>,
    done: string
  ) =>
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        toast.success(done);
        router.refresh();
      } else {
        toast.error(result.error?.message ?? "Action failed.");
      }
    });

  return (
    <Card className={finding.status === "open" ? "" : "opacity-70"}>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={SEVERITY_VARIANT[finding.severity] ?? "outline"}>
            {finding.severity}
          </Badge>
          <Badge variant="outline">{finding.kind.replace(/_/g, " ")}</Badge>
          {finding.status !== "open" && (
            <Badge variant="secondary">{finding.status}</Badge>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            conf {finding.confidence.toFixed(2)} · {finding.runLabel} ·{" "}
            {finding.createdAt}
          </span>
        </div>

        <p className="text-xs text-muted-foreground">
          Asked: &ldquo;{finding.promptText.slice(0, 110)}
          {finding.promptText.length > 110 ? "…" : ""}&rdquo;
        </p>

        <blockquote className="border-l-2 border-destructive/60 pl-3 text-sm italic">
          &ldquo;{finding.quote}&rdquo;
        </blockquote>

        <p className="text-sm text-muted-foreground">{finding.rationale}</p>

        {finding.claimText && (
          <p className="rounded-md bg-muted/40 p-2 text-xs">
            <span className="font-medium">Approved fact:</span> {finding.claimText}
          </p>
        )}

        <div className="flex items-center gap-2">
          <Link
            href={finding.evidenceHref}
            className="text-xs underline text-muted-foreground hover:text-foreground"
          >
            view raw evidence
          </Link>
          {finding.status === "open" && (
            <div className="ml-auto flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  act(
                    () => setFindingStatus({ findingId: finding.id, status: "dismissed" }),
                    "Dismissed."
                  )
                }
              >
                Dismiss
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  act(
                    () =>
                      setFindingStatus({ findingId: finding.id, status: "acknowledged" }),
                    "Acknowledged."
                  )
                }
              >
                Acknowledge
              </Button>
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  act(
                    () => createCorrectionTask({ findingId: finding.id }),
                    "Correction task created (awaiting approval on the Tasks board)."
                  )
                }
              >
                Create correction task
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
