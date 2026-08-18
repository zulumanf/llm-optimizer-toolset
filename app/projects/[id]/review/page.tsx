import { PageHeader, PageShell } from "@/components/layout/page";
import { notFound } from "next/navigation";
import { CheckCheck } from "lucide-react";
import { getProject } from "@/db/projects";
import { listReviewQueue } from "@/db/mentions";
import { ReviewQueue } from "@/components/review/review-queue";
import { ProjectTabs } from "@/components/layout/project-tabs";

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();
  const queue = await listReviewQueue(id);

  return (
    <PageShell>
      <ProjectTabs projectId={id} setKey="measure" counts={{ "/review": queue.length }} />
      <PageHeader
        crumbs={[
          { label: "Projects", href: "/projects" },
          { label: project.name, href: `/projects/${id}` },
          { label: "Review" },
        ]}
        title={`Review queue${queue.length > 0 ? ` — ${queue.length} item${queue.length === 1 ? "" : "s"}` : ""}`}
        description="Low-confidence classifications await a human verdict. Judge only what the response says — scoring stays blocked until this queue is clear (docs/07 step 6)."
      />

      {queue.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
          <CheckCheck className="size-8 text-success" />
          <p className="text-sm text-muted-foreground">
            Queue is clear — scoring is unblocked for all runs.
          </p>
        </div>
      ) : (
        <ReviewQueue items={queue} />
      )}
    </PageShell>
  );
}
