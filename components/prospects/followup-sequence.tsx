import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Section } from "@/components/layout/page";
import {
  FollowupPauseAll,
  FollowupSequenceControls,
} from "@/components/prospects/followup-controls";
import {
  getFollowupSequence,
  listFollowupSequences,
  renderNextTouch,
  type FollowupSequenceView,
} from "@/lib/prospects/followups";
import { OUTREACH_TEMPLATE_LABELS } from "@/lib/prospects/constants";
import { wallClock } from "@/lib/prospects/business-days";

function local(d: Date | null, tz: string): string {
  if (!d) return "—";
  const w = wallClock(d, tz);
  const zone = tz.split("/")[1]?.replace("_", " ") ?? tz;
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")} ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")} (${zone})`;
}

const STATE_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  REPLIED: "default", REPLY_NEEDS_REVIEW: "destructive", STOPPED: "destructive", BOUNCED: "destructive", SUPPRESSED: "destructive",
  OOO_PAUSED: "secondary", PAUSED: "secondary", COMPLETE_NO_REPLY: "outline",
};

function StateBadge({ state }: { state: string }) {
  return <Badge variant={STATE_VARIANT[state] ?? "outline"}>{state.replaceAll("_", " ")}</Badge>;
}

/** Prospect detail: the one sequence this prospect is in, its next touch as
 * it would render right now, and the founder controls. */
export async function FollowupSequenceCard({ prospectId }: { prospectId: string }) {
  const [view] = await listFollowupSequences({ prospectId });
  if (!view) return null;
  const seq = await getFollowupSequence(view.sequenceId);
  const next = seq && seq.status === "active" && seq.nextTouch ? await renderNextTouch(seq, new Date()) : null;
  const s = seq?.evidenceSnapshot;
  return (
    <div className="rounded-md border p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">Follow-up sequence</span>
          <StateBadge state={view.displayState} />
          {view.stopReason && <span className="text-xs text-muted-foreground">{view.stopReason}</span>}
        </div>
        <FollowupSequenceControls sequenceId={view.sequenceId} status={view.status} />
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <dt className="text-muted-foreground">Touch 1 delivered</dt><dd>{local(view.touch1SentAt, view.timezone)}</dd>
        <dt className="text-muted-foreground">Next touch</dt><dd>{view.nextTouch ? `Touch ${view.nextTouch} · ${local(view.nextSlot, view.timezone)}` : "—"}</dd>
        <dt className="text-muted-foreground">Engagement now</dt><dd>{next ? `${next.engagement.state.replaceAll("_", " ")} — ${next.engagement.reason}` : view.queued?.engagement?.replaceAll("_", " ") ?? "—"}</dd>
        <dt className="text-muted-foreground">Branch</dt><dd>{view.queued ? `${view.queued.branch} (queued)` : next ? `${next.branch}${next.claimVariant ? ` · ${next.claimVariant.replaceAll("_", " ")}` : ""}` : "—"}</dd>
        <dt className="text-muted-foreground">Frozen evidence</dt>
        <dd className="col-span-3">
          {s ? `${s.prospect.name} ${s.prospect.productionDisplay} · ${s.prospect.recommendationCount} of ${s.answerCount} vs ${s.competitor.name} ${s.competitor.productionDisplay} · ${s.competitor.recommendationCount} of ${s.answerCount} (${s.provider}, ${seq.distinctCompetitorQuestions} distinct questions)` : "—"}
        </dd>
        <dt className="text-muted-foreground">Replies</dt>
        <dd className="col-span-3">{view.replies.length === 0 ? "none recorded" : view.replies.map((r) => `${r.classification} after touch ${r.afterTouch}`).join(" · ")}</dd>
        {view.handoff && (
          <>
            <dt className="text-muted-foreground">Next action</dt>
            <dd className="col-span-3 font-medium">Positive reply · Report: {view.handoff.reportState.replaceAll("_", " ")} · {view.handoff.nextAction}</dd>
          </>
        )}
        {view.status === "active" && (
          <>
            <dt className="text-muted-foreground">Sequence expires</dt>
            <dd className="col-span-3">{local(view.expiresAt, view.timezone)}</dd>
          </>
        )}
      </dl>
      {view.touches.length > 1 && (
        <ul className="text-xs text-muted-foreground">
          {view.touches.map((t) => (
            <li key={`${t.touch}-${t.sentAt.toISOString()}`}>Touch {t.touch} · {t.template ? OUTREACH_TEMPLATE_LABELS[t.template] ?? t.template : "—"} · {local(t.sentAt, view.timezone)} · {t.opens} opens{t.gmailThreadId ? ` · thread ${t.gmailThreadId.slice(0, 8)}` : ""}</li>
          ))}
        </ul>
      )}
      {(next || view.queued) && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {view.queued ? "Queued copy" : "Next touch as it would render now"}{next?.qa.length ? ` · QA: ${next.qa.map((i) => i.detail).join(" ")}` : ""}
          </summary>
          <p className="mt-2 font-medium">{next?.subject ?? view.queued?.template}</p>
          {next && <pre className="mt-1 whitespace-pre-wrap rounded bg-muted p-3 text-xs">{next.body}</pre>}
          {next && <p className="mt-1 text-xs text-muted-foreground">{next.newThread ? "New thread" : "Reply in existing thread"} · {OUTREACH_TEMPLATE_LABELS[next.version] ?? next.version}</p>}
        </details>
      )}
    </div>
  );
}

/** Prospects dashboard (operate): every sequence of the experiment. */
export async function FollowupSequencesSection() {
  const views = await listFollowupSequences();
  if (views.length === 0) return null;
  const active = views.filter((v) => v.status === "active").length;
  const pausedAll = views.filter((v) => v.displayState === "PAUSED").length;
  const counts = views.reduce<Record<string, number>>((acc, v) => {
    acc[v.displayState] = (acc[v.displayState] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <Section
      title="Follow-up sequences"
      description={<>{Object.entries(counts).map(([k, n]) => `${k.replaceAll("_", " ")} ${n}`).join(" · ")}</>}
      actions={<FollowupPauseAll activeCount={active} pausedAllCount={pausedAll} />}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr><th className="py-1 pr-3">Prospect</th><th className="pr-3">Market</th><th className="pr-3">T1</th><th className="pr-3">State</th><th className="pr-3">Next</th><th className="pr-3">Branch</th><th className="pr-3">Reply</th><th>Stop reason</th></tr>
          </thead>
          <tbody>
            {views.map((v: FollowupSequenceView) => (
              <tr key={v.sequenceId} className="border-t">
                <td className="py-1 pr-3"><Link href={`/prospects/${v.prospectId}`} className="underline-offset-2 hover:underline">{v.businessName}</Link></td>
                <td className="pr-3 text-muted-foreground">{v.market.split(" — ")[0]}</td>
                <td className="pr-3 tabular-nums">{local(v.touch1SentAt, v.timezone).slice(0, 10)}</td>
                <td className="pr-3"><StateBadge state={v.displayState} /></td>
                <td className="pr-3 tabular-nums">{v.nextTouch ? `T${v.nextTouch} ${local(v.nextSlot, v.timezone)}` : "—"}</td>
                <td className="pr-3">{v.queued?.branch ?? "—"}</td>
                <td className="pr-3">{v.handoff ? `positive · report ${v.handoff.reportState.replaceAll("_", " ").toLowerCase()}` : v.replies.length ? v.replies[v.replies.length - 1]!.classification.replaceAll("_", " ") : "—"}</td>
                <td className="text-muted-foreground">{v.stopReason ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
