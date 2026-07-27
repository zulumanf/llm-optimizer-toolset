import Link from "next/link";
import { notFound } from "next/navigation";
import { getResponse, getRun } from "@/db/runs";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";

export default async function ResponsePage({
  params,
}: {
  params: Promise<{ id: string; runId: string; responseId: string }>;
}) {
  const { id: projectId, runId, responseId } = await params;
  const [run, response] = await Promise.all([
    getRun(runId),
    getResponse(responseId),
  ]);
  if (!run || !response || response.runId !== runId || run.projectId !== projectId) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href={`/projects/${projectId}/runs/${runId}`} className="hover:text-foreground">
          {run.label}
        </Link>
        {" / "}response
      </nav>

      <div className="mb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">
            {response.provider} · {response.model} · rep {response.repetition}
          </h1>
          {response.error ? (
            <Badge variant="destructive">{response.error.kind}</Badge>
          ) : response.refusal ? (
            <Badge variant="outline">refusal</Badge>
          ) : (
            <Badge variant="secondary">captured</Badge>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {formatDate(response.requestedAt)} ·{" "}
          {response.latencyMs != null ? `${response.latencyMs}ms` : "no latency"} ·{" "}
          {response.tokensIn ?? 0} in / {response.tokensOut ?? 0} out tokens · $
          {Number(response.costUsd).toFixed(4)} · immutable capture
        </p>
      </div>

      <section className="mb-6">
        <h2 className="mb-1 text-sm font-medium text-muted-foreground">Prompt</h2>
        <pre className="whitespace-pre-wrap rounded-md border bg-muted/30 p-4 font-mono text-sm">
          {response.promptText}
        </pre>
      </section>

      {response.error ? (
        <section className="mb-6">
          <h2 className="mb-1 text-sm font-medium text-muted-foreground">Error</h2>
          <pre className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 p-4 font-mono text-sm">
            {response.error.message}
          </pre>
        </section>
      ) : (
        <section className="mb-6">
          <h2 className="mb-1 text-sm font-medium text-muted-foreground">
            Response text
          </h2>
          <pre className="whitespace-pre-wrap rounded-md border p-4 font-mono text-sm">
            {response.responseText || "(empty)"}
          </pre>
        </section>
      )}

      {response.rawPayload != null && (
        <details>
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
            Raw provider payload (verbatim)
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-md border bg-muted/30 p-4 font-mono text-xs">
            {JSON.stringify(response.rawPayload, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
