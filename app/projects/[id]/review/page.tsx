import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCheck } from "lucide-react";
import { getProject } from "@/db/projects";
import { listReviewQueue } from "@/db/mentions";
import { ReviewQueue } from "@/components/review/review-queue";

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
    <div className="mx-auto max-w-5xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Projects</Link>
        {" / "}
        <Link href={`/projects/${id}`} className="hover:text-foreground">
          {project.name}
        </Link>
        {" / "}Review
      </nav>
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">
          Review queue{queue.length > 0 ? ` — ${queue.length} item${queue.length === 1 ? "" : "s"}` : ""}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Low-confidence classifications await a human verdict. Judge only what
          the response says — scoring stays blocked until this queue is clear
          (docs/07 step 6).
        </p>
      </div>

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
    </div>
  );
}
