"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import type { QuestionReviewDecision, QuestionReviewView, ReviewedQuestionView } from "@/lib/engagements/client-question-review";
import type { ActionResult } from "@/lib/actions/result";
import { ONBOARDING_COPY, QUESTION_REVIEW_COPY as COPY } from "@/lib/portal/client-copy";
import { approveRemainingQuestions, reviewQuestions, submitQuestionReview } from "@/app/portal/[projectId]/actions";

const DECISION_LABEL: Record<QuestionReviewDecision, string> = {
  approved: "Approved",
  edit_requested: "Edit requested",
  removed: "Remove",
};

function useRun() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const run = <T,>(fn: () => Promise<ActionResult<T>>, onOk?: () => void) => {
    setError(null);
    start(async () => {
      try {
        const r = await fn();
        if (r.ok) {
          onOk?.();
          router.refresh();
        } else setError(r.error.message);
      } catch {
        setError(ONBOARDING_COPY.genericError);
      }
    });
  };
  return { pending, error, run };
}

/**
 * The client's review of the proposed customer questions (spec 155). Every
 * click saves (append-only on the server), so leaving and returning resumes
 * exactly where the client stopped. Nothing is approved by viewing.
 */
export function QuestionReview({ projectId, view }: { projectId: string; view: QuestionReviewView }) {
  const { pending, error, run } = useRun();
  const done = view.remaining === 0;

  return (
    <div className="space-y-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-medium">{COPY.title}</h2>
        <p className="mt-2 text-muted-foreground">{COPY.why}</p>
        {view.canRespond && <p className="mt-2 text-sm text-muted-foreground">{COPY.how}</p>}
        {view.readOnlyReason && !view.locked && (
          <p className="mt-3 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
            {view.readOnlyReason === "viewer" ? COPY.viewerNote : COPY.previewNote}
          </p>
        )}
      </div>

      {view.locked && <p className="rounded-md bg-muted px-4 py-3 text-sm">{COPY.locked}</p>}
      {!view.locked && view.submitted?.decision === "changes_requested" && <p className="rounded-md bg-muted px-4 py-3 text-sm">{COPY.changesSent}</p>}
      {!view.locked && view.submitted?.decision === "acknowledged" && (
        <div className="rounded-md bg-muted px-4 py-3 text-sm">
          <p>{COPY.reviewSent}</p>
          {view.plan?.ready && (
            <Link href={`/portal/${projectId}/approvals/measurement`} className="mt-2 inline-flex min-h-11 items-center rounded-sm font-medium underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Review and approve your measurement plan
            </Link>
          )}
        </div>
      )}

      <div className="rounded-lg border bg-background px-5 py-4 sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1">
            <p className="tabular-nums" aria-live="polite">
              <span className="font-medium">{view.reviewed} of {view.total} reviewed</span>
              <span className="text-muted-foreground"> · {view.remaining} remaining</span>
            </p>
            <progress
              value={view.reviewed}
              max={Math.max(1, view.total)}
              aria-label="Questions reviewed"
              className="mt-2 h-1.5 w-full max-w-sm appearance-none overflow-hidden rounded-full bg-muted [&::-moz-progress-bar]:bg-foreground [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-foreground"
            />
          </div>
          {view.canRespond && (
            <div className="flex flex-col gap-2 sm:flex-row">
              {!done && (
                <Button variant="outline" className="h-11" disabled={pending} onClick={() => run(() => approveRemainingQuestions(projectId, view.versionId, null))}>
                  Approve all remaining ({view.remaining})
                </Button>
              )}
              <Button className="h-11" disabled={pending || !done || view.submitted?.decision === "changes_requested"} onClick={() => run(() => submitQuestionReview(projectId, view.versionId))}>
                Send my review
              </Button>
            </div>
          )}
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
        {view.canRespond && <p className="mt-3 text-xs text-muted-foreground">{done ? COPY.sendHint : `Your choices are saved as you go. ${COPY.sendHint}`}</p>}
      </div>

      {view.groups.map((g, n) => {
        const left = g.questions.filter((q) => !q.decision && !q.carried).length;
        // Compact by default: only the first group with work left is open.
        const firstOpen = view.groups.findIndex((x) => x.questions.some((q) => !q.decision && !q.carried));
        return (
          <details key={g.segment} open={n === (firstOpen === -1 ? 0 : firstOpen)} className="group rounded-lg border bg-background">
            <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 rounded-lg px-5 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-6 [&::-webkit-details-marker]:hidden">
              <h3 className="font-medium">
                {g.segment}{" "}
                <span className="text-sm font-normal text-muted-foreground tabular-nums">
                  · {g.questions.length} questions · {left > 0 ? `${left} left` : "all reviewed"}
                </span>
              </h3>
              <span className="text-sm text-muted-foreground group-open:hidden">Show</span>
              <span className="hidden text-sm text-muted-foreground group-open:inline">Hide</span>
            </summary>
            {view.canRespond && left > 0 && (
              <div className="border-t px-5 py-2 sm:px-6">
                <Button variant="ghost" size="sm" className="-ml-3 h-9" disabled={pending} onClick={() => run(() => approveRemainingQuestions(projectId, view.versionId, g.segment))}>
                  Approve the {left} remaining in this group
                </Button>
              </div>
            )}
            <ol className="divide-y border-t">
              {g.questions.map((q) => (
                <QuestionRow key={q.promptId} projectId={projectId} versionId={view.versionId} q={q} canRespond={view.canRespond} />
              ))}
            </ol>
          </details>
        );
      })}
    </div>
  );
}

