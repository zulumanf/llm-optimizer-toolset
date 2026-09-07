"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { runAuditSenseCheck } from "@/app/prospects/actions";
import type { SenseCheckRow } from "@/lib/prospects/sense-check";

/** Below this, docs/12 says the whole result needs human skepticism. */
const LOW_CONFIDENCE = 0.7;

/**
 * Spec 077: run and display the audit sense-check. The agent describes
 * problems — it never rewrites — and concern-severity findings will demand
 * an acknowledged reason at publish. Display-only component; all judgment
 * stays with the operator.
 */
export function SenseCheckPanel({
  prospectId,
  initial,
}: {
  prospectId: string;
  initial: SenseCheckRow | null;
}) {
  const [check, setCheck] = useState<SenseCheckRow | null>(initial);
  const [pending, startTransition] = useTransition();

  const runCheck = () => {
    startTransition(async () => {
      const result = await runAuditSenseCheck({ prospectId });
      if (result.ok) {
        setCheck(result.data as SenseCheckRow);
        const n = (result.data as SenseCheckRow).concerns.length;
        toast.success(
          n === 0 ? "Sense-check clean — no concerns." : `Sense-check found ${n} item(s).`
        );
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">
          Sense-check — a second read before you send
        </p>
        <Button size="sm" variant="outline" onClick={runCheck} disabled={pending}>
          <Sparkles className="size-4" aria-hidden />
          {pending ? "Reading…" : check ? "Re-run" : "Run sense check"}
        </Button>
      </div>
      {!check ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Not run yet. The agent reads the audit like a skeptical recipient
          and flags anything that doesn&apos;t make sense — publishing over a
          flagged concern requires a written reason.
        </p>
      ) : check.error ? (
        <p className="mt-1.5 flex items-start gap-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          The last run failed ({check.error}) — no result recorded. Re-run it.
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-muted-foreground">
            Checked {new Date(check.createdAt).toLocaleString()} ·{" "}
            {check.agentVersion}
            {check.confidence !== null && (
              <>
                {" "}· confidence {Math.round(check.confidence * 100)}%
                {check.confidence < LOW_CONFIDENCE && (
                  <span className="font-medium text-destructive"> — low; read skeptically</span>
                )}
              </>
            )}
            {check.confidenceNote ? ` (${check.confidenceNote})` : ""}
          </p>
          {check.concerns.length === 0 ? (
            <p className="flex items-center gap-2 text-xs">
              <CheckCircle2 className="size-4 text-muted-foreground" aria-hidden />
              No concerns. Content changes after this check make it stale.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {check.concerns.map((concern, index) => (
                <li key={index} className="flex items-start gap-2">
                  <Badge
                    variant={concern.severity === "concern" ? "destructive" : "secondary"}
                  >
                    {concern.severity === "concern" ? concern.area : `polish · ${concern.area}`}
                  </Badge>
                  <span>
                    {concern.detail}
                    {concern.quote && (
                      <span className="text-muted-foreground"> — &ldquo;{concern.quote}&rdquo;</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
