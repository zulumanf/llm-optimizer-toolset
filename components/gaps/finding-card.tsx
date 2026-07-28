"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { createTaskFromFinding, dismissFinding } from "@/app/gaps/actions";

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
  };
}

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
          <span className="ml-auto text-xs text-muted-foreground">
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
                act(() => dismissFinding({ findingId: finding.id }), "Dismissed.")
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
