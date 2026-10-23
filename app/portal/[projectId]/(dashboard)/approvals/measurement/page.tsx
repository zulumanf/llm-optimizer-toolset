import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { requirePortalPage } from "@/lib/security/page-gates";
import { portalApprovals } from "@/lib/portal/delivery";
import { portalQuestionReview } from "@/lib/engagements/client-question-review";
import { MEASUREMENT_CAVEATS } from "@/lib/engagements/delivery-rules";
import { MeasurementPlanApproval } from "@/components/portal/measurement-plan-approval";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * The measurement plan (spec 155 R3): exactly what the approver signs — the
 * final question version, what counts as a recommendation, the method and
 * the success target — and, when everything is ready, the binding approval.
 */
export default async function PortalMeasurementPlanPage({ params }: { params: Promise<{ projectId: string }> }) {
  await requirePortalPage((await params).projectId);
  const { projectId } = await params;
  const user = await getCurrentUser();
  const [approvals, review] = await Promise.all([portalApprovals(user, projectId), portalQuestionReview(user, projectId)]);
  const p = approvals?.protocol ?? null;
  const back = (
    <p className="text-sm">
      <Link href={`/portal/${projectId}/approvals`} className="rounded-sm text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        ← Approvals
      </Link>
    </p>
  );
  if (!p || !review) {
    return (
      <div className="space-y-4">
        {back}
        <p className="rounded-lg border border-dashed p-8 text-muted-foreground">
          We&apos;re still preparing your measurement plan. We&apos;ll let you know when it&apos;s ready for you.
        </p>
      </div>
    );
  }
  const accepted = p.status === "accepted";
  return (
    <div className="space-y-6">
      {back}
      <div className="max-w-2xl">
        <h2 className="text-lg font-medium">Your measurement plan</h2>
        <p className="mt-2 text-muted-foreground">
          This is how we&apos;ll measure whether AI assistants recommend you — the same way at the start and at the end, so the
          comparison is fair.
        </p>
      </div>

      {accepted && (
        <p className="rounded-md bg-muted px-4 py-3 text-sm">
          Approved by {p.acceptedByName ?? "you"}
          {p.acceptedAt ? ` on ${formatDate(p.acceptedAt)}` : ""}. This plan is now fixed for your engagement.
        </p>
      )}

      <dl className="divide-y rounded-lg border bg-background">
        <Row label="The questions">
          {review.total} customer questions — “{review.setName}”, version {review.version}.{" "}
          <Link href={`/portal/${projectId}/approvals/questions`} className="rounded-sm underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            See every question
          </Link>
        </Row>
        <Row label="What counts as a recommendation">{p.recommendationRubric}</Row>
        <Row label="How we measure">
          {p.providerLabel} — {p.model}. Each question asked {p.repetitions} time(s){p.geographicContext ? `, ${p.geographicContext}` : ""}.
        </Row>
        <Row label="When">
          Starting point: {p.baselineWindow || "to be scheduled"} · Final: {p.finalWindow || "to be scheduled"}
        </Row>
        <Row label="Success target">{p.successCriteria || "To be agreed"}</Row>
      </dl>

      <details className="rounded-lg border bg-background px-5 py-4 text-sm">
        <summary className="cursor-pointer font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">What these numbers do and don&apos;t mean</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
          {MEASUREMENT_CAVEATS.map((c) => <li key={c}>{c}</li>)}
          {p.comparisonRules && <li>{p.comparisonRules}</li>}
          {p.caveats && <li>{p.caveats}</li>}
        </ul>
      </details>

      {!accepted && review.plan && (
        review.plan.ready && review.canRespond ? (
          <MeasurementPlanApproval projectId={projectId} versionId={review.versionId} protocolId={review.plan.protocolId} questionCount={review.total} setLabel={`“${review.setName}”, version ${review.version}`} />
        ) : (
          <p className="rounded-md bg-muted px-4 py-3 text-sm text-muted-foreground">
            {review.readOnlyReason === "viewer"
              ? "Your approver approves this plan."
              : review.readOnlyReason === "staff_preview"
                ? "Preview — only the client's approver can approve this plan."
                : review.plan.blockers[0]}
          </p>
        )
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 px-5 py-4 sm:grid-cols-[14rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}
