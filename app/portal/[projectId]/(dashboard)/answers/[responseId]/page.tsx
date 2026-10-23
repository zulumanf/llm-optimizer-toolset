import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser, ProjectAccessError } from "@/lib/auth";
import { portalAnswer } from "@/lib/portal/delivery";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

/** One stored answer, verbatim (spec 154). Readable only when it is evidence
 * behind this client's own frozen measurement — anything else is a 404. */
export default async function PortalAnswerPage({ params }: { params: Promise<{ projectId: string; responseId: string }> }) {
  const { projectId, responseId } = await params;
  let answer;
  try {
    answer = await portalAnswer(await getCurrentUser(), projectId, responseId);
  } catch (err) {
    if (err instanceof ProjectAccessError) notFound();
    throw err;
  }
  return (
    <article className="space-y-4">
      <Link href={`/portal/${projectId}/results`} className="text-sm text-muted-foreground underline-offset-2 hover:underline">← Back to results</Link>
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Question asked</p>
        <h2 className="mt-1 text-lg font-medium">{answer.question}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {answer.providerLabel} · {answer.model} · repetition {answer.repetition} · captured {formatDate(answer.capturedAt)}
        </p>
      </div>
      <div className="rounded-md border p-4">
        <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Original answer, unedited</p>
        <div className="whitespace-pre-wrap break-words text-sm">{answer.answer ?? "No text was returned for this answer."}</div>
      </div>
      <section aria-labelledby="sources-title">
        <h3 id="sources-title" className="text-sm font-medium">Sources the answer cited ({answer.citations.length})</h3>
        {answer.citations.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">No sources were cited in this answer.</p>
        ) : (
          <ul className="mt-1 space-y-1 text-sm">
            {answer.citations.map((c) => (
              <li key={c.url} className="break-all">
                <a href={c.url} rel="noopener noreferrer nofollow" target="_blank" className="underline-offset-2 hover:underline">{c.domain}</a>
                <span className="text-xs text-muted-foreground"> {c.url}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">A cited source appeared alongside the answer; it does not prove the source caused a recommendation.</p>
      </section>
    </article>
  );
}
