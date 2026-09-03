import type { ReactNode } from "react";
import Link from "next/link";
import type { AuditMismatchBlock } from "@/lib/prospects/audit-mismatch";
import type { AuditSnapshot } from "@/lib/prospects/audits";

/**
 * The private report for a competitive-mismatch prospect (spec 128). One
 * screen, one idea: you closed more, they got recommended more, here are
 * the questions and answers. Everything renders from the frozen snapshot.
 */
export function MismatchReport({
  snapshot,
  block,
  ctaBlock,
  answersHref,
  serifClass,
}: {
  snapshot: AuditSnapshot;
  block: AuditMismatchBlock;
  ctaBlock: ReactNode;
  answersHref: string;
  serifClass: string;
}) {
  const b = block;
  const captured = b.capturedAt ? new Date(b.capturedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : null;
  const askedLine = `${b.questionCount} ${snapshot.marketName.split(",")[0]} buyer and seller questions, ${b.repetitions} times each, ${b.answerCount} answers${captured ? `, ${captured}` : ""}.`;
  return (
    <>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Private report</p>
      <p className="mt-1 text-xs text-muted-foreground">{snapshot.prospectName} · {snapshot.marketName}</p>
      <h1 className={`${serifClass} mt-6 max-w-[22ch] text-balance text-3xl leading-tight sm:text-4xl`}>
        You closed more. {b.competitor.name} got recommended more.
      </h1>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        <Tile
          name={b.prospect.name}
          production={b.prospect.productionDisplay}
          year={b.prospect.productionYear}
          count={b.prospect.recommendationCount}
          total={b.answerCount}
          pain
        />
        <Tile
          name={b.competitor.name}
          production={b.competitor.productionDisplay}
          year={b.competitor.productionYear}
          count={b.competitor.recommendationCount}
          total={b.answerCount}
        />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Closed volume: {b.productionSource}. Recommendations: counted from what {b.assistant} answered. Any single answer varies; the pattern is the finding.
      </p>

      <section className="mt-12" data-signal-section="competitors">
        <h2 className="text-lg font-medium">The questions</h2>
        <p className="mt-1 text-sm text-muted-foreground">We asked {b.assistant} {askedLine} These are the ones where either name came up.</p>
        <ul className="mt-4 divide-y border-y">
          {b.questions.map((q) => (
            <li key={q.text} className="py-3">
              <p className="text-sm">“{q.text}”</p>
              <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                {q.competitorRecommended > 0 && <>{b.competitor.name} recommended in {q.competitorRecommended} of {q.answers}</>}
                {q.competitorRecommended > 0 && q.prospectMentioned > 0 && " · "}
                {q.prospectMentioned > 0 && <>you appeared in {q.prospectMentioned} of {q.answers}</>}
              </p>
              {q.excerpts.length > 0 && (
                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">See the answer</summary>
                  {q.excerpts.map((e) => (
                    <blockquote key={e.responseId} className="mt-2 border-l pl-3 text-sm">
                      {e.quote}
                      <footer className="mt-1 text-xs text-muted-foreground">{b.assistant} · {new Date(e.capturedAt).toLocaleDateString("en-US")}</footer>
                    </blockquote>
                  ))}
                </details>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          <Link href={answersHref} className="underline underline-offset-2 hover:text-foreground">Every answer, complete and unedited</Link>
        </p>
      </section>

      <section className="mt-12 border-t pt-8" data-signal-section="cta">
        <p className={`${serifClass} max-w-[42ch] text-balance text-lg`}>Want to talk through why this is happening?</p>
        <div className="mt-4">{ctaBlock}</div>
        {snapshot.preparedBy && (
          <p className="mt-6 text-xs text-muted-foreground">
            Prepared by {snapshot.preparedBy.name}
            {snapshot.preparedBy.company && ` · ${snapshot.preparedBy.company}`}
            {snapshot.preparedBy.email && ` · ${snapshot.preparedBy.email}`}
            {` · ${snapshot.preparedBy.date} · report ${snapshot.preparedBy.reportId}`}
          </p>
        )}
      </section>
    </>
  );
}

function Tile({ name, production, year, count, total, pain }: { name: string; production: string; year: number | null; count: number; total: number; pain?: boolean }) {
  return (
    <div className="rounded-md border p-5">
      <p className="text-sm font-medium">{name}</p>
      <p className="mt-3 text-2xl tabular-nums">{production}</p>
      {year && <p className="text-xs text-muted-foreground">in {year}</p>}
      <p className={`mt-4 text-4xl tabular-nums ${pain ? "text-destructive" : ""}`}>{count}</p>
      <p className="text-xs text-muted-foreground">recommended, out of {total} answers</p>
    </div>
  );
}
