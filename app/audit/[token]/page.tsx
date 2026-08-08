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
import { visibilityThreshold } from "@/lib/prospects/constants";
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
  // Below 10% a filled sliver is illegible noise (PR B, P6): the count alone
  // carries it. Zero keeps its empty track — the empty track IS the finding.
  const showTrack = pct === 0 || pct >= 10;
  return (
    <span className="inline-flex items-center justify-end gap-2">
      {showTrack && (
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
      )}
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

  const from = snapshot.benchmark.dateRange.from.slice(0, 10);
  const to = snapshot.benchmark.dateRange.to
    ? snapshot.benchmark.dateRange.to.slice(0, 10)
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
  // Recommendation COUNT for a comparison row (rate × its own sample).
  const recsOf = (row: { recommendationRate: number | null; sampleSize: number }) =>
    Math.round((row.recommendationRate ?? 0) * row.sampleSize);
  // Two purpose-built heroes (PR B amendment 2). A named rival who owns the
  // answers is more urgent than open space — that case gets its own hero,
  // never the "you're #N and got zero" insult-first framing.
  const threshold = visibilityThreshold(snapshot.benchmark.responseCount);
  // A prospect who is already recommended at rival-level frequency has no
  // visibility gap to headline: "no team owns the answers" would be false,
  // and "X is ahead of you" would be manufactured urgency. Their snapshot
  // keeps the generator-written headline (and publish warns the operator
  // that the pitch is weak).
  const prospectIsVisible =
    stakes != null && stakes.yourRecommendations >= threshold;
  const rivalTeams = snapshot.comparison.filter((r) => !r.isProspect);
  const dominantRival =
    stakes != null && !prospectIsVisible
      ? rivalTeams
          .filter(
            (r) =>
              recsOf(r) >= threshold && recsOf(r) > 2 * stakes.yourRecommendations
          )
          .sort((a, b) => recsOf(b) - recsOf(a))[0] ?? null
      : null;
  const heroVariant: "rival" | "open" | "legacy" =
    stakes == null || prospectIsVisible ? "legacy" : dominantRival ? "rival" : "open";
  // Rank-vs-visibility callout (PR B, P4.4): rendered only when rank data
  // exists AND visibility demonstrably does not follow it — the generator
  // flags the correlated case to the operator at publish time instead.
  const rankedTeams = snapshot.comparison.filter(
    (r) => r.marketRank != null && r.recommendationRate != null
  );
  const bestRanked = [...rankedTeams].sort((a, b) => a.marketRank! - b.marketRank!)[0];
  const mostRecommended = [...rankedTeams].sort((a, b) => recsOf(b) - recsOf(a))[0];
  const rankCallout =
    stakes != null &&
    prospectRank != null &&
    rankedTeams.length >= 3 &&
    bestRanked &&
    mostRecommended &&
    bestRanked !== mostRecommended &&
    recsOf(mostRecommended) > recsOf(bestRanked)
      ? {
          bestRank: bestRanked.marketRank!,
          bestRecs: recsOf(bestRanked),
          topRank: mostRecommended.marketRank!,
          topRecs: recsOf(mostRecommended),
        }
      : null;
  // Three sample questions inline (PR B, P5f) — seller-intent first.
  // promptEvidence is per-response, so repeated prompts must dedupe.
  const sampleQuestions = [
    ...new Set(
      [
        ...snapshot.promptEvidence.filter((e) => /sell/i.test(e.promptText)),
        ...snapshot.promptEvidence.filter((e) => !/sell/i.test(e.promptText)),
      ].map((e) => e.promptText)
    ),
  ].slice(0, 3);
  // Plain-words repetition count for the visible recipe: exact when the
  // arithmetic is clean, honest-vague when partial failures made it ragged.
  const repsLabel =
    snapshot.benchmark.promptCount > 0 &&
    snapshot.benchmark.responseCount % snapshot.benchmark.promptCount === 0
      ? `${snapshot.benchmark.responseCount / snapshot.benchmark.promptCount} separate times`
      : "several separate times";
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
      {heroVariant === "rival" && dominantRival && stakes ? (
        // A named rival owns the answers: more urgent than open space, and
        // never insult-first toward a high performer (PR B amendment 2).
        <h1
          className={`${serif.className} mt-3 max-w-[28ch] text-balance text-2xl font-medium tracking-tight`}
        >
          {dominantRival.name} is recommended in {recsOf(dominantRival)} of{" "}
          {snapshot.benchmark.responseCount} answers.
          <br />
          You&apos;re in{" "}
          <span className="tabular-nums text-destructive">
            {stakes.yourRecommendations}
          </span>
          .
        </h1>
      ) : heroVariant === "open" && stakes ? (
        // The open-space framing: unclaimed, not losing (PR B, P4.2) — the
        // strongest line in the document, promoted from screen 3.
        <h1
          className={`${serif.className} mt-3 max-w-[28ch] text-balance text-2xl font-medium tracking-tight`}
        >
          No individual team owns {snapshot.marketName}&apos;s AI answers yet.
          <br />
          In {snapshot.benchmark.responseCount} answers, you were recommended{" "}
          <span className="tabular-nums text-destructive">
            {stakes.yourRecommendations}
          </span>{" "}
          time{stakes.yourRecommendations === 1 ? "" : "s"}.
        </h1>
      ) : (
        <h1
          className={`${serif.className} mt-3 max-w-[24ch] text-balance text-2xl font-medium tracking-tight`}
        >
          {snapshot.headline}
        </h1>
      )}
      <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">
        When buyers and sellers ask ChatGPT who to hire, the answers name names.
        We asked {snapshot.benchmark.promptCount} real {snapshot.marketName}{" "}
        questions; every answer is published below.
      </p>
      {/* Provenance up front (PR B, P5d): the trust claim before any number. */}
      <p className="mt-2 max-w-[65ch] text-xs text-muted-foreground">
        Everything on this page comes from public records and published AI
        answers — no estimates, no proprietary scores.
      </p>
      {snapshot.adoptionStat && (
        <p className="mt-2 max-w-[65ch] text-xs text-muted-foreground">
          {snapshot.adoptionStat.text}{" "}
          {snapshot.adoptionStat.sourceUrl ? (
            <a
              href={snapshot.adoptionStat.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              ({snapshot.adoptionStat.sourceLabel})
            </a>
          ) : (
            <>({snapshot.adoptionStat.sourceLabel})</>
          )}
        </p>
      )}

      {stakes ? (
        <section className="mt-10">
          {/* Honest total (P3): the count spans teams AND brokerage brands,
              so the line must not say "team". The split beneath is the
              open-space argument, not a caveat. */}
          <p className="text-2xl font-semibold tracking-tight">
            <span className="tabular-nums">{stakes.recommendationMomentsTotal}×</span>{" "}
            <span className="font-normal text-muted-foreground">
              the answer named someone specific to hire.
            </span>
          </p>
          <p className="mt-1 text-2xl font-semibold tracking-tight">
            <span className="tabular-nums text-destructive">
              {stakes.yourRecommendations}×
            </span>{" "}
            <span className="font-normal text-muted-foreground">it was you.</span>
          </p>
          {stakes.teamRecommendations != null &&
            stakes.brandRecommendations != null &&
            stakes.brandRecommendations > 0 && (
              <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">
                {stakes.teamRecommendations}× that was an individual team ·{" "}
                {stakes.brandRecommendations}× a brokerage brand
                {stakes.brandRecommendations > stakes.teamRecommendations &&
                  " — AI falls back to brand names when no team has given it a reason not to"}
                .
              </p>
            )}
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

      {/* Rank-vs-visibility (PR B, P4.4): generated from the data; renders
          only when rank demonstrably does NOT track visibility here — the
          correlated case is flagged to the operator at publish instead. */}
      {rankCallout && (
        <p className="mt-6 max-w-[65ch] text-sm">
          AI visibility doesn&apos;t follow market rank here: the #{rankCallout.bestRank}
          -ranked team was recommended {rankCallout.bestRecs}×, the #
          {rankCallout.topRank}-ranked {rankCallout.topRecs}×
          {prospectRank != null && stakes
            ? ` — and you (#${prospectRank}) ${stakes.yourRecommendations}×`
            : ""}
          .
        </p>
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
            {firstExcerpt.capturedAt.slice(0, 10)}
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

      {sampleQuestions.length >= 2 && (
        <p className="mt-6 max-w-[65ch] text-sm text-muted-foreground">
          We asked things like {sampleQuestions.map((q, i) => (
            <span key={i}>
              {i > 0 && " · "}
              <span className={`${serif.className} italic text-foreground`}>“{q}”</span>
            </span>
          ))}{" "}
          — the full list is below.
        </p>
      )}

      {/* Dollar stake (PR B, P5a): arithmetic on THEIR sourced numbers at a
          labeled, configurable estimate rate — never a loss claim. */}
      {stakes?.avgDealUsd != null && snapshot.commissionEstimate && (
        <p className="mt-6 max-w-[65ch] text-sm">
          One seller who asks an assistant instead of a neighbor:{" "}
          <span className="font-semibold tabular-nums">
            ~${snapshot.commissionEstimate.amountUsd.toLocaleString()}
          </span>{" "}
          in commission at your average sale of ~$
          {Math.round(stakes.avgDealUsd / 1000).toLocaleString()}K ({stakes.avgDealBasis};
          commission estimated at {snapshot.commissionEstimate.ratePct}%).
          {stakes.competitorsNamed.length > 0 &&
            ` Today that introduction goes to ${stakes.competitorsNamed[0]}.`}
        </p>
      )}

      <div className="mt-6">
        {ctaButton ?? (
          <p className="max-w-[65ch] text-sm">
            Reply to the email that brought you here — you&apos;ll get the
            15-minute walkthrough.
          </p>
        )}
        <p className="mt-2 max-w-[65ch] text-xs text-muted-foreground">
          15 minutes, no obligation. I&apos;ll show you the captured answers, the
          likely causes of the gap, and the first changes I&apos;d prioritize.
        </p>
      </div>

      {/* Below the fold: the record-vs-visibility contrast in FACTS — the
          numeric authority score is gone (PR B amendment 1); the sourced
          record is the strong side, stated as itself. */}
      {stakes && (stakes.volumeUsd != null || prospectRank != null) && (
        <p className="mt-10 max-w-[65ch] text-sm">
          <span className="font-medium">Track record:</span>{" "}
          {[
            prospectRank != null ? `#${prospectRank} by closed volume` : null,
            stakes.volumeUsd != null
              ? `$${(stakes.volumeUsd / 1_000_000).toFixed(2)}M${
                  stakes.sides != null ? ` across ${stakes.sides} sides` : ""
                }`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}{" "}
          (sourced below).{" "}
          <span className="font-medium">Visibility in AI answers:</span>{" "}
          <span className="tabular-nums text-destructive">
            {stakes.yourRecommendations} of {snapshot.benchmark.responseCount}
          </span>
          . <span className="font-medium">The good news:</span> the record
          isn&apos;t the problem — its visibility is, and that part is workable.
        </p>
      )}

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
              We asked each one {repsLabel} — single answers vary; the pattern
              across {snapshot.benchmark.responseCount} is the finding.
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
                        <li key={b.name} className="text-sm">
                          <span className="flex items-center gap-2">
                            <span className="w-44 truncate text-muted-foreground">
                              {b.name}
                            </span>
                            <RateBar
                              value={b.mentionRate}
                              isSubject={false}
                              of={snapshot.benchmark.responseCount}
                            />
                          </span>
                          {b.children && b.children.length > 0 && (
                            <ul className="mt-1.5 space-y-1.5">
                              {b.children.map((child) => (
                                <li
                                  key={child.name}
                                  className="flex items-center gap-2 pl-5"
                                >
                                  <span className="w-[9.75rem] truncate text-muted-foreground">
                                    ↳ {child.name}
                                  </span>
                                  <RateBar
                                    value={child.mentionRate}
                                    isSubject={false}
                                    of={snapshot.benchmark.responseCount}
                                  />
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                    {snapshot.brandMentions.some(
                      (b) => b.children && b.children.length > 0
                    ) && (
                      <p className="mt-1.5 max-w-[65ch] text-xs text-muted-foreground">
                        Indented names extend the brand above them; one answer can
                        register both, so the rows overlap rather than add up.
                      </p>
                    )}
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


      {/* ============================= the diagnosis, in the open (spec 048):
          proof of a problem earns attention; visible reasons and fixes earn
          the meeting. Detail and receipts stay folded below. */}
      {snapshot.whyItHappens && snapshot.whyItHappens.length > 0 && (
        <section className="mt-14">
          <h2 className="text-lg font-medium">
            Why AI is overlooking {snapshot.prospectName}
          </h2>
          {/* The one observation a human actually made about THIS prospect's
              footprint (PR B, P5c) — the sentence that proves a person looked,
              not a template. Its absence is warned at publish time. */}
          {snapshot.humanFinding && (
            <div className="mt-4 max-w-[65ch] rounded-md border border-foreground/25 bg-muted/40 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                What we saw on your actual profiles
              </p>
              <p className="mt-1.5 text-sm">{snapshot.humanFinding.text}</p>
              {snapshot.humanFinding.sourceUrl && (
                <a
                  href={snapshot.humanFinding.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1.5 inline-block text-xs text-muted-foreground underline underline-offset-2"
                >
                  source
                </a>
              )}
            </div>
          )}
          {!snapshot.humanFinding && process.env.NODE_ENV !== "production" && (
            <div className="mt-4 max-w-[65ch] rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm">
              <p className="font-medium">
                Dev only: no human finding on this snapshot.
              </p>
              <p className="mt-1 text-muted-foreground">
                Spend 10 minutes and republish with one observation from:
              </p>
              <ul className="mt-1.5 list-disc pl-5 text-muted-foreground">
                <li>Zillow — review count, and whether recent solds are tagged</li>
                <li>realtor.com — does the profile exist and match the team name</li>
                <li>Google Business — claimed? review count vs the named rivals</li>
                <li>Brokerage bio page — does it say what they actually specialize in</li>
              </ul>
            </div>
          )}
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
                    {e.capturedAt.slice(0, 10)}
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
              Reply to the email that brought you here — you&apos;ll get the
              15-minute walkthrough.
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
            Prepared by {snapshot.preparedBy.name}
            {snapshot.preparedBy.company && ` · ${snapshot.preparedBy.company}`}
            {snapshot.preparedBy.credential && ` — ${snapshot.preparedBy.credential}`}
            {snapshot.preparedBy.email && ` · ${snapshot.preparedBy.email}`}
            {` · ${snapshot.preparedBy.date} · report ${snapshot.preparedBy.reportId}`}
          </p>
        )}
      </section>
    </div>
  );
}
