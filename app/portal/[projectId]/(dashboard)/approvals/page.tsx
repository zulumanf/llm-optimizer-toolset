import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { segmentOf } from "@/lib/engagements/question-review";
import { portalApprovals } from "@/lib/portal/delivery";
import { Badge } from "@/components/ui/badge";
import { NoEngagement, SectionCard } from "@/components/portal/delivery-blocks";
import { formatDate } from "@/lib/format";
import { DetailsCorrection } from "@/components/portal/details-correction";
import { requirePortalPage } from "@/lib/security/page-gates";

export const dynamic = "force-dynamic";

const CHANGE_STATUS = {
  waiting: { label: "Waiting for you", variant: "destructive" },
  approved: { label: "Approved", variant: "outline" },
  declined: { label: "Declined", variant: "secondary" },
  edit_requested: { label: "Edit requested", variant: "secondary" },
} as const;

const REPLY = "Review your customer questions right here. For the changes we propose, reply to our email or tell us on a call — we record your decision here with the date and the exact wording you approved.";

/** Approvals (spec 154): business details on file, the proposed questions,
 * the measurement protocol, proposed public changes with exact wording, and
 * the full decision trail. Read-only — decisions are recorded by us from the
 * channel you used. */
export default async function PortalApprovalsPage({ params }: { params: Promise<{ projectId: string }> }) {
  await requirePortalPage((await params).projectId);
  const { projectId } = await params;
  const v = await portalApprovals(await getCurrentUser(), projectId);
  if (!v) return <NoEngagement />;
  const grouped = new Map<string, NonNullable<typeof v.questionSet>["questions"]>();
  for (const q of v.questionSet?.questions ?? []) {
    const key = segmentOf(q);
    grouped.set(key, [...(grouped.get(key) ?? []), q]);
  }
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">Approvals</h2>
        <p className="max-w-prose text-sm text-muted-foreground">{REPLY} Nothing public changes without your approval.</p>
      </div>

      <SectionCard title="Changes we propose" id="changes">
        {v.changes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No changes proposed yet.</p>
        ) : (
          <ul className="space-y-3">
            {v.changes.map((c) => (
              <li key={c.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="font-medium">{c.title}</p>
                  <Badge variant={CHANGE_STATUS[c.status].variant}>{CHANGE_STATUS[c.status].label}</Badge>
                </div>
                {c.targetUrl && <p className="mt-1 break-all text-xs text-muted-foreground">Where: {c.targetUrl}</p>}
                {c.why && <p className="mt-1 text-muted-foreground">Why: {c.why}</p>}
                {c.currentText && <p className="mt-2"><span className="text-xs uppercase tracking-wide text-muted-foreground">Now</span><br />{c.currentText}</p>}
                {c.proposedText && (
                  <blockquote className="mt-2 border-l-2 pl-3"><span className="text-xs uppercase tracking-wide text-muted-foreground">Exact proposed wording</span><br />{c.proposedText}</blockquote>
                )}
                {c.evidenceCount > 0 && <p className="mt-1 text-xs text-muted-foreground">Supported by {c.evidenceCount} stored answer(s).</p>}
                {c.history.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Decision history ({c.history.length})</summary>
                    <ul className="mt-1 space-y-1 text-xs">
                      {c.history.map((h, n) => (
                        <li key={n}>{formatDate(h.decidedAt)} · {h.decision.replace(/_/g, " ")} by {h.clientActor ?? "you"} via {h.channel}{h.note ? ` — "${h.note}"` : ""}{h.wording ? ` · wording: "${h.wording}"` : ""}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Questions we will measure" id="questions">
        {!v.questionSet ? (
          <p className="text-sm text-muted-foreground">We are preparing the proposed questions with you.</p>
        ) : (
          <div className="space-y-3 text-sm">
            <p>
              {v.questionSet.questions.length} questions ·{" "}
              <Badge variant={v.questionSet.status === "approved" ? "outline" : "destructive"}>{v.questionSet.status === "approved" ? "Approved" : v.questionSet.status === "changes_requested" ? "Changes requested" : "Waiting for your review"}</Badge>
            </p>
            <p className="text-muted-foreground">{[...grouped.entries()].map(([segment, qs]) => `${segment}: ${qs.length}`).join(" · ")}</p>
            <p className="text-xs text-muted-foreground">These are written the way a homeowner would ask, without naming you or any competitor. Once approved, this exact set is fixed and used for every measurement.</p>
            <Link href={`/portal/${projectId}/approvals/questions`} className="inline-flex min-h-11 items-center rounded-sm font-medium underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {v.questionSet.status === "approved" ? "View the questions" : "Review the questions"}
            </Link>
          </div>
        )}
      </SectionCard>

      <SectionCard title="How success is measured" id="protocol" action={{ href: `/portal/${projectId}/approvals/measurement`, label: v.protocol?.status === "accepted" ? "View the plan" : "Review the plan" }}>
        {!v.protocol ? (
          <p className="text-sm text-muted-foreground">We will share the measurement plan after the questions are agreed.</p>
        ) : (
          <div className="space-y-2 text-sm">
            <p>
              Version {v.protocol.version} ·{" "}
              <Badge variant={v.protocol.status === "accepted" ? "outline" : "destructive"}>{v.protocol.status === "accepted" ? `Accepted by ${v.protocol.acceptedByName ?? "you"} on ${v.protocol.acceptedAt ? formatDate(v.protocol.acceptedAt) : ""}` : "Draft — waiting for your review"}</Badge>
            </p>
            <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[12rem_1fr]">
              <dt className="text-muted-foreground">Instrument</dt><dd>{v.protocol.providerLabel} — {v.protocol.model}, {v.protocol.repetitions} repetition(s) per question</dd>
              <dt className="text-muted-foreground">Geography</dt><dd>{v.protocol.geographicContext || "—"}</dd>
              <dt className="text-muted-foreground">Measurement windows</dt><dd>Baseline: {v.protocol.baselineWindow || "—"} · Final: {v.protocol.finalWindow || "—"}</dd>
              <dt className="text-muted-foreground">Names credited to you</dt><dd>{v.protocol.nameVariants.join(", ") || "—"}</dd>
              <dt className="text-muted-foreground">Success criteria</dt><dd>{v.protocol.successCriteria || "To be agreed"}</dd>
            </dl>
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Counting rules, comparison rules, caveats and disputes</summary>
              <div className="mt-2 space-y-2 whitespace-pre-line text-muted-foreground">
                <p><span className="font-medium text-foreground">Recommendation vs mention.</span> {v.protocol.recommendationRubric}</p>
                <p><span className="font-medium text-foreground">Comparison.</span> {v.protocol.comparisonRules}</p>
                <p><span className="font-medium text-foreground">Caveats.</span> {v.protocol.caveats}</p>
                <p><span className="font-medium text-foreground">Review and disputes.</span> {v.protocol.adjudication}</p>
                <p><span className="font-medium text-foreground">Other tools.</span> {v.protocol.externalSources}</p>
              </div>
            </details>
          </div>
        )}
      </SectionCard>

      {v.confirmedDetails && (
        <SectionCard title="Your details" id="your-details">
          <DetailsCorrection
            projectId={projectId}
            detailsVersion={v.confirmedDetails.detailsVersion}
            priorities={v.confirmedDetails.priorities}
            contacts={v.confirmedDetails.contacts}
            canCorrect={v.confirmedDetails.canCorrect}
          />
        </SectionCard>
      )}

      <SectionCard title="Details we have on file" id="details">
        {v.details.length === 0 ? (
          <p className="text-sm text-muted-foreground">We will walk through your details on our first call.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {v.details.map((d, n) => (
              <li key={n} className="flex flex-wrap items-center gap-2">
                <span className="break-all">{d.label}</span>
                {!d.confirmed && <Badge variant="secondary">please confirm</Badge>}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">Tell us anything that is wrong. We never ask for passwords; where we need access, please invite us as an editor.</p>
      </SectionCard>

      <SectionCard title="Decision record">
        {v.decisions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No decisions recorded yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {v.decisions.map((d, n) => (
              <li key={n}>{formatDate(d.decidedAt)} · {d.subject}: {d.decision.replace(/_/g, " ")} by {d.clientActor} via {d.channel}{d.note ? ` — "${d.note}"` : ""}</li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
