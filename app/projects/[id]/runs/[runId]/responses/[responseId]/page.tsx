import Link from "next/link";
import { notFound } from "next/navigation";
import { getResponse, getRun } from "@/db/runs";
import { sql } from "@/db/client";
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

  const [hashes] = await sql`
    select response_hash, payload_hash, hashed_at
    from responses where id = ${responseId}
  `;
  // Full classification history: every revision, never collapsed
  const history = await sql`
    select c.name as company, m.revision, m.mentioned, m.recommended,
      m.list_position, m.sentiment, m.confidence, m.needs_review,
      m.parser_version, m.created_at
    from mentions m join companies c on c.id = m.company_id
    where m.response_id = ${responseId}
    order by c.name asc, m.revision asc
  `;

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
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">
              Response text
            </h2>
            <Badge variant="outline" className="font-mono text-[10px]">
              RAW EVIDENCE — UNEDITED
            </Badge>
          </div>
          <pre className="whitespace-pre-wrap rounded-md border p-4 font-mono text-sm">
            {response.responseText || "(empty)"}
          </pre>
        </section>
      )}

      <section className="mb-6 rounded-md border bg-muted/30 p-4 text-xs">
        <p className="mb-1 font-medium text-foreground">Integrity</p>
        <p className="break-all font-mono text-muted-foreground">
          response sha256: {(hashes?.responseHash as string | null) ?? "—"}
        </p>
        <p className="break-all font-mono text-muted-foreground">
          payload sha256: {(hashes?.payloadHash as string | null) ?? "—"}
        </p>
        <p className="text-muted-foreground">
          hashed at capture:{" "}
          {hashes?.hashedAt ? formatDate(hashes.hashedAt as Date) : "—"} ·
          insert-only at the database level (docs/03)
        </p>
      </section>

      {history.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-1 text-sm font-medium text-muted-foreground">
            Classification history (every revision preserved)
          </h2>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-left">
                <tr>
                  <th className="p-2">Company</th>
                  <th className="p-2">Rev</th>
                  <th className="p-2">Mentioned</th>
                  <th className="p-2">Recommended</th>
                  <th className="p-2">Pos</th>
                  <th className="p-2">Sentiment</th>
                  <th className="p-2">Confidence</th>
                  <th className="p-2">Classifier</th>
                  <th className="p-2">At</th>
                </tr>
              </thead>
              <tbody>
                {history.map((m, i) => (
                  <tr key={i} className="border-t">
                    <td className="p-2">{m.company as string}</td>
                    <td className="p-2 tabular-nums">{m.revision as number}</td>
                    <td className="p-2">{m.mentioned ? "yes" : "no"}</td>
                    <td className="p-2">{m.recommended ? "yes" : "no"}</td>
                    <td className="p-2 tabular-nums">
                      {(m.listPosition as number | null) ?? "—"}
                    </td>
                    <td className="p-2">{(m.sentiment as string | null) ?? "—"}</td>
                    <td className="p-2 tabular-nums">
                      {m.confidence == null ? "—" : Number(m.confidence).toFixed(2)}
                    </td>
                    <td className="p-2 font-mono">{m.parserVersion as string}</td>
                    <td className="p-2">{formatDate(m.createdAt as Date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
