"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  createTaskFromFinding,
  dismissFinding,
  reopenFinding,
} from "@/app/gaps/actions";

interface Props {
  finding: {
    id: string;
    gapType: string;
    findingText: string;
    promptCategory: string | null;
    severity: number;
    opportunityScore: number;
    status: string;
    runLabel: string;
    createdAt: string;
    /** Epistemics (spec 064) — null on pre-064 detector-v1 rows. */
    classification: string | null;
    confidence: number | null;
    evidenceCount: number;
  };
}

/** Sentence-case label for the stored classification enum. */
const CLASSIFICATION_LABELS: Record<string, string> = {
  observation: "observation",
  supported_finding: "supported finding",
  working_hypothesis: "working hypothesis",
  unknown: "unknown",
};

export function FindingCard({ finding }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const act = (fn: () => Promise<{ ok: boolean; error?: { message: string } }>, done: string) =>
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
    <Card className={finding.status !== "open" ? "opacity-60" : ""}>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{finding.gapType.replace(/_/g, " ")}</Badge>
          {finding.promptCategory && (
            <Badge variant="outline">{finding.promptCategory}</Badge>
          )}
          <Badge variant="secondary">score {finding.opportunityScore.toFixed(0)}</Badge>
          {finding.classification ? (
            <Badge variant="outline">
              {CLASSIFICATION_LABELS[finding.classification] ?? finding.classification}
            </Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              not classified
            </Badge>
          )}
          {finding.confidence != null && (
            <Badge variant="outline" className="tabular-nums">
              confidence {finding.confidence.toFixed(1)}
            </Badge>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            {finding.evidenceCount > 0 &&
              `${finding.evidenceCount} evidence ${
                finding.evidenceCount === 1 ? "ref" : "refs"
              } · `}
            {finding.runLabel} · {finding.createdAt}
          </span>
        </div>
        <p className="text-sm">{finding.findingText}</p>
        {finding.status === "open" ? (
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await dismissFinding({ findingId: finding.id });
                  if (!result.ok) {
                    toast.error(result.error.message);
                    return;
                  }
                  router.refresh();
                  toast.success("Dismissed.", {
                    action: {
                      label: "Undo",
                      onClick: () =>
                        startTransition(async () => {
                          const undo = await reopenFinding({ findingId: finding.id });
                          if (undo.ok) {
                            toast.success("Restored.");
                            router.refresh();
                          } else {
                            toast.error(undo.error.message);
                          }
                        }),
                    },
                  });
                })
              }
            >
              Dismiss
            </Button>
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                act(
                  () => createTaskFromFinding({ findingId: finding.id }),
                  "Suggested task created (awaiting approval on the Tasks board)."
                )
              }
            >
              Create task
            </Button>
          </div>
        ) : (
          <p className="text-right text-xs text-muted-foreground">{finding.status}</p>
        )}
      </CardContent>
    </Card>
  );
}
