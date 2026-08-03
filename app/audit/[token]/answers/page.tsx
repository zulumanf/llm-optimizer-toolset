/**
 * The proof appendix (spec 045): every captured AI answer, complete and
 * verbatim. An absence can only be proven by publishing everything — the
 * reader can search this page for their own name. Same token, same frozen
 * snapshot, same revocation as the parent report; nothing is selected or
 * summarized by us.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getAuditByToken } from "@/lib/prospects/service";

export const metadata: Metadata = {
  title: "AI Visibility Benchmark — Captured Answers",
  robots: { index: false, follow: false },
};

export default async function AuditAnswersPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const hdrs = await headers();
  const snapshot = await getAuditByToken(token, {
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent"),
  });
  if (!snapshot?.transcripts || snapshot.transcripts.length === 0) notFound();

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Appendix · every captured answer, verbatim · prepared for {snapshot.prospectName}
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        The complete transcripts
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        All {snapshot.transcripts.length} answers behind the report, unedited and
        unselected — exactly as the assistants returned them, with capture timestamps.
        Use your browser&apos;s search (⌘F) to look for any name, including your own.
        Answers are content-hashed at capture and never edited.
      </p>
      <p className="mt-2 text-sm">
        <Link href={`/audit/${token}`} className="underline">
          ← Back to the report
        </Link>
      </p>

      <ol className="mt-8 space-y-6">
        {snapshot.transcripts.map((t, i) => (
          <li key={i} className="rounded-lg border p-4">
            <p className="text-sm font-medium">“{t.prompt}”</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Answer {i + 1} of {snapshot.transcripts!.length} · {t.model} · captured{" "}
              {new Date(t.capturedAt).toLocaleString()}
            </p>
            <pre className="mt-3 whitespace-pre-wrap font-sans text-sm text-muted-foreground">
              {t.answer}
            </pre>
          </li>
        ))}
      </ol>

      <p className="mt-10 text-center text-sm">
        <Link href={`/audit/${token}`} className="underline">
          ← Back to the report
        </Link>
      </p>
    </div>
  );
}
