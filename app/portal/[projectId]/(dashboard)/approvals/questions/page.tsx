import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { portalQuestionReview } from "@/lib/engagements/client-question-review";
import { QuestionReview } from "@/components/portal/question-review";

export const dynamic = "force-dynamic";

/** Customer-question review (spec 155): a dashboard task, not onboarding. */
export default async function PortalQuestionReviewPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const view = await portalQuestionReview(await getCurrentUser(), projectId);
  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link href={`/portal/${projectId}/approvals`} className="rounded-sm text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          ← Approvals
        </Link>
      </p>
      {view ? (
        <QuestionReview projectId={projectId} view={view} />
      ) : (
        <p className="rounded-lg border border-dashed p-8 text-muted-foreground">
          We&apos;re still preparing your customer questions. We&apos;ll let you know as soon as they&apos;re ready for you to review.
        </p>
      )}
    </div>
  );
}
