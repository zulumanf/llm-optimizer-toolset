import type { ReactNode } from "react";
import Link from "next/link";
import { entityRef, type AuditMismatchBlock, type CategoryCount, type MismatchQuestionRow } from "@/lib/prospects/audit-mismatch";
import type { AuditSnapshot } from "@/lib/prospects/audits";

/**
 * Private AI Recommendation Report (spec 128 v2). One scrolling research
 * document for a team that already said "send it": the finding first, the
 * receipts second, the interpretation third, their context as the reason to
 * talk, the conversation last. Renders only from the frozen snapshot;
 * sections without evidence do not render. Beacon targets:
 * data-signal-section / data-signal-evidence / data-signal-cta.
 */
export function MismatchReport({
  snapshot,
  block: b,
  answersHref,
  serifClass,
  bookingUrl = null,
  walkthroughHref,
}: {
  snapshot: AuditSnapshot;
  block: AuditMismatchBlock;
  answersHref: string;
  serifClass: string;
  ctaBlock?: ReactNode;
  /** Scheduling page for the walkthrough (operator config). When set, the
   * final CTA books a time instead of opening an email; the mid-report
   * link and the small line still point at plain reply. */
  bookingUrl?: string | null;
  /** In-house scheduling page under this report (spec 128). */
  walkthroughHref: string;
}) {
  const market = snapshot.marketName.split(",")[0]!.trim();
  const { ref, Ref, team } = entityRef(b.entityType);
  const captured = b.capturedAt ? fmtDate(b.capturedAt) : null;
  const replyEmail = snapshot.preparedBy?.email ?? null;
  const mailto = replyEmail
    ? `mailto:${replyEmail}?subject=${encodeURIComponent(`Re: ${b.prospect.name} report`)}&body=${encodeURIComponent("Francisco —\n\nYes, walk me through what you found.\n")}`
    : null;
  const receipts = b.questions.filter((q) => q.excerpts.length > 0 && q.wellFormed !== false).slice(0, 4);
  const asked = pickRepresentative(b.questions);
  const prospectShort = firstName(b.prospect.name);
  const notFluke = b.distinctQuestions.competitor >= 3;

  return (
    <div className="mx-auto max-w-[1200px]">
      {/* ------------------------------------------------ header */}
      <header className="grid gap-6 border-b pb-8 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <p className="text-xs font-medium uppercase tracking-[0.18em]">Recommended First</p>
          <p className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">Private AI recommendation report</p>
          <p className={`${serifClass} mt-6 text-2xl`}>{b.prospect.name}</p>
          <p className="text-sm text-muted-foreground">{snapshot.marketName}</p>
          {snapshot.preparedBy && <p className="mt-3 text-xs text-muted-foreground">Prepared {snapshot.preparedBy.date} · Private · Prepared for {b.prospect.name}</p>}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 self-end text-xs lg:col-span-5">
          <dt className="text-muted-foreground">Production source</dt><dd className="tabular-nums">RealTrends{b.prospect.productionYear ? ` ${b.prospect.productionYear}` : ""}</dd>
          <dt className="text-muted-foreground">AI test</dt><dd>{b.assistant}{b.webSearch ? ", web search on" : ""}</dd>
          <dt className="text-muted-foreground">Questions tested</dt><dd className="tabular-nums">{b.questionCount}</dd>
          <dt className="text-muted-foreground">Answers counted</dt><dd className="tabular-nums">{b.answerCount}</dd>
          {captured && <><dt className="text-muted-foreground">Captured</dt><dd className="tabular-nums">{captured}</dd></>}
        </dl>
      </header>

      {/* ------------------------------------------------ 1 · the finding */}
      <section className="grid gap-8 py-12 lg:grid-cols-12" data-signal-section="hero">
        <div className="lg:col-span-5">
          <h1 className={`${serifClass} text-balance text-3xl leading-tight sm:text-4xl`}>
            RealTrends has {ref} ahead. AI recommends {b.competitor.name} more often.
          </h1>
          <p className="mt-5 max-w-[48ch] text-sm leading-relaxed">
            On the RealTrends record for {b.metricLabel}, {ref} {team ? "is" : "are"} ahead of {b.competitor.name}. In our {market} test, {b.competitor.name} was recommended more often.
          </p>
        </div>
        <figure className="lg:col-span-7">
          <figcaption className="text-xs uppercase tracking-wide text-muted-foreground">Figure 01 · Production vs AI recommendations</figcaption>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-y py-3 text-sm sm:hidden">
            <dt className="col-span-2 text-xs uppercase tracking-wide text-muted-foreground">{b.prospect.productionYear ?? ""} {b.metricLabel} · RealTrends</dt>
            <dd><span className="block text-xs text-muted-foreground">{Ref}</span><span className="text-2xl tabular-nums">{b.prospect.productionDisplay.replace(/ closed$/, "")}</span></dd>
            <dd><span className="block text-xs text-muted-foreground">{b.competitor.name}</span><span className="text-2xl tabular-nums">{b.competitor.productionDisplay.replace(/ closed$/, "")}</span></dd>
            <dt className="col-span-2 mt-2 text-xs uppercase tracking-wide text-muted-foreground">AI recommendations · same {market} test</dt>
            <dd><span className="block text-xs text-muted-foreground">{Ref}</span><span className="text-2xl tabular-nums text-destructive">{b.prospect.recommendationCount}</span> <span className="text-xs text-muted-foreground">/ {b.answerCount}</span></dd>
            <dd><span className="block text-xs text-muted-foreground">{b.competitor.name}</span><span className="text-2xl tabular-nums">{b.competitor.recommendationCount}</span> <span className="text-xs text-muted-foreground">/ {b.answerCount}</span></dd>
          </dl>
          <table className="mt-3 hidden w-full text-sm sm:table">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 font-medium" />
                <th className="py-2 font-medium">{Ref}</th>
                <th className="py-2 font-medium">{b.competitor.name}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b align-top">
                <td className="py-4 pr-4">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">{b.prospect.productionYear ?? ""} {b.metricLabel}</p>
                  <p className="text-xs text-muted-foreground">RealTrends</p>
                </td>
                <td className="py-4 text-2xl tabular-nums">{b.prospect.productionDisplay.replace(/ closed$/, "")}</td>
                <td className="py-4 text-2xl tabular-nums">{b.competitor.productionDisplay.replace(/ closed$/, "")}</td>
              </tr>
              <tr className="align-top">
                <td className="py-4 pr-4">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">AI recommendations</p>
                  <p className="text-xs text-muted-foreground">Same {market} test</p>
                </td>
                <td className="py-4 text-2xl tabular-nums"><span className="text-destructive">{b.prospect.recommendationCount}</span> <span className="text-sm text-muted-foreground">/ {b.answerCount}</span></td>
                <td className="py-4 text-2xl tabular-nums">{b.competitor.recommendationCount} <span className="text-sm text-muted-foreground">/ {b.answerCount}</span></td>
              </tr>
            </tbody>
          </table>
          <p className={`${serifClass} mt-4 text-lg`}>{Ref} closed more {b.metricLabel}. {b.competitor.name} was recommended more.</p>
          {notFluke && <p className="mt-1 text-sm text-muted-foreground">{b.competitor.name} appeared across <span className="tabular-nums">{b.distinctQuestions.competitor}</span> different questions.</p>}
        </figure>
      </section>

      {/* ------------------------------------------------ 2 · why I flagged this */}
      <section className="grid gap-8 border-t py-10 lg:grid-cols-12" data-signal-section="why-flagged">
        <h2 className="text-xs uppercase tracking-wide text-muted-foreground lg:col-span-3">Why I flagged this</h2>
        <div className="max-w-[60ch] text-sm leading-relaxed lg:col-span-7">
          <p>When a buyer or seller asks AI who to hire, the names in the answer become part of their shortlist.</p>
          <p className="mt-3">This doesn’t prove you lost business. It shows that in this test, {b.competitor.name} made that shortlist much more often despite a lower {b.metricLabel} record.</p>
        </div>
      </section>

      {/* ------------------------------------------------ 3 · what we asked */}
      <section className="grid gap-8 border-t py-10 lg:grid-cols-12" data-signal-section="what-we-asked">
        <div className="lg:col-span-4">
          <h2 className="text-xs uppercase tracking-wide text-muted-foreground">What we asked</h2>
          <p className="mt-3 max-w-[40ch] text-sm leading-relaxed">We tested the kinds of questions a buyer or seller might ask while deciding who to work with in {market}.</p>
          <p className="mt-3 text-xs text-muted-foreground">We counted a team only when the answer actually recommended them, not simply when their name appeared.</p>
        </div>
        <div className="lg:col-span-8">
          <ul className="divide-y border-y text-sm">
            {asked.map((q) => (
              <li key={q.text} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                <span>“{q.text}”</span>
                <span className="text-xs uppercase tracking-wide text-muted-foreground">{tag(q)}</span>
              </li>
            ))}
          </ul>
          <details className="mt-3" data-signal-evidence="all-questions">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">View all {b.questionCount} questions</summary>
            <QuestionTable questions={b.questions} competitor={b.competitor.name} />
          </details>
        </div>
      </section>

      {/* ------------------------------------------------ 4 · the receipts */}
      {receipts.length > 0 && (
        <section className="grid gap-8 border-t py-10 lg:grid-cols-12" data-signal-section="evidence">
          <div className="lg:col-span-4">
            <h2 className="text-xs uppercase tracking-wide text-muted-foreground">The receipts</h2>
            <p className="mt-3 max-w-[36ch] text-sm leading-relaxed">Every count in this report traces back to a saved answer.</p>
            <ol className="mt-6 space-y-2 text-xs text-muted-foreground">
              <li><span className="tabular-nums">01</span> Question</li>
              <li><span className="tabular-nums">02</span> Saved answer</li>
              <li><span className="tabular-nums">03</span> Recommendation recorded</li>
              <li><span className="tabular-nums">04</span> Count added to this report</li>
            </ol>
          </div>
          <div className="space-y-8 lg:col-span-8">
            {receipts.map((q) => (
              <article key={q.text} className="grid gap-4 border-l pl-4 sm:grid-cols-12">
                <div className="sm:col-span-8">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Question</p>
                  <p className="mt-1 text-sm">“{q.text}”</p>
                  <p className="mt-3 text-xs uppercase tracking-wide text-muted-foreground">Saved answer</p>
                  <blockquote className="mt-1 text-sm leading-relaxed">{q.excerpts[0]!.quote}</blockquote>
                  <p className="mt-2 text-xs text-muted-foreground">Answer recorded {fmtDate(q.excerpts[0]!.capturedAt)} · {b.assistant}</p>
                </div>
                <dl className="text-xs sm:col-span-4">
                  <dt className="uppercase tracking-wide text-muted-foreground">What we recorded</dt>
                  <dd className="mt-1">{b.competitor.name}: <span className="font-medium">recommended</span> ({q.competitorRecommended} of {q.answers} answers)</dd>
                  <dd className="mt-1">{b.prospect.name}: <span className={q.prospectRecommended === 0 ? "font-medium text-destructive" : "font-medium"}>{q.prospectRecommended === 0 ? "not recommended" : `recommended (${q.prospectRecommended} of ${q.answers})`}</span></dd>
                </dl>
              </article>
            ))}
            <p className="text-xs text-muted-foreground">
              <Link href={answersHref} className="underline underline-offset-2 hover:text-foreground" data-signal-evidence="captured-answers">View all captured answers</Link>
            </p>
          </div>
        </section>
      )}

      {/* ------------------------------------------------ 5 · across the whole test */}
      {notFluke && (
        <section className="grid gap-8 border-t py-10 lg:grid-cols-12" data-signal-section="pattern">
          <h2 className="text-xs uppercase tracking-wide text-muted-foreground lg:col-span-3">This wasn’t based on one answer</h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:col-span-9">
            <Stat name={b.competitor.name} recs={b.competitor.recommendationCount} qs={b.distinctQuestions.competitor} />
            <Stat name={Ref} recs={b.prospect.recommendationCount} qs={b.distinctQuestions.prospect} pain />
          </div>
          {b.categories.length > 0 && (
            <figure className="lg:col-span-9 lg:col-start-4">
              <figcaption className="text-xs uppercase tracking-wide text-muted-foreground">Figure 02 · Recommendations by question type</figcaption>
              <table className="mt-3 w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 font-medium">Question type</th>
                    <th className="py-2 text-right font-medium">Questions tested</th>
                    <th className="py-2 text-right font-medium">{Ref} — recommendations</th>
                    <th className="py-2 text-right font-medium">{b.competitor.name} — recommendations</th>
                  </tr>
                </thead>
                <tbody>
                  {b.categories.map((c) => (
                    <tr key={c.key} className="border-b last:border-0">
                      <td className="py-2">{c.label}</td>
                      <td className="py-2 text-right tabular-nums text-muted-foreground">{c.questions}</td>
                      <td className="py-2 text-right tabular-nums">{c.prospect}</td>
                      <td className="py-2 text-right tabular-nums">{c.competitor}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted-foreground">Counts are recommendations, not questions. One question can belong to several types (selling a condo in a named neighborhood counts as seller, condo and neighborhood), so the rows overlap and do not add up to {b.questionCount}.</p>
            </figure>
          )}
        </section>
      )}

      {/* ------------------------------------------------ 6 · where the gap showed up */}
      {b.gaps.length > 0 && (
        <section className="grid gap-8 border-t py-10 lg:grid-cols-12" data-signal-section="gap">
          <h2 className="text-xs uppercase tracking-wide text-muted-foreground lg:col-span-3">Where they’re showing up more</h2>
          <div className="grid gap-6 sm:grid-cols-3 lg:col-span-9">
            {b.gaps.map((g) => <Gap key={g.key} g={g} competitor={b.competitor.name} you={Ref} />)}
          </div>
          {b.competitorNeighborhoods.length > 0 && (
            <p className="text-sm text-muted-foreground lg:col-span-9 lg:col-start-4">
              Neighborhoods where {b.competitor.name} was recommended: {b.competitorNeighborhoods.join(", ")}.
            </p>
          )}
        </section>
      )}

      {/* ------------------------------------------------ 7 · where the information comes from */}
      {b.sources && b.sources.length > 0 && (
        <section className="grid gap-8 border-t py-10 lg:grid-cols-12" data-signal-section="sources">
          <div className="lg:col-span-4">
            <h2 className="text-xs uppercase tracking-wide text-muted-foreground">Where the information is coming from</h2>
            <p className="mt-3 max-w-[36ch] text-sm leading-relaxed">We also recorded the websites that appeared repeatedly in the answers.</p>
            <p className="mt-3 max-w-[36ch] text-xs text-muted-foreground">We can see which websites keep appearing. We cannot say that any one of them caused a recommendation.</p>
          </div>
          <figure className="lg:col-span-8">
            <figcaption className="text-xs uppercase tracking-wide text-muted-foreground">Figure 03 · Websites the answers pointed to · how many times, across all {b.answerCount} answers (one answer can point to several websites)</figcaption>
            <ul className="mt-3 divide-y border-y text-sm">
              {b.sources.map((s) => (
                <li key={s.domain} className="flex items-baseline justify-between py-2">
                  <span>{s.domain}{s.category === "competitor" ? <span className="ml-2 text-xs text-muted-foreground">competitor-owned</span> : null}</span>
                  <span className="tabular-nums">{s.citations}</span>
                </li>
              ))}
            </ul>
            {b.ownSiteCited === false && <p className="mt-2 text-xs text-muted-foreground">Your own website was not one of them.</p>}
          </figure>
        </section>
      )}

      {/* ------------------------------------------------ 8 · why this may be happening */}
      {b.diagnosis.length > 0 && (
        <section className="grid gap-8 border-t py-10 lg:grid-cols-12" data-signal-section="diagnosis">
          <h2 className="text-xs uppercase tracking-wide text-muted-foreground lg:col-span-12">Why this may be happening</h2>
          {b.diagnosis.map((d) => (
            <article key={d.area} className="grid gap-4 lg:col-span-12 lg:grid-cols-12">
              <p className={`${serifClass} text-lg lg:col-span-3`}>{d.area}</p>
              <dl className="grid gap-4 text-sm leading-relaxed sm:grid-cols-3 lg:col-span-9">
                <div><dt className="text-xs uppercase tracking-wide text-muted-foreground">Observed</dt><dd className="mt-1">{d.observed}</dd></div>
                <div><dt className="text-xs uppercase tracking-wide text-muted-foreground">What it may mean</dt><dd className="mt-1">{d.mayMean}</dd></div>
                <div><dt className="text-xs uppercase tracking-wide text-muted-foreground">What I’d investigate</dt><dd className="mt-1">{d.investigate}</dd></div>
              </dl>
            </article>
          ))}
          {mailto && (
            <p className="text-xs text-muted-foreground lg:col-span-9 lg:col-start-4">
              Have a question about one of these? <a href={mailto} className="underline underline-offset-2 hover:text-foreground" data-signal-cta="mid-report">Reply to Francisco →</a>
            </p>
          )}
        </section>
      )}

      {/* ------------------------------------------------ 9 · what I’d look at first */}
      {b.priorities.length > 0 && (
        <section className="grid gap-8 border-t py-10 lg:grid-cols-12" data-signal-section="what-id-look-at">
          <h2 className="text-xs uppercase tracking-wide text-muted-foreground lg:col-span-3">What I’d look at first</h2>
          <ol className="space-y-6 lg:col-span-7">
            {b.priorities.map((p, i) => (
              <li key={p.title} className="grid grid-cols-[2.5rem_1fr] gap-2">
                <span className="text-xs tabular-nums text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <p className="text-sm font-medium uppercase tracking-wide">{p.title}</p>
                  <p className="mt-1 max-w-[56ch] text-sm leading-relaxed">{p.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* ------------------------------------------------ 10 · what I can’t tell */}
      <section className="grid gap-8 border-t py-10 lg:grid-cols-12" data-signal-section="what-i-cant-tell">
        <div className="lg:col-span-5">
          <h2 className="text-xs uppercase tracking-wide text-muted-foreground">What I can’t tell from public data</h2>
          <p className="mt-3 max-w-[40ch] text-sm leading-relaxed">The report can show me where the gap is. It can’t tell me which parts of the market matter most to {ref}.</p>
          <p className="mt-3 max-w-[40ch] text-sm text-muted-foreground">Those answers would change what I’d prioritize first.</p>
        </div>
        <ul className="space-y-3 text-sm lg:col-span-5">
          {b.contextQuestions.map((q) => <li key={q} className="border-l pl-3">{q}</li>)}
        </ul>
      </section>

      {/* ------------------------------------------------ 11 · less concerned */}
      <section className="grid gap-8 border-t py-10 lg:grid-cols-12" data-signal-section="less-concerned">
        <h2 className="text-xs uppercase tracking-wide text-muted-foreground lg:col-span-3">What would make me less concerned</h2>
        <div className="lg:col-span-7">
          <p className="text-sm">I’d worry less about this gap if:</p>
          <ul className="mt-3 space-y-3 text-sm">
            {b.lessConcerned.map((l) => (
              <li key={l.condition} className="border-l pl-3">
                <p>{l.condition}</p>
                <p className="text-xs text-muted-foreground">{l.status}.</p>
              </li>
            ))}
          </ul>
          <p className="mt-4 max-w-[56ch] text-sm text-muted-foreground">That’s why I would want your context before recommending what to do next.</p>
        </div>
      </section>

      {/* ------------------------------------------------ 12 · Francisco’s note */}
      <section className="border-t py-12" data-signal-section="francisco-note">
        <div className="mx-auto max-w-[58ch]">
          <h2 className="text-xs uppercase tracking-wide text-muted-foreground">Francisco’s note</h2>
          <div className={`${serifClass} mt-4 space-y-4 text-lg leading-relaxed`}>
            {b.note.paragraphs.map((p) => <p key={p}>{p}</p>)}
            {b.note.question && <p>{b.note.question}</p>}
          </div>
          {snapshot.preparedBy && <p className="mt-4 text-sm text-muted-foreground">— {snapshot.preparedBy.name}</p>}
        </div>
      </section>

      {/* ------------------------------------------------ 13 · what this means + method */}
      <section className="grid gap-8 border-t py-10 lg:grid-cols-12" data-signal-section="methodology">
        <div className="lg:col-span-5">
          <h2 className="text-xs uppercase tracking-wide text-muted-foreground">A quick note on what this means</h2>
          <ul className="mt-3 max-w-[44ch] space-y-2 text-sm leading-relaxed">
            <li>This is a measured snapshot, not a guarantee of every future AI answer.</li>
            <li>We count actual recommendations, not simple name mentions.</li>
            <li>We can observe recurring patterns without claiming one source controls the result.</li>
            <li>Results can change, which is why the same test can be run again later.</li>
          </ul>
        </div>
        <div className="lg:col-span-7">
          <h2 className="text-xs uppercase tracking-wide text-muted-foreground">How we ran the test</h2>
          <p className="mt-3 flex flex-wrap items-baseline gap-x-3 text-sm">
            <span className="text-2xl tabular-nums">{b.questionCount}</span> buyer and seller questions
            <span className="text-muted-foreground">×</span>
            <span className="text-2xl tabular-nums">{b.repetitions}</span> repetitions
            <span className="text-muted-foreground">=</span>
            <span className="text-2xl tabular-nums">{b.answerCount}</span> answers counted
          </p>
          <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
            <li>✓ Raw answers preserved</li>
            <li>✓ Actual recommendations counted</li>
            <li>✓ RealTrends compared separately</li>
            <li>✓ Answer count published{captured ? ` · answers recorded ${captured}` : ""}</li>
          </ul>
          <details className="mt-4 text-sm" data-signal-evidence="methodology">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">View full methodology</summary>
            <div className="mt-2 max-w-[65ch] space-y-2 text-sm leading-relaxed text-muted-foreground">
              <p>We ask the kinds of questions buyers and sellers ask when looking for an agent in {market}: {b.questionCount} questions, each asked {b.repetitions} times, through {b.assistantPhrase}{b.webSearch ? " with web search on" : ""}{captured ? `, on ${captured}` : ""}. These are direct answers from the {b.assistant} model, not screenshots of the consumer app. Every answer is saved exactly as it came back.</p>
              <p>We record which teams each answer actually recommended. A name that merely appears in passing is not counted. {b.answerCount === b.questionCount * b.repetitions ? `Every one of the ${b.answerCount} answers we received is counted.` : `${b.answerCount} is the number of answers we received and counted; any answer that came back empty or failed is left out of every count in this report.`}</p>
              <p>We compare those counts with the RealTrends record for the same year, the same measure ({b.metricLabel}) and the same market, at team level. The two are kept separate: the sales record never changes the recommendation count, and the other way round.</p>
              <p>When a team selling less than you shows up more often, we investigate why and what may be worth improving. Running the same test again later shows whether anything moved.</p>
            </div>
          </details>
        </div>
      </section>

      {/* ------------------------------------------------ 14 · CTA */}
      <section className="grid gap-8 border-t py-12 lg:grid-cols-12" data-signal-section="cta">
        <div className="lg:col-span-7">
          {b.ctaBridge && <p className={`${serifClass} mb-6 max-w-[52ch] text-lg leading-relaxed`}>{b.ctaBridge}</p>}
          <h2 className={`${serifClass} text-balance text-2xl`}>Want me to walk you through what I’d look at first?</h2>
          <p className="mt-4 max-w-[52ch] text-sm leading-relaxed">I’ve already done the initial comparison. If you want, I can walk you through:</p>
          <ul className="mt-2 max-w-[52ch] space-y-1 text-sm">
            <li>— which parts of this I think matter,</li>
            <li>— which parts I wouldn’t worry about,</li>
            <li>— and the first two or three things I’d investigate for {ref}.</li>
          </ul>
          <div className="mt-6">
            {bookingUrl ? (
              <a href={bookingUrl} target="_blank" rel="noopener noreferrer" data-signal-cta="walk-me-through" className="inline-flex w-full items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto">
                Pick a time to walk through it
              </a>
            ) : walkthroughHref ? (
              <Link href={walkthroughHref} data-signal-cta="walk-me-through" className="inline-flex w-full items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto">
                Pick a time to walk through it
              </Link>
            ) : mailto ? (
              <a href={mailto} data-signal-cta="walk-me-through" className="inline-flex w-full items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto">
                Walk me through it
              </a>
            ) : (
              <p className="text-sm">Reply to the email I sent this from with <span className="font-medium">“walk me through it”</span>.</p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">15 minutes. Or just reply to the email I sent this from.</p>
          </div>
        </div>
        <div className="self-end text-xs text-muted-foreground lg:col-span-5">
          {snapshot.preparedBy && (
            <p>Prepared by {snapshot.preparedBy.name}{snapshot.preparedBy.company && ` · ${snapshot.preparedBy.company}`}{snapshot.preparedBy.email && ` · ${snapshot.preparedBy.email}`} · {snapshot.preparedBy.date} · report {snapshot.preparedBy.reportId}</p>
          )}
          <p className="mt-2">Recommended First works with one retained team within each defined market.</p>
        </div>
      </section>

      {/* ------------------------------------------------ appendix */}
      <section className="border-t py-8 text-xs text-muted-foreground" data-signal-section="appendix">
        <p className="uppercase tracking-wide">Appendix</p>
        <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
          <li><Link href={answersHref} className="underline underline-offset-2 hover:text-foreground">All captured answers</Link></li>
          <li>Recommendation records: the “View all {b.questionCount} questions” table above</li>
          <li>Production source: RealTrends{b.prospect.productionYear ? ` ${b.prospect.productionYear}` : ""}, {b.metricLabel}, team level</li>
          <li>Prepared for {prospectShort}</li>
        </ul>
      </section>
    </div>
  );
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}
function firstName(name: string): string {
  return name;
}
function tag(q: MismatchQuestionRow): string {
  if (q.luxury) return "luxury";
  if (q.propertyType) return `${q.audience} · ${q.propertyType}`;
  if (q.neighborhood) return "neighborhood";
  return q.audience;
}
/** 6–8 representative questions: every audience/property type once, the
 * competitor's strongest first. */
function pickRepresentative(questions: MismatchQuestionRow[]): MismatchQuestionRow[] {
  const seen = new Set<string>();
  const out: MismatchQuestionRow[] = [];
  for (const q of questions) {
    if (q.wellFormed === false) continue;
    const key = q.luxury ? "luxury" : `${q.audience}:${q.propertyType ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= 8) break;
  }
  for (const q of questions) {
    if (out.length >= 8) break;
    if (!out.includes(q) && q.wellFormed !== false) out.push(q);
  }
  return out;
}

function QuestionTable({ questions, competitor }: { questions: MismatchQuestionRow[]; competitor: string }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-left uppercase tracking-wide text-muted-foreground">
            <th className="py-1 pr-2 font-medium">Question</th>
            <th className="py-1 pr-2 text-right font-medium">Answers</th>
            <th className="py-1 pr-2 text-right font-medium">You</th>
            <th className="py-1 text-right font-medium">{competitor}</th>
          </tr>
        </thead>
        <tbody>
          {questions.map((q) => (
            <tr key={q.text} className="border-b last:border-0">
              <td className="py-1 pr-2">{q.text}</td>
              <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">{q.answers}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{q.prospectRecommended}</td>
              <td className="py-1 text-right tabular-nums">{q.competitorRecommended}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ name, recs, qs, pain }: { name: string; recs: number; qs: number; pain?: boolean }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{name}</p>
      <p className={`mt-1 text-3xl tabular-nums ${pain && recs === 0 ? "text-destructive" : ""}`}>{recs} <span className="text-sm text-muted-foreground">recommendation{recs === 1 ? "" : "s"}</span></p>
      <p className="text-sm text-muted-foreground">across <span className="tabular-nums">{qs}</span> different question{qs === 1 ? "" : "s"}</p>
    </div>
  );
}

function Gap({ g, competitor, you }: { g: CategoryCount; competitor: string; you: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{g.label}</p>
      <p className="mt-1 text-sm">{you}: <span className="tabular-nums">{g.prospect}</span></p>
      <p className="text-sm">{competitor}: <span className="tabular-nums">{g.competitor}</span></p>
    </div>
  );
}
