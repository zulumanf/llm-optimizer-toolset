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
import { getCurrentUserOrNull, isStaff } from "@/lib/auth";
import { TranscriptAnswer } from "@/components/audit/transcript-answer";

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
  const viewer = await getCurrentUserOrNull();
  const snapshot = await getAuditByToken(token, {
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent"),
    internal: viewer !== null && isStaff(viewer),
  });
  if (!snapshot?.transcripts || snapshot.transcripts.length === 0) notFound();

  // Group the flat capture list by question (legibility pass, spec 048
  // round 4): ten questions read as ten chapters, not forty look-alike
  // cards. Capture order within each question is preserved; nothing is
  // reordered across questions — the SQL already sorts by prompt.
  const byQuestion = new Map<string, typeof snapshot.transcripts>();
  for (const t of snapshot.transcripts) {
    if (!byQuestion.has(t.prompt)) byQuestion.set(t.prompt, []);
    byQuestion.get(t.prompt)!.push(t);
  }
  const questions = [...byQuestion.entries()];

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Appendix · every captured answer, verbatim · prepared for {snapshot.prospectName}
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        The complete transcripts
      </h1>
      <p className="mt-2 max-w-[65ch] text-sm text-muted-foreground">
        All {snapshot.transcripts.length} answers behind the report — unedited and
        unselected, content-hashed at capture. Bold, lists, and links are the
        assistants&apos; own formatting, shown the way their apps display it; the
        words are untouched. Use your browser&apos;s search (⌘F) to look for any
        name, including your own.
      </p>
      <p className="mt-2 text-sm">
        <Link href={`/audit/${token}`} className="underline underline-offset-2">
          ← Back to the report
        </Link>
      </p>

      <nav id="top" className="mt-8 rounded-lg border p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          The {questions.length} questions — jump to any
        </p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
          {questions.map(([prompt], qi) => (
            <li key={qi}>
              <a
                href={`#q${qi + 1}`}
                className="underline-offset-2 hover:underline"
              >
                {prompt}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="mt-10 space-y-12">
        {questions.map(([prompt, runs], qi) => (
          <section key={qi} id={`q${qi + 1}`}>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Question {qi + 1} of {questions.length} · asked {runs.length} time
              {runs.length === 1 ? "" : "s"}
            </p>
            <h2 className="mt-1 max-w-[40ch] text-balance text-lg font-medium">
              “{prompt}”
            </h2>
            <ol className="mt-4 space-y-4">
              {runs.map((t, ri) => (
                <li key={ri} className="rounded-lg border p-4">
                  <p className="text-xs text-muted-foreground">
                    Run {ri + 1} of {runs.length} · {t.model} · captured{" "}
                    {`${t.capturedAt.slice(0, 16).replace("T", " ")} UTC`}
                  </p>
                  {/* The assistant's formatting rendered AS formatting —
                      what the asker's own screen showed. Words untouched;
                      the parser is presentation-only and never emits HTML
                      (lib/prospects/transcript-format.ts). */}
                  <TranscriptAnswer text={t.answer} />
                </li>
              ))}
            </ol>
            <p className="mt-3 text-xs">
              <a href="#top" className="text-muted-foreground underline-offset-2 hover:underline">
                ↑ Question list
              </a>
            </p>
          </section>
        ))}
      </div>

      <p className="mt-12 text-center text-sm">
        <Link href={`/audit/${token}`} className="underline underline-offset-2">
          ← Back to the report
        </Link>
      </p>
    </div>
  );
}
