"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { approveClaim, rejectClaim } from "@/app/knowledge/actions";

interface Props {
  claim: {
    id: string;
    claimKey: string;
    canonicalText: string;
    asOf: string | null;
    status: string;
    evidence: { url: string; note: string }[];
  };
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  approved: "secondary",
  proposed: "outline",
  superseded: "outline",
  rejected: "destructive",
};

export function ClaimCard({ claim }: Props) {
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
    <Card className={claim.status === "superseded" || claim.status === "rejected" ? "opacity-60" : ""}>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{claim.claimKey}</code>
          <Badge variant={STATUS_VARIANT[claim.status] ?? "outline"}>{claim.status}</Badge>
          {claim.asOf && (
            <span className="text-xs text-muted-foreground">as of {claim.asOf}</span>
          )}
        </div>
        <p className="text-sm">{claim.canonicalText}</p>
        {claim.evidence.length > 0 && (
          <ul className="space-y-0.5">
            {claim.evidence.map((e, i) => (
              <li key={i} className="text-xs text-muted-foreground">
                <a href={e.url} target="_blank" rel="noreferrer" className="underline">
                  {e.url}
                </a>{" "}
                — {e.note}
              </li>
            ))}
          </ul>
        )}
        {claim.status === "proposed" && (
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => act(() => rejectClaim({ claimId: claim.id }), "Rejected.")}
            >
              Reject
            </Button>
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                act(
                  () => approveClaim({ claimId: claim.id }),
                  "Approved — now agent-usable (any prior version superseded)."
                )
              }
            >
              Approve
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
