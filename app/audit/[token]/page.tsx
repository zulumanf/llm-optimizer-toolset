/**
 * Public prospect audit page (spec 032/045). The platform's only anonymous
 * content surface: resolves a high-entropy token to a published snapshot and
 * renders nothing else. No auth call, no live internal queries — internal
 * notes cannot leak because they were never put in the snapshot. Wrong,
 * revoked, and expired tokens are indistinguishable (all 404).
 *
 * Design: trust-first evidence document (.claude/skills/audit-page-design).
 * The first screen is the whole punch; one accent moment (the "0×"); depth
 * folds into styled <details>; serif display face route-local so the page
 * reads as a document, not an app screen. Presentation-only — renders any
 * published snapshot, old or new.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Newsreader } from "next/font/google";
import { ChevronRight } from "lucide-react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getAuditByToken } from "@/lib/prospects/service";
import { getCurrentUserOrNull, isStaff } from "@/lib/auth";

const serif = Newsreader({ subsets: ["latin"], weight: ["400", "500"], style: ["normal", "italic"] });

export const metadata: Metadata = {
  title: "AI Visibility Benchmark",
  robots: { index: false, follow: false },
};

/** In-table micro-bar: absolute 0–100 scale, neutral ink, empty track for
 * zero (never a fake minimum width — the empty track IS the finding).
 * Values live in the adjacent text label, per dataviz rules. SVG rects so
 * the width is a presentation attribute, not an inline style (house rule,
 * test-enforced). */