function QuestionRow({ projectId, versionId, q, canRespond }: { projectId: string; versionId: string; q: ReviewedQuestionView; canRespond: boolean }) {
  const { pending, error, run } = useRun();
  const [asking, setAsking] = useState<"edit_requested" | "removed" | null>(null);
  const [comment, setComment] = useState(q.comment);
  const decide = (decision: QuestionReviewDecision, note: string) =>
    run(() => reviewQuestions(projectId, versionId, [{ promptId: q.promptId, decision, comment: note }]), () => setAsking(null));
  const commentId = `c-${q.promptId}`;

  return (
    <li className="px-5 py-3 sm:px-6">
      <div className="sm:flex sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <p className={q.decision === "removed" ? "text-muted-foreground line-through" : undefined}>{q.text}</p>
          {q.neighborhood && <p className="mt-0.5 text-xs text-muted-foreground">{q.neighborhood}</p>}
          {!q.decision && q.carried && <p className="mt-1 text-sm text-muted-foreground">{COPY.carried}</p>}
          {!q.decision && !q.carried && q.revised && <p className="mt-1 text-sm font-medium">{COPY.revised}</p>}
          {q.decision && !asking && (
            <p className="mt-1 text-sm text-muted-foreground">
              {q.decision === "removed" ? "Marked for removal" : DECISION_LABEL[q.decision]}
              {q.comment ? ` — “${q.comment}”` : ""}
            </p>
          )}
        </div>
        {canRespond && !asking && (
          <div className="mt-2 flex shrink-0 flex-wrap gap-1.5 sm:mt-0" role="group" aria-label="Your decision on this question">
            <Choice active={q.decision === "approved" || (!q.decision && q.carried)} disabled={pending} onClick={() => decide("approved", "")}>Approve</Choice>
            <Choice active={q.decision === "edit_requested"} disabled={pending} onClick={() => setAsking("edit_requested")}>Request edit</Choice>
            <Choice active={q.decision === "removed"} disabled={pending} onClick={() => setAsking("removed")}>Remove</Choice>
          </div>
        )}
      </div>

      {canRespond && asking && (
        <form
          className="mt-3 space-y-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            decide(asking, comment.trim());
          }}
        >
          <Label htmlFor={commentId} className="text-sm font-normal text-muted-foreground">
            {asking === "edit_requested" ? "What should we change? (optional)" : "Anything we should know? (optional)"}
          </Label>
          <Textarea id={commentId} rows={2} maxLength={1000} value={comment} onChange={(ev) => setComment(ev.target.value)} autoFocus />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" className="h-10" disabled={pending}>
              {asking === "edit_requested" ? "Request edit" : "Remove question"}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-10" disabled={pending} onClick={() => setAsking(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </li>
  );
}

function Choice({ active, disabled, onClick, children }: { active: boolean; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button type="button" size="sm" variant={active ? "default" : "outline"} aria-pressed={active} className="h-10 px-3" disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}