function RateBar({
  value,
  isSubject,
  of,
}: {
  value: number | null;
  isSubject: boolean;
  /** Sample size: when present the label reads "3/40" — counts land harder
   * than percentages for this reader (spec 048 conversion pass). */
  of?: number;
}) {
  if (value === null) {
    return <span className="text-xs text-muted-foreground">not measured</span>;
  }
  const pct = Math.round(value * 100);
  const label = of ? `${Math.round(value * of)}/${of}` : `${pct}%`;
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <svg
        className="h-1.5 w-20"
        viewBox="0 0 100 6"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${pct} percent`}
      >
        <rect width="100" height="6" rx="3" className="fill-foreground/10" />
        {pct > 0 && (
          <rect
            width={pct}
            height="6"
            rx="3"
            className={isSubject ? "fill-destructive" : "fill-foreground/45"}
          />
        )}
      </svg>
      <span
        className={`w-11 text-right tabular-nums ${isSubject ? "text-destructive" : ""}`}
        title={`${pct}%`}
      >
        {label}
      </span>
    </span>
  );
}

/** Styled disclosure — hover, focus ring, rotating chevron (house rules #4). */
function Drawer({
  summary,
  children,
}: {
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group py-4">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm text-sm font-medium transition-colors duration-200 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 transition-transform duration-200 group-open:rotate-90" />
        {summary}
      </summary>
      <div className="pl-6 pt-2">{children}</div>
    </details>
  );
}

export default async function ProspectAuditPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const hdrs = await headers();
  // Session read is only to LABEL the view (plan 3.6): an operator's QA
  // open must not count as prospect interest. Content still comes solely
  // from the snapshot; anonymous visitors take the same path as ever.
  const viewer = await getCurrentUserOrNull();
  const snapshot = await getAuditByToken(token, {
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent"),
    internal: viewer !== null && isStaff(viewer),
  });
  if (!snapshot) notFound();

  const from = new Date(snapshot.benchmark.dateRange.from).toLocaleDateString();
  const to = snapshot.benchmark.dateRange.to
    ? new Date(snapshot.benchmark.dateRange.to).toLocaleDateString()
    : null;
  const gap = snapshot.authorityGap;
  const stakes = snapshot.stakes;
  // Captured excerpts arrive wearing the assistant's own formatting — outer
  // quotation marks (rendered ""like this"" inside our curly quotes; the
  // round-1 reviewer's "quotation mark error", found in the wild) and
  // literal markdown bold markers. Strip both; the template supplies the
  // typography. The words themselves are never altered.
  const trimQuotes = (s: string): string =>
    s
      .replaceAll("**", "")
      .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "");
  // The blockquote earns its serif with the most substantial excerpt, not
  // whichever company sorted first — a two-word quote reads as a glitch.
  const firstExcerpt = [...(snapshot.evidenceExcerpts ?? [])].sort(
    (a, b) => b.quote.length - a.quote.length
  )[0];
  // Concrete beats evocative when the data allows it (spec 048): a sourced
  // market rank plus counted answers makes the hero unarguable. Snapshots
  // without a rank keep their approved headline.
  const prospectRank = snapshot.comparison.find((r) => r.isProspect)?.marketRank ?? null;
  const concreteHero = prospectRank != null && stakes != null;
  // Plain-words repetition count for the visible recipe: exact when the
  // arithmetic is clean, honest-vague when partial failures made it ragged.
  const repsLabel =
    snapshot.benchmark.promptCount > 0 &&
    snapshot.benchmark.responseCount % snapshot.benchmark.promptCount === 0
      ? `${snapshot.benchmark.responseCount / snapshot.benchmark.promptCount} separate times`
      : "several separate times";
  const sellerMoment = snapshot.promptEvidence.find(
    (e) => /sell/i.test(e.promptText) && e.recommendedNames.length > 0
  );
  const showMe = (
    <span className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">show me</span>
  );
  // One-click conversion: a mailto with the two-word reply prefilled.
  // Falls back to the plain text ask on snapshots without a reply address.
  const replyEmail = snapshot.preparedBy?.email;
  const mailto = replyEmail
    ? `mailto:${replyEmail}?subject=${encodeURIComponent(
        `show me — ${snapshot.prospectName}`
      )}&body=${encodeURIComponent("show me")}`
    : null;
  const ctaButton = mailto && (
    <a
      href={mailto}
      className="inline-flex w-full items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto"
    >
      Show me what&apos;s missing — 15-minute walkthrough
    </a>
  );

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      {/* ============================================= the first screen */}
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Private AI visibility report · {snapshot.marketName} · for {snapshot.prospectName}
        {snapshot.preparedBy && ` · ${snapshot.preparedBy.date}`}
      </p>
      {concreteHero ? (
        <h1
          className={`${serif.className} mt-3 max-w-[26ch] text-balance text-2xl font-medium tracking-tight`}
        >
          You&apos;re the #{prospectRank} team in {snapshot.marketName}.
          <br />
          {/* The payoff line carries full ink — muting it made the punch
              read subordinate to the setup (round 3 design pass). */}
          In {snapshot.benchmark.responseCount} AI answers, you were recommended{" "}
          <span className="tabular-nums text-destructive">
            {stakes!.yourRecommendations}
          </span>{" "}
          times.
        </h1>
      ) : (
        <h1
          className={`${serif.className} mt-3 max-w-[24ch] text-balance text-2xl font-medium tracking-tight`}
        >
          {snapshot.headline}
        </h1>
      )}
      <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">
        ChatGPT is the AI assistant millions now use the way they used to use
        Google — and when buyers and sellers ask it who to hire, it answers
        with specific names. We asked it {snapshot.benchmark.promptCount} real{" "}
        {snapshot.marketName} questions; every answer is published below.
      </p>

      {stakes ? (
        <section className="mt-10">
          <p className="text-2xl font-semibold tracking-tight">
            <span className="tabular-nums">{stakes.recommendationMomentsTotal}×</span>{" "}
            <span className="font-normal text-muted-foreground">
              AI recommended a specific team.
            </span>
          </p>
          <p className="mt-1 text-2xl font-semibold tracking-tight">
            <span className="tabular-nums text-destructive">
              {stakes.yourRecommendations}×
            </span>{" "}
            <span className="font-normal text-muted-foreground">it was you.</span>
          </p>
          {stakes.competitorsNamed.length > 0 && (
            <p className="mt-3 text-sm text-muted-foreground">
              Buyers heard instead:{" "}
              <span className="font-medium text-foreground">
                {stakes.competitorsNamed.slice(0, 4).join(" · ")}
              </span>
            </p>
          )}
        </section>
      ) : null}

      {sellerMoment && (
        <p className="mt-4 max-w-[65ch] border-l-2 border-foreground/20 pl-4 text-sm">
          One moment from the capture: we asked{" "}
          <span className={`${serif.className} italic`}>
            “{sellerMoment.promptText}”
          </span>{" "}
          — a listing client&apos;s question. The answer sent them to{" "}
          <span className="font-medium">{sellerMoment.recommendedNames[0]}</span>.
          Your name never came up.
        </p>
      )}

      {stakes?.avgDealUsd != null && (
        <p className="mt-4 max-w-[65ch] text-sm text-muted-foreground">
          Your average sale:{" "}
          <span className="font-semibold text-foreground tabular-nums">
            ~${Math.round(stakes.avgDealUsd / 1000).toLocaleString()}K
          </span>{" "}
          ({stakes.avgDealBasis}).
        </p>
      )}

      {/* The scorecard (spec 048, round 2): the counted moments above are
          the punch; the two-score CONTRAST is the corroboration — authority
          from the sourced record, visibility from captured answers, both
          checkable by the reader. Fixability is argued in the diagnosis,
          not tiled here: in a strip it reads as a proprietary vendor score. */}
      {gap && (
        <div className="mt-8">
          <div className="grid max-w-lg grid-cols-2 gap-4">
            {[
              {
                // "Documented", not "market": the score measures how much of
                // their standing is VERIFIABLE in sourced records — a #9 team
                // with thin documentation scores low here, and that reading
                // must not contradict the rank in the hero.
                label: "Documented authority",
                value: Math.round(gap.authorityScore),
                pain: false,
              },
              {
                label: "AI visibility",
                value: Math.round(gap.visibilityScore),
                pain: true,
              },
            ].map((tile) => (
              <div key={tile.label} className="rounded-md border p-4">
                <p className="text-xs text-muted-foreground">{tile.label}</p>
                <p
                  className={`mt-1 text-2xl font-semibold tabular-nums tracking-tight ${
                    tile.pain ? "text-destructive" : ""
                  }`}
                >
                  {tile.value}
                  <span className="text-sm font-normal text-muted-foreground">
                    /100
                  </span>
                </p>
                <svg
                  className="mt-2 h-2 w-full"
                  viewBox="0 0 100 6"
                  preserveAspectRatio="none"
                  role="img"
                  aria-label={`${tile.label}: ${tile.value} of 100`}
                >
                  <rect width="100" height="6" rx="3" className="fill-foreground/10" />
                  {tile.value > 0 && (
                    <rect
                      width={Math.max(1, tile.value)}
                      height="6"
                      rx="3"
                      className={tile.pain ? "fill-destructive" : "fill-foreground/45"}
                    />
                  )}
                </svg>
              </div>
            ))}
          </div>
          <p className="mt-2 max-w-[65ch] text-xs text-muted-foreground">
            Both 0–100, both checkable — components and sources under “Your track
            record” below.
          </p>
        </div>
      )}

      {/* Hope lands AFTER the full weight of the problem (spec 048 CRO pass:
          agitate → anchor → hope → ask), and only when the sourced record
          actually supports it — never as an empty consolation. */}
      {gap && gap.signals.length > 0 && (
        <p className="mt-4 max-w-[65ch] text-sm">
          <span className="font-medium">The good news:</span> your record isn&apos;t
          the problem — it&apos;s sourced below. What&apos;s missing is that
          record&apos;s visibility in the sources these answers cite. That part is
          workable.
        </p>
      )}

      <div className="mt-6">
        {ctaButton ?? (
          <p className="max-w-[65ch] text-sm">
            Reply {showMe} to the email that brought you here — you&apos;ll get the
            15-minute walkthrough.
          </p>
        )}
        <p className="mt-2 max-w-[65ch] text-xs text-muted-foreground">
          15 minutes, no obligation. I&apos;ll show you the captured answers, the
          likely causes of the gap, and the first changes I&apos;d prioritize.
        </p>
      </div>

      {/* ================================================== the receipt */}
      {snapshot.comparison.length > 0 && (
        <section className="mt-14">
          <h2 className="text-lg font-medium">
            Who shows up when {snapshot.marketName} buyers ask
          </h2>
          {/* The whole recipe, in plain words, AT the figures it explains
              (spec 048 round 4): a skeptic shouldn't have to open a drawer
              to learn how a number was made. The full method + limitations
              stay in "How this was measured" below. */}
          <ol className="mt-3 max-w-[65ch] list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>
              We wrote {snapshot.benchmark.promptCount} real buyer and seller
              questions{snapshot.promptEvidence.length > 0 ? " (full list below)" : ""}.
            </li>
            <li>
              We asked each one {repsLabel}. ChatGPT&apos;s answers change a
              little on every ask — like asking four different receptionists —
              so we count the pattern across all{" "}
              {snapshot.benchmark.responseCount} answers, never one lucky
              reply.
            </li>
            <li>
              Every answer
              {snapshot.transcripts && snapshot.transcripts.length > 0
                ? " is published below,"
                : " was saved"}{" "}
              word-for-word.
            </li>
            <li>
              We counted who was named and who was recommended. The table is those
              counts — nothing estimated.
            </li>
          </ol>
          <p className="mt-3 max-w-[65ch] text-xs text-muted-foreground">
            <span className="text-foreground">Brought up</span> = named at all.{" "}
            <span className="text-foreground">Recommended</span> = the answer said to
            use them. One answer can name several teams, so columns don&apos;t sum
            to 100%.
          </p>
          {(() => {
            const hasRanks = snapshot.comparison.some((r) => r.marketRank != null);
            return (
              <div className="mt-3 overflow-x-auto">
                {/* min-w keeps columns intact on phones: the table scrolls
                    sideways instead of crushing team names into four lines. */}
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">Team</th>
                      {hasRanks && (
                        <th className="py-2 pr-4 text-right font-medium">
                          Market rank*
                        </th>
                      )}
                      <th className="py-2 pr-4 text-right font-medium">Brought up</th>
                      <th className="py-2 pr-4 text-right font-medium">Recommended</th>
                      <th className="py-2 text-right font-medium">Answers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.comparison.map((row) => (
                      <tr
                        key={row.name}
                        className={`border-b transition-colors last:border-0 hover:bg-muted/30 ${
                          row.isProspect ? "bg-muted/40 font-semibold" : ""
                        }`}
                      >
                        <td className="whitespace-nowrap py-2 pr-4">
                          {row.name}
                          {row.isProspect ? " ← you" : ""}
                        </td>
                        {hasRanks && (
                          <td className="py-2 pr-4 text-right tabular-nums">
                            {row.marketRank != null ? `#${row.marketRank}` : "—"}
                          </td>
                        )}
                        <td className="py-2 pr-4 text-right">
                          <RateBar
                            value={row.mentionRate}
                            isSubject={row.isProspect}
                            of={row.sampleSize}
                          />
                        </td>
                        <td className="py-2 pr-4 text-right">
                          <RateBar
                            value={row.recommendationRate}
                            isSubject={row.isProspect}
                            of={row.sampleSize}
                          />
                        </td>
                        <td className="py-2 text-right tabular-nums">{row.sampleSize}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {hasRanks && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    * City ranking by closed sales volume — sourced under “Your track
                    record” below.
                  </p>
                )}
                {snapshot.brandMentions && snapshot.brandMentions.length > 0 && (
                  <div className="mt-4">
                    <p className="text-xs font-medium text-muted-foreground">
                      The rest went to brand-level names, not teams — brought up:
                    </p>
                    <ul className="mt-2 space-y-1.5">
                      {snapshot.brandMentions.map((b) => (
                        <li key={b.name} className="flex items-center gap-2 text-sm">
                          <span className="w-44 truncate text-muted-foreground">
                            {b.name}
                          </span>
                          <RateBar
                            value={b.mentionRate}
                            isSubject={false}
                            of={snapshot.benchmark.responseCount}
                          />
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 max-w-[65ch] text-sm">
                      No individual team owns the answers yet — that space is still
                      open.
                    </p>
                  </div>
                )}
              </div>
            );
          })()}
          {snapshot.transcripts && snapshot.transcripts.length > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              Don&apos;t take the table&apos;s word —{" "}
              <Link
                href={`/audit/${token}/answers`}
                className="underline underline-offset-2 transition-colors hover:text-foreground"
              >
                read all {snapshot.transcripts.length} answers verbatim
              </Link>{" "}
              and search any name, including your own.
            </p>
          )}
        </section>
      )}

      {firstExcerpt && (
        <blockquote className="mt-8 max-w-[65ch] border-l-2 border-foreground/20 pl-4">
          {firstExcerpt.promptText && (
            <p className="text-xs font-medium text-muted-foreground">
              Asked: “{firstExcerpt.promptText}”
            </p>
          )}
          <p className={`${serif.className} mt-1 text-lg italic leading-snug`}>
            “{trimQuotes(firstExcerpt.quote)}”
          </p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            — the assistant, recommending {firstExcerpt.teamName} ·{" "}
            {new Date(firstExcerpt.capturedAt).toLocaleDateString()}
          </p>
        </blockquote>
      )}

      {snapshot.exampleChats && snapshot.exampleChats.length > 0 && (
        <p className="mt-6 max-w-[65ch] text-sm">
          <span className="font-medium">See it live:</span>{" "}
          {snapshot.exampleChats.map((chat, i) => (
            <span key={i}>
              {i > 0 && " · "}
              <a
                href={chat.url}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 transition-colors hover:text-muted-foreground"
              >
                a real {chat.assistant === "chatgpt" ? "ChatGPT" : "Perplexity"}{" "}
                conversation from {chat.capturedOn}
              </a>
            </span>
          ))}{" "}
          — hosted on the assistant&apos;s own site, not ours.
        </p>
      )}

      {/* ============================= the diagnosis, in the open (spec 048):
          proof of a problem earns attention; visible reasons and fixes earn
          the meeting. Detail and receipts stay folded below. */}
      {snapshot.whyItHappens && snapshot.whyItHappens.length > 0 && (
        <section className="mt-14">
          <h2 className="text-lg font-medium">
            Why AI is overlooking {snapshot.prospectName}
          </h2>
          <ul className="mt-4 space-y-4">
            {snapshot.whyItHappens.map((why, i) => (
              <li key={i} className="max-w-[65ch] rounded-md border p-4">
                <p className="text-sm font-medium">
                  {i + 1}. {why.title}
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {why.explanation}
                </p>
                <p className="mt-1.5 text-sm">
                  <span className="font-medium">The fix:</span> {why.suggestedAction}
                </p>
              </li>
            ))}
          </ul>
          {snapshot.topSources && snapshot.topSources.length > 0 && (
            <p className="mt-3 max-w-[65ch] text-xs text-muted-foreground">
              Where the answers pulled from:{" "}
              {snapshot.topSources
                .map((s) => `${s.domain} (${s.citations}×)`)
                .join(", ")}{" "}
              — presence on these surfaces is how the answer changes.
            </p>
          )}
        </section>
      )}

      {/* Fixability lives HERE, argued beside its reasons (spec 048 round
          2) — as a tile it read as a proprietary vendor score; as a scored
          sentence under the diagnosis it reads as analysis. */}
      {snapshot.fixability && snapshot.fixability.strengths.length > 0 && (
        <p className="mt-4 max-w-[65ch] text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            How workable is the gap? {snapshot.fixability.score}/100
          </span>{" "}
          — a measure, not a promise. In your favor:{" "}
          {snapshot.fixability.strengths.join(" · ").toLowerCase()}
          {snapshot.fixability.confidence != null
            ? ` (${Math.round(snapshot.fixability.confidence * 100)}% data confidence)`
            : ""}
          .
        </p>
      )}

      {/* The one mid-page ask (spec 048 CRO pass): the diagnosis is peak
          conviction, and the reader shouldn't have to scroll past the
          receipts to act on it. A sentence, not a button — the next
          research step, not a second funnel. */}
      {snapshot.whyItHappens && snapshot.whyItHappens.length > 0 && (
        <p className="mt-5 max-w-[65ch] text-sm">
          Want these checked against your own record?{" "}
          {mailto ? (
            <a
              href={mailto}
              className="font-medium underline underline-offset-2 transition-colors hover:text-muted-foreground"
            >
              Reply “show me”
            </a>
          ) : (
            <>Reply {showMe} to the email that brought you here</>
          )}{" "}
          — 15 minutes, evidence on screen.
        </p>
      )}

      {/* ====================================== the second read (folded) */}
      <div className="mt-14 divide-y border-y">
        <Drawer summary="What we found, in one paragraph">
          <p className="max-w-[65ch] text-sm font-medium">{snapshot.keyFinding.title}</p>
          <p className="mt-1.5 max-w-[65ch] text-sm text-muted-foreground">
            {snapshot.keyFinding.explanation}
          </p>
        </Drawer>

        {snapshot.promptEvidence.length > 0 && (
          <Drawer summary="The questions we asked — and who was named">
            <ul className="space-y-3">
              {snapshot.promptEvidence.map((e) => (
                <li key={e.responseId} className="max-w-[65ch] text-sm">
                  <p className="font-medium">“{e.promptText}”</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {e.recommendedNames.length > 0
                      ? `Recommended: ${e.recommendedNames.join(", ")}`
                      : "No specific team recommended in this answer"}
                  </p>
                </li>
              ))}
            </ul>
            <p className="mt-3 max-w-[65ch] text-xs text-muted-foreground">
              Try one yourself in ChatGPT right now. Any single answer varies — that&apos;s
              why we report rates over {snapshot.benchmark.responseCount} captured
              answers, not one reply. The pattern is the finding.
            </p>
          </Drawer>
        )}

        {gap && gap.signals.length > 0 && (
          <Drawer summary="Your track record — the part AI is missing">
            <ul className="space-y-1.5 text-sm">
              {gap.signals.map((s, i) => (
                <li key={i} className="max-w-[65ch]">
                  {s.label}{" "}
                  <span className="text-xs text-muted-foreground">
                    {s.sourceUrl ? (
                      <a
                        href={s.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2"
                      >
                        source
                      </a>
                    ) : (
                      s.provenance.replaceAll("_", " ")
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </Drawer>
        )}

        <Drawer summary="How this was measured">
          <p className="mb-3 max-w-[65ch] text-sm">
            In plain terms: we asked the same questions many times, saved every
            answer untouched, and counted the names. The details below are for
            the technically minded — the counting recipe above is the whole
            method.
          </p>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">When</dt>
              <dd className="mt-0.5 font-medium tabular-nums">
                {from}
                {to ? ` – ${to}` : ""}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">AI assistants</dt>
              <dd className="mt-0.5 font-medium">
                {snapshot.benchmark.providers.join(", ")}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Questions</dt>
              <dd className="mt-0.5 font-medium tabular-nums">
                {snapshot.benchmark.promptCount}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Answers captured</dt>
              <dd className="mt-0.5 font-medium tabular-nums">
                {snapshot.benchmark.responseCount}
              </dd>
            </div>
          </dl>
          <p className="mt-3 max-w-[65ch] text-xs text-muted-foreground">
            {snapshot.methodology}
          </p>
          <p className="mt-2 max-w-[65ch] text-xs text-muted-foreground">
            {snapshot.benchmark.limitations} Answers are content-hashed at capture and
            never edited.
          </p>
          {snapshot.evidenceExcerpts && snapshot.evidenceExcerpts.length > 1 && (
            <ul className="mt-3 space-y-3">
              {snapshot.evidenceExcerpts.slice(1).map((e, i) => (
                <li key={i} className="max-w-[65ch] border-l-2 border-foreground/15 pl-3 text-sm">
                  <p className={`${serif.className} italic`}>“{trimQuotes(e.quote)}”</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    recommending {e.teamName} ·{" "}
                    {new Date(e.capturedAt).toLocaleDateString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Drawer>
      </div>

      {/* ========================================================= CTA */}
      <section className="mt-14 border-t pt-8">
        <p className={`${serif.className} max-w-[42ch] text-balance text-lg`}>
          The answers change slowly, and they lean on the same sources again and
          again — teams that establish consistent signals early are hard to
          displace later.
        </p>
        <div className="mt-4">
          {ctaButton ?? (
            <p className="max-w-[65ch] text-sm">
              Reply {showMe} to the email that brought you here.
            </p>
          )}
        </div>
        <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">
          Every number on this page traces to a captured answer we can show you —
          skepticism welcome.{" "}
          {snapshot.transcripts && snapshot.transcripts.length > 0 && (
            <Link
              href={`/audit/${token}/answers`}
              className="underline underline-offset-2 transition-colors hover:text-foreground"
            >
              Read the answers first
            </Link>
          )}
        </p>
        {snapshot.preparedBy && (
          <p className="mt-6 text-xs text-muted-foreground">
            Prepared by {snapshot.preparedBy.name} · {snapshot.preparedBy.date} · report{" "}
            {snapshot.preparedBy.reportId}
          </p>
        )}
      </section>
    </div>
  );
}
