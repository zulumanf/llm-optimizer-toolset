/**
 * Public prospect audit page (specs 032/045/048/093, rebuilt by spec 123).
 * The platform's only anonymous content surface: resolves a high-entropy
 * token to a published snapshot and renders nothing else. No auth call, no
 * live internal queries — internal notes cannot leak because they were
 * never put in the snapshot. Wrong, revoked, and expired tokens are
 * indistinguishable (all 404).
 *
 * Design: a simple, evidence-backed sales diagnostic (spec 123 round 2) —
 * NOT a benchmark report. A non-technical reader who scans only headings,
 * bold text, numbers, competitor names, and buttons gets the whole pitch:
 * we tested what AI says → you're not recommended enough → others are →
 * your real reputation is stronger than your AI presence → we fix it and
 * keep measuring → verify everything below. One dominant denominator in
 * the primary flow; every caveat, definition, and secondary count lives in
 * the collapsed proof. Presentation-only — renders any published snapshot,
 * old or new (every newer field is guarded).
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Newsreader } from "next/font/google";
import { ChevronRight } from "lucide-react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getAuditPageByToken } from "@/lib/prospects/service";
import { EngagementBeacon } from "@/components/audit/engagement-beacon";
import {
  answersTestedPhrase,
  comparisonBasisNote,
  heroHeadline,
  heroOpportunityLine,
  narrativeState,
  publishedAnswersNote,
} from "@/components/audit/narrative";
import { formatVerifiedProduction } from "@/lib/prospects/realtrends";
import { getCurrentUserOrNull, isStaff } from "@/lib/auth";
import { visibilityThreshold } from "@/lib/prospects/constants";
import {
  MENTIONS_VS_ANSWERS_NOTE,
  providersDisplay,
  sourceQualityLabel,
  testedSystemPhrase,
  verifySuggestionApps,
} from "@/lib/prospects/terminology";
import {
  collectSnapshotEvidenceUrls,
  evidenceHref,
  latestLinkHealth,
} from "@/lib/evidence/link-health";

const serif = Newsreader({ subsets: ["latin"], weight: ["400", "500"], style: ["normal", "italic"] });

export const metadata: Metadata = {
  title: "AI Visibility Report",
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

/** Count-scaled micro-bar for the competitor and source lists: width
 * relative to the largest count shown, value in the adjacent label. Same
 * SVG discipline as RateBar. */
function CountBar({
  count,
  max,
  isSubject,
}: {
  count: number;
  max: number;
  isSubject: boolean;
}) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <svg
      className="h-1.5 w-16 shrink-0 sm:w-24"
      viewBox="0 0 100 6"
      preserveAspectRatio="none"
      role="img"
      aria-label={`${count}`}
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
  );
}

/** Styled disclosure — hover, focus ring, rotating chevron (house rules #4). */
function Drawer({
  summary,
  children,
  signalSection,
  signalEvidence,
  id,
}: {
  summary: string;
  children: React.ReactNode;
  /** Engagement beacon keys (spec 098): opening reports a section view or
   * an evidence expansion. Presentation-neutral data attributes only. */
  signalSection?: string;
  signalEvidence?: string;
  /** Anchor target (e.g. the hero's "How this was measured" link). */
  id?: string;
}) {
  return (
    <details
      className="group scroll-mt-6 py-4"
      data-signal-section={signalSection}
      data-signal-evidence={signalEvidence}
      id={id}
    >
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
  // The segment is [handle] so the branded sibling [handle]/[key] can
  // coexist (Next.js requires one param name per level). For this legacy
  // route the handle IS the 43-char access token; URLs are unchanged.
  // linkKey is set by the branded sibling route (spec 076) so the view row
  // records which emailed link brought the visit (spec 098 attribution).
  params: Promise<{ handle: string; linkKey?: string; slug?: string }>;
}) {
  const { handle: token, linkKey, slug } = await params;
  // Keep the reader on the branded link so the answers view is attributed
  // to the same emailed key instead of landing as a bare-token "session".
  const answersHref =
    linkKey && slug ? `/audit/${slug}/${linkKey}/answers` : `/audit/${token}/answers`;
  const hdrs = await headers();
  // Session read is only to LABEL the view (plan 3.6): an operator's QA
  // open must not count as prospect interest. Content still comes solely
  // from the snapshot; anonymous visitors take the same path as ever.
  const viewer = await getCurrentUserOrNull();
  const page = await getAuditPageByToken(token, {
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent"),
    internal: viewer !== null && isStaff(viewer),
    linkKey: linkKey ?? null,
    referrer: hdrs.get("referer"),
  });
  if (!page) notFound();
  const { snapshot, viewId } = page;

  // Receipt-link health (2026-08-19): a known-dead evidence link must not
  // render as a live one. Unknown URLs (never checked) render as-is; a
  // redirect points at the current canonical page. Presentation-only — the
  // snapshot's citation metadata is untouched.
  const linkHealth = await latestLinkHealth(collectSnapshotEvidenceUrls(snapshot));
  const receiptHref = (url: string | null | undefined) =>
    url ? evidenceHref(url, linkHealth.get(url)) : { href: null, moved: false };

  const from = snapshot.benchmark.dateRange.from.slice(0, 10);
  const to = snapshot.benchmark.dateRange.to
    ? snapshot.benchmark.dateRange.to.slice(0, 10)
    : null;
  const gap = snapshot.authorityGap;
  const stakes = snapshot.stakes;
  const responseCount = snapshot.benchmark.responseCount;
  // Captured excerpts arrive wearing the assistant's own formatting — outer
  // quotation marks and literal markdown bold markers. Strip both; the
  // template supplies the typography. The words themselves are never altered.
  const trimQuotes = (s: string): string =>
    s
      .replaceAll("**", "")
      .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "");
  // The blockquote earns its serif with the most substantial excerpt, not
  // whichever company sorted first — a two-word quote reads as a glitch.
  const firstExcerpt = [...(snapshot.evidenceExcerpts ?? [])].sort(
    (a, b) => b.quote.length - a.quote.length
  )[0];
  const prospectRank = snapshot.comparison.find((r) => r.isProspect)?.marketRank ?? null;
  // Recommendation COUNT for a comparison row (rate × its own sample).
  const recsOf = (row: { recommendationRate: number | null; sampleSize: number }) =>
    Math.round((row.recommendationRate ?? 0) * row.sampleSize);

  // The narrative state (spec 123): same page structure in every state, the
  // story matched to the evidence — zero, low, strong, leader, or the
  // legacy generator headline for pre-stakes snapshots.
  const prospectRow = snapshot.comparison.find((r) => r.isProspect) ?? null;
  const rivalRows = snapshot.comparison.filter((r) => !r.isProspect);
  const prospectRecsOnBasis = prospectRow
    ? recsOf(prospectRow)
    : stakes?.yourRecommendations ?? 0;
  const topRivalRecs = rivalRows.reduce((m, r) => Math.max(m, recsOf(r)), 0);
  const state = narrativeState({
    yourRecommendations: stakes?.yourRecommendations ?? null,
    responseCount,
    prospectRowRecommendations: prospectRow ? recsOf(prospectRow) : null,
    topRivalRecommendations: topRivalRecs,
  });
  // The pain color marks the prospect's own low numbers ONLY (color budget):
  // a strong or leading team's count is not a wound and never renders red.
  const pain = state === "zero" || state === "low" || state === "legacy";
  const headline = heroHeadline(state, {
    prospectName: snapshot.prospectName,
    marketName: snapshot.marketName,
    rivalsCountedAhead: rivalRows.filter((r) => recsOf(r) > prospectRecsOnBasis)
      .length,
    legacyHeadline: snapshot.headline,
  });
  const opportunityLine = heroOpportunityLine(state, {
    marketName: snapshot.marketName,
    anyRivalDominates: topRivalRecs >= visibilityThreshold(responseCount),
    competitorsWereRecommended: (stakes?.competitorsNamed.length ?? 0) > 0,
  });
  const answersTested = answersTestedPhrase(
    snapshot.benchmark.providers,
    responseCount
  );

  // Competitor contrast: the strongest rival TEAMS by counted
  // recommendations (never brand-led when named teams exist), the
  // prospect's own row last and unmistakable. The full table folds into
  // "See full competitor data" in the proof section.
  const topRivals = rivalRows
    .filter((r) => recsOf(r) > 0)
    .sort((a, b) => recsOf(b) - recsOf(a))
    .slice(0, 5);
  const maxListedRecs = Math.max(
    prospectRecsOnBasis,
    ...topRivals.map((r) => recsOf(r)),
    1
  );
  // One dominant denominator (spec 123 round 2): the primary flow shows
  // bare counts against the one headline denominator; a differing counting
  // basis is explained ONCE, in the methodology drawer.
  const comparisonBasis =
    prospectRow?.sampleSize ?? topRivals[0]?.sampleSize ?? null;
  const basisNote = comparisonBasisNote(comparisonBasis, responseCount);

  // Rank-vs-visibility (PR B, P4.4): rendered only when rank data exists
  // AND visibility demonstrably does not follow it — the generator flags
  // the correlated case to the operator at publish time instead.
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

  // Completeness is claimed only when provable (launch fix 2026-08-14):
  // "every answer" appears solely when the snapshot holds every qualifying
  // capture (transcriptTotal, stamped at publish); a capped appendix states
  // shown-of-total instead. Legacy snapshots lack the total and never claim
  // completeness.
  const transcriptsShown = snapshot.transcripts?.length ?? 0;
  const transcriptTotal = snapshot.transcriptTotal ?? null;
  // Plain-words repetition count for the collapsed recipe: exact when the
  // arithmetic is clean, honest-vague when partial failures made it ragged.
  const repsLabel =
    snapshot.benchmark.promptCount > 0 &&
    responseCount % snapshot.benchmark.promptCount === 0
      ? `${responseCount / snapshot.benchmark.promptCount} separate times`
      : "several separate times";
  // The reputation contrast renders only when the snapshot carries a
  // verified record to hold against the count — never a one-sided "gap",
  // and never forced negativity onto a leading team.
  const hasRecordFacts =
    Boolean(snapshot.verifiedProduction) ||
    (stakes != null && (stakes.volumeUsd != null || prospectRank != null));
  // One-click conversion: a mailto with the two-word reply prefilled.
  // Falls back to the plain text ask on snapshots without a reply address.
  const replyEmail = snapshot.preparedBy?.email;
  const mailto = replyEmail
    ? `mailto:${replyEmail}?subject=${encodeURIComponent(
        `show me — ${snapshot.prospectName}`
      )}&body=${encodeURIComponent("show me")}`
    : null;
  // ONE CTA promise: identical button + commitment wording at both
  // placements (prospect-voice: the ask repeats top and bottom).
  const ctaBlock = (
    <div>
      {mailto ? (
        <a
          href={mailto}
          data-signal-cta="walkthrough"
          className="inline-flex w-full items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto"
        >
          Show me the plan
        </a>
      ) : (
        <p className="max-w-[65ch] text-sm">
          Reply <span className="font-medium">“show me”</span> to the email
          that brought you here.
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        15 minutes · no obligation.
      </p>
    </div>
  );

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <EngagementBeacon viewId={viewId} />
      {/* ================================================== 1 · hero.
          Scan path: eyebrow → headline → the number → one denominator →
          one opportunity line → the button. No methodology, no caveats —
          those live behind the anchor below the CTA. */}
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Private AI visibility report
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {snapshot.prospectName} · {snapshot.marketName}
      </p>
      <h1
        className={`${serif.className} mt-4 max-w-[26ch] text-balance text-2xl font-medium tracking-tight`}
      >
        {headline}
      </h1>
      {stakes && (
        <div className="mt-8">
          <p
            className={`text-6xl font-semibold tabular-nums tracking-tight ${
              pain ? "text-destructive" : ""
            }`}
          >
            {stakes.yourRecommendations}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            recommendation{stakes.yourRecommendations === 1 ? "" : "s"}
          </p>
        </div>
      )}
      <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">
        Across {answersTested}.
      </p>
      {opportunityLine && (
        <p className={`${serif.className} mt-3 max-w-[40ch] text-balance text-lg`}>
          {opportunityLine}
        </p>
      )}
      <div className="mt-6">{ctaBlock}</div>
      <p className="mt-3 text-xs">
        <a
          href="#methodology"
          className="text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
        >
          How this was measured ↓
        </a>
      </p>

      {/* ======================================= 2 · competitor contrast */}
      {snapshot.comparison.length > 0 && (
        <section className="mt-14" data-signal-section="competitors">
          <h2 className="text-lg font-medium">
            {pain
              ? `Other ${snapshot.marketName} agents were recommended`
              : `Who else was recommended`}
          </h2>
          {stakes && (
            // Honest units (Team Moza rounds 1+2): the total is EXPLICIT
            // recommendations only — never answer counts — and the unit
            // note sits AT the number.
            <p className="mt-2 max-w-[65ch] text-sm text-muted-foreground">
              Assistants made{" "}
              <span className="font-medium text-foreground">
                {stakes.recommendationMomentsTotal}
              </span>{" "}
              explicit recommendations — of a team, agent, or brokerage — across
              the {responseCount} answers.{" "}
              <span className={`font-medium ${pain ? "text-destructive" : "text-foreground"}`}>
                {stakes.yourRecommendations}{" "}
                {stakes.yourRecommendations === 1 ? "was" : "were"} you.
              </span>{" "}
              {MENTIONS_VS_ANSWERS_NOTE}
            </p>
          )}
          {topRivals.length === 0 && (stakes?.competitorsNamed.length ?? 0) > 0 && (
            // No individual team was counted ahead — the recommendations
            // went to brand-level names. Say who, counted, without a table.
            <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">
              Most frequently recommended:{" "}
              <span className="font-medium text-foreground">
                {(stakes?.competitorsNamed ?? []).slice(0, 4).join(" · ")}
              </span>
            </p>
          )}
          <ul className="mt-4 max-w-[65ch] space-y-2.5">
            {topRivals.map((r) => (
              <li
                key={r.name}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="min-w-0 truncate">{r.name}</span>
                <span className="inline-flex shrink-0 items-center gap-2 text-muted-foreground">
                  <CountBar count={recsOf(r)} max={maxListedRecs} isSubject={false} />
                  <span className="w-24 text-right tabular-nums">
                    recommended {recsOf(r)}×
                  </span>
                </span>
              </li>
            ))}
            <li className="flex items-center justify-between gap-3 border-t pt-2.5 text-sm font-semibold">
              <span className="min-w-0 truncate">
                {snapshot.prospectName} ← you
              </span>
              <span className="inline-flex shrink-0 items-center gap-2">
                <CountBar
                  count={prospectRecsOnBasis}
                  max={maxListedRecs}
                  isSubject={pain}
                />
                <span
                  className={`w-24 text-right tabular-nums ${pain ? "text-destructive" : ""}`}
                >
                  recommended {prospectRecsOnBasis}×
                </span>
              </span>
            </li>
          </ul>
          {firstExcerpt && (
            <blockquote className="mt-6 max-w-[65ch] border-l-2 border-foreground/20 pl-4">
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
        </section>
      )}

      {/* ========================================= 3 · why this matters */}
      <section className="mt-14">
        <h2 className="text-lg font-medium">Why this matters</h2>
        <p className="mt-2 max-w-[65ch] text-sm text-muted-foreground">
          Buyers and sellers now ask{" "}
          {verifySuggestionApps(snapshot.benchmark.providers)} who to work
          with, the same way they ask Google. If your name isn&apos;t in the
          answer, another agent gets considered.
        </p>
      </section>

      {/* ========================= 4 · your reputation vs your AI presence */}
      {hasRecordFacts && stakes && state !== "leader" && (
        <section className="mt-14" data-signal-section="gap">
          <h2 className="text-lg font-medium">
            Your reputation vs your AI presence
          </h2>
          {snapshot.verifiedProduction ? (
            <p className="mt-2 max-w-[65ch] text-sm">
              <span className="font-medium">Real-world proof:</span>{" "}
              {formatVerifiedProduction(snapshot.verifiedProduction).headline} ·{" "}
              {formatVerifiedProduction(snapshot.verifiedProduction).detail}{" "}
              {receiptHref(snapshot.verifiedProduction.sourceUrl).href ? (
                <a
                  href={receiptHref(snapshot.verifiedProduction.sourceUrl).href!}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                >
                  (source, retrieved {snapshot.verifiedProduction.retrievedOn})
                </a>
              ) : (
                <span className="text-muted-foreground">
                  (source retrieved {snapshot.verifiedProduction.retrievedOn};
                  the original page has since moved — the citation is preserved
                  and available on request)
                </span>
              )}
            </p>
          ) : (
            <p className="mt-2 max-w-[65ch] text-sm">
              <span className="font-medium">Real-world proof:</span>{" "}
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
              (sourced under “Your track record” below).
            </p>
          )}
          <p className="mt-2 max-w-[65ch] text-sm">
            <span className="font-medium">AI recommendations:</span>{" "}
            <span className={`tabular-nums ${pain ? "text-destructive" : ""}`}>
              {stakes.yourRecommendations} of the {responseCount} answers we
              tested
            </span>
            .
          </p>
          {pain && (
            <p className="mt-3 max-w-[65ch] text-sm font-medium">
              That&apos;s the gap — and it&apos;s the workable part.
            </p>
          )}
          {rankCallout && (
            <p className="mt-2 max-w-[65ch] text-xs text-muted-foreground">
              In the answers we tested, market rank did not decide who gets
              recommended: the #{rankCallout.bestRank}-ranked team was
              recommended in {rankCallout.bestRecs} answers, the #
              {rankCallout.topRank}-ranked in {rankCallout.topRecs}.
            </p>
          )}
          {/* The one observation a human actually made about THIS
              prospect's footprint (PR B, P5c) — proof a person looked. */}
          {snapshot.humanFinding && (
            <div className="mt-4 max-w-[65ch] rounded-md border border-foreground/25 bg-muted/40 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                What we saw on your actual profiles
              </p>
              <p className="mt-1.5 text-sm">{snapshot.humanFinding.text}</p>
              {snapshot.humanFinding.sourceUrl &&
                (receiptHref(snapshot.humanFinding.sourceUrl).href ? (
                  <a
                    href={receiptHref(snapshot.humanFinding.sourceUrl).href!}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1.5 inline-block text-xs text-muted-foreground underline underline-offset-2"
                  >
                    source
                  </a>
                ) : (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    source on file (original page has since moved)
                  </p>
                ))}
            </div>
          )}
        </section>
      )}
      {!snapshot.humanFinding && process.env.NODE_ENV !== "production" && (
        <div className="mt-6 max-w-[65ch] rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm">
          <p className="font-medium">
            Dev only: no human finding on this snapshot.
          </p>
          <p className="mt-1 text-muted-foreground">
            Spend 10 minutes and republish with one observation from Zillow,
            realtor.com, Google Business, or the brokerage bio page.
          </p>
        </div>
      )}

      {/* ================================================ 5 · what we do */}
      <section className="mt-14" data-signal-section="what-we-do">
        <h2 className="text-lg font-medium">What we do</h2>
        <p className="mt-2 max-w-[65ch] text-sm text-muted-foreground">
          We help established real-estate teams become more likely to be
          recommended when buyers and sellers ask AI who to work with.
        </p>
        <ol className="mt-4 max-w-[65ch] space-y-3">
          <li>
            <p className="text-sm font-medium">1. Find the gaps</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Pinpoint where AI&apos;s picture of your team falls short of
              your record.
            </p>
          </li>
          <li>
            <p className="text-sm font-medium">2. Fix the information</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Strengthen the public information AI finds about your team.
            </p>
          </li>
          <li>
            <p className="text-sm font-medium">3. Keep measuring</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Re-run the same questions and show whether the answers change.
            </p>
          </li>
        </ol>
      </section>

      {/* ============================== 6 · where AI got its information */}
      {snapshot.topSources && snapshot.topSources.length > 0 && (
        <section className="mt-14" data-signal-section="sources">
          <h2 className="text-lg font-medium">Where AI got its information</h2>
          <ul className="mt-4 max-w-[65ch] space-y-2.5">
            {(() => {
              const maxCitations = Math.max(
                ...snapshot.topSources.map((s) => s.citations),
                1
              );
              return snapshot.topSources.map((s) => (
                <li
                  key={s.domain}
                  className={`flex items-center justify-between gap-3 text-sm ${
                    s.category === "owned" ? "font-semibold" : ""
                  }`}
                >
                  <span className="min-w-0 truncate">
                    {s.domain}
                    {s.category === "owned" && " ← your website"}
                    {s.category === "competitor" && (
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                        competitor-owned
                      </span>
                    )}
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-2 text-muted-foreground">
                    <CountBar count={s.citations} max={maxCitations} isSubject={false} />
                    <span className="w-11 text-right tabular-nums">
                      {s.citations}×
                    </span>
                  </span>
                </li>
              ));
            })()}
            {/* Claimable only when the classifier ran (spec 086): on legacy
                uncategorized snapshots we cannot prove the absence. */}
            {snapshot.topSources.some((s) => s.category != null) &&
              !snapshot.topSources.some((s) => s.category === "owned") && (
                <li className="flex items-center justify-between gap-3 border-t pt-2.5 text-sm font-semibold">
                  <span className="min-w-0 truncate">Your website ← you</span>
                  <span
                    className={`shrink-0 text-right text-xs font-normal ${
                      pain ? "text-destructive" : "text-muted-foreground"
                    }`}
                  >
                    not among these sources
                  </span>
                </li>
              )}
          </ul>
          <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">
            These are some of the websites AI used while answering the
            questions we tested.{" "}
            <span className="font-medium text-foreground">
              This tells us where to start.
            </span>
          </p>
          <p className="mt-2 max-w-[65ch] text-xs text-muted-foreground">
            Citation frequency does not establish that any one source caused a
            recommendation — but it shows where stronger information about
            your team could live.
          </p>
        </section>
      )}

      {/* ======================================================= 7 · CTA */}
      <section className="mt-14 border-t pt-8" data-signal-section="cta">
        <p className={`${serif.className} max-w-[42ch] text-balance text-lg`}>
          Want to see what I&apos;d change first?
        </p>
        <p className="mt-1 max-w-[65ch] text-sm text-muted-foreground">
          I&apos;ll show you the biggest gaps I found for{" "}
          {snapshot.prospectName} and the first things I&apos;d fix.
        </p>
        <div className="mt-4">{ctaBlock}</div>
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

      {/* ==================================== 8 · the proof, collapsed */}
      <section className="mt-14 border-t pt-8" data-signal-section="raw-answers">
        <h2 className="text-lg font-medium">Want to verify the data?</h2>
        {transcriptsShown > 0 && (
          <>
            <p className="mt-2 max-w-[65ch] text-sm text-muted-foreground">
              We saved the actual AI answers so you can search your name and
              verify the findings yourself.
            </p>
            <p className="mt-3">
              <Link
                href={answersHref}
                className="inline-flex w-full items-center justify-center rounded-md border px-5 py-2.5 text-sm font-medium transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto"
              >
                View the answers
              </Link>
            </p>
            <p className="mt-2 max-w-[65ch] text-xs text-muted-foreground">
              {publishedAnswersNote(transcriptsShown, transcriptTotal)}
            </p>
          </>
        )}
        {/* A share link the assistant's site no longer serves is dropped
            from the demo line rather than rendered dead (link health,
            2026-08-19). */}
        {snapshot.exampleChats &&
          snapshot.exampleChats.filter((c) => receiptHref(c.url).href).length >
            0 && (
            <p className="mt-3 max-w-[65ch] text-sm">
              <span className="font-medium">See it live:</span>{" "}
              {snapshot.exampleChats
                .filter((c) => receiptHref(c.url).href)
                .map((chat, i) => (
                  <span key={i}>
                    {i > 0 && " · "}
                    <a
                      href={receiptHref(chat.url).href!}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2 transition-colors hover:text-muted-foreground"
                    >
                      a real{" "}
                      {chat.assistant === "chatgpt" ? "ChatGPT" : "Perplexity"}{" "}
                      conversation from {chat.capturedOn}
                    </a>
                  </span>
                ))}{" "}
              — hosted on the assistant&apos;s own site, not ours.
            </p>
          )}

        <div className="mt-6 divide-y border-y">
          {snapshot.comparison.length > 0 && (
            <Drawer summary="See full competitor data" signalEvidence="comparison">
              <p className="max-w-[65ch] text-xs text-muted-foreground">
                <span className="text-foreground">Brought up</span> = named at
                all. <span className="text-foreground">Recommended</span> = the
                answer expressly suggested hiring or using the team or agent.
                One answer can name several, so counts overlap. The set is
                every business the answers named — individual agents, teams,
                and brokerage brands together — not a curated peer group.
              </p>
              {(() => {
                const hasRanks = snapshot.comparison.some(
                  (r) => r.marketRank != null
                );
                return (
                  <div className="mt-3 overflow-x-auto">
                    {/* min-w keeps columns intact on phones: the table
                        scrolls sideways inside this container instead of
                        crushing team names into four lines. */}
                    <table className="w-full min-w-[560px] text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs text-muted-foreground">
                          <th className="py-2 pr-4 font-medium">Team</th>
                          {hasRanks && (
                            <th className="py-2 pr-4 text-right font-medium">
                              Market rank*
                            </th>
                          )}
                          <th className="py-2 pr-4 text-right font-medium">
                            Brought up
                          </th>
                          <th className="py-2 pr-4 text-right font-medium">
                            Recommended
                          </th>
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
                                isSubject={row.isProspect && pain}
                                of={row.sampleSize}
                              />
                            </td>
                            <td className="py-2 pr-4 text-right">
                              <RateBar
                                value={row.recommendationRate}
                                isSubject={row.isProspect && pain}
                                of={row.sampleSize}
                              />
                            </td>
                            <td className="py-2 text-right tabular-nums">
                              {row.sampleSize}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {hasRanks && (
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        * City ranking by closed sales volume — sourced under
                        “Your track record” below.
                      </p>
                    )}
                    {snapshot.brandMentions && snapshot.brandMentions.length > 0 && (
                      <div className="mt-4">
                        <p className="text-xs font-medium text-muted-foreground">
                          The rest went to brand-level names, not teams —
                          brought up:
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
                                  of={responseCount}
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
                                        of={responseCount}
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
                            Indented names extend the brand above them; one
                            answer can register both, so the rows overlap
                            rather than add up.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
            </Drawer>
          )}

          {snapshot.whyItHappens && snapshot.whyItHappens.length > 0 && (
            <Drawer
              summary="Where the gap shows up — what we counted"
              signalSection="diagnosis"
            >
              <ul className="space-y-4">
                {snapshot.whyItHappens.map((why, i) => (
                  <li key={i} className="max-w-[65ch]">
                    <p className="text-sm font-medium">
                      {i + 1}. {why.title}
                    </p>
                    {why.observations?.map((obs, j) => (
                      <p key={j} className="mt-0.5 text-xs text-muted-foreground">
                        Counted: {obs}
                      </p>
                    ))}
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {why.suggestedAction}
                    </p>
                  </li>
                ))}
              </ul>
            </Drawer>
          )}

          {snapshot.promptEvidence.length > 0 && (
            <Drawer summary="The questions we asked — and who was named" signalEvidence="prompts">
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
                Try one yourself in{" "}
                {verifySuggestionApps(snapshot.benchmark.providers)} right now.
                Any single answer varies — that&apos;s why we count across{" "}
                {responseCount} answers, not one reply. The pattern is the
                finding.
                {transcriptsShown > 0 &&
                  " The full question list is in the answers appendix."}
              </p>
            </Drawer>
          )}

          {gap && gap.signals.length > 0 && (
            <Drawer summary="Your track record — the receipts" signalSection="authority">
              <ul className="space-y-1.5 text-sm">
                {gap.signals.map((s, i) => {
                  const link = receiptHref(s.sourceUrl);
                  const quality = sourceQualityLabel(s.sourceType);
                  return (
                    <li key={i} className="max-w-[65ch]">
                      {s.label}{" "}
                      <span className="text-xs text-muted-foreground">
                        {quality && (
                          <span className="mr-1 rounded-sm border px-1 py-0.5">
                            {quality}
                          </span>
                        )}
                        {s.sourceUrl && link.href ? (
                          <a
                            href={link.href}
                            target="_blank"
                            rel="noreferrer"
                            className="underline underline-offset-2"
                          >
                            source
                          </a>
                        ) : s.sourceUrl ? (
                          <>source on file (original page has since moved)</>
                        ) : (
                          s.provenance.replaceAll("_", " ")
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Drawer>
          )}

          {/* Business significance stays folded (spec 093): a dollar
              calculation in the open shifts the tone from evidence-led to
              sales arithmetic. Full illustrative-estimate disclaimer intact —
              an illustrative estimate, never a verified claim. */}
          {stakes?.avgDealUsd != null && snapshot.commissionEstimate && (
            <Drawer summary="Why this could matter financially — an illustrative calculation">
              <p className="max-w-[65ch] text-xs text-muted-foreground">
                At {snapshot.prospectName}&apos;s reported average closed
                volume per side ({stakes.avgDealBasis}), one additional
                transaction could be commercially meaningful. Illustration
                only — an illustrative estimate, not a measurement: ≈ $
                {Math.round(stakes.avgDealUsd / 1000).toLocaleString()}K
                average volume × an assumed{" "}
                {snapshot.commissionEstimate.ratePct}% commission ≈ $
                {snapshot.commissionEstimate.amountUsd.toLocaleString()} gross
                commission. This is not a forecast of referrals, commissions,
                or revenue from AI visibility; the sourced record reports
                production volume, not commission income.
              </p>
            </Drawer>
          )}

          <Drawer summary="How we ran the test" signalSection="methodology" id="methodology">
            <p className="mb-3 max-w-[65ch] text-sm">
              In plain terms: we asked {snapshot.benchmark.promptCount} real
              buyer and seller questions, each {repsLabel}, recorded every
              answer untouched, and counted which businesses each answer
              brought up and which it recommended. That counting recipe is the
              whole method.
            </p>
            {/* Compact disclosure (compliance pass 2026-08-19), every figure
                derived from the snapshot — dates, counts, and the tested
                system are never hardcoded. */}
            <p className="mb-3 max-w-[65ch] text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Methodology:</span>{" "}
              we ran {snapshot.benchmark.promptCount} {snapshot.marketName}{" "}
              buyer and seller prompts, each {repsLabel}, through{" "}
              {testedSystemPhrase(snapshot.benchmark.providers, snapshot.collection)}{" "}
              between {from}{to ? ` and ${to}` : ""}, producing{" "}
              {responseCount} captured answers.
              &ldquo;Recommended&rdquo; means the answer expressly suggested
              hiring or using a named team or agent.
              {transcriptsShown > 0 &&
                " Exact model identifiers are shown with each captured answer in the appendix."}
            </p>
            {basisNote && (
              // The 354-of-512 explanation lives here, said once — the
              // primary flow keeps one denominator (spec 123 round 2).
              <p className="mb-3 max-w-[65ch] text-xs text-muted-foreground">
                {basisNote}
              </p>
            )}
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">When</dt>
                <dd className="mt-0.5 font-medium tabular-nums">
                  {from}
                  {to ? ` – ${to}` : ""}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">AI providers</dt>
                <dd className="mt-0.5 font-medium">
                  {providersDisplay(snapshot.benchmark.providers)}
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
                  {responseCount}
                </dd>
              </div>
            </dl>
            {/* Collection provenance (spec 086) — how the answers were
                gathered, said plainly. Older snapshots carry no collection
                block and render without this line. */}
            {snapshot.collection && (
              <p className="mt-3 max-w-[65ch] text-xs text-muted-foreground">
                Collected through the assistants&apos; official interfaces for
                developers
                {snapshot.collection.searchEnabled > 0 &&
                snapshot.collection.modelOnly > 0
                  ? ` — ${snapshot.collection.searchEnabled} answers with live web search on, ${snapshot.collection.modelOnly} without`
                  : snapshot.collection.searchEnabled > 0
                    ? " with live web search on"
                    : ""}
                .
                {!snapshot.consumerValidation &&
                  " We did not additionally hand-check the consumer apps for this report; the counting method is identical either way."}
              </p>
            )}
            {snapshot.consumerValidation && (
              <div className="mt-3 max-w-[65ch] rounded-md border p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Hand-checked in the consumer apps
                </p>
                <p className="mt-1 text-sm">
                  Separately from the systematic measurement above, we asked
                  the same questions by hand in fresh sessions of the consumer
                  apps ({snapshot.consumerValidation.performedFrom}
                  {snapshot.consumerValidation.performedTo !==
                  snapshot.consumerValidation.performedFrom
                    ? ` – ${snapshot.consumerValidation.performedTo}`
                    : ""}
                  ): {snapshot.prospectName} appeared in{" "}
                  <span className="tabular-nums">
                    {snapshot.consumerValidation.mentioned} of{" "}
                    {snapshot.consumerValidation.observations}
                  </span>{" "}
                  answers. Counted separately — these never mix into the
                  numbers above.
                </p>
                <ul className="mt-1.5 text-xs text-muted-foreground">
                  {snapshot.consumerValidation.byProvider.map((p) => (
                    <li key={p.provider} className="tabular-nums">
                      {p.provider}: {p.mentioned}/{p.observations}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {snapshot.adoptionStat && (
              <p className="mt-3 max-w-[65ch] text-xs text-muted-foreground">
                Context: {snapshot.adoptionStat.text}{" "}
                {receiptHref(snapshot.adoptionStat.sourceUrl).href ? (
                  <a
                    href={receiptHref(snapshot.adoptionStat.sourceUrl).href!}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2"
                  >
                    ({snapshot.adoptionStat.sourceLabel}
                    {snapshot.adoptionStat.sourceDate
                      ? `, ${snapshot.adoptionStat.sourceDate}`
                      : ""}
                    )
                  </a>
                ) : (
                  <>
                    ({snapshot.adoptionStat.sourceLabel}
                    {snapshot.adoptionStat.sourceDate
                      ? `, ${snapshot.adoptionStat.sourceDate}`
                      : ""}
                    )
                  </>
                )}
              </p>
            )}
            <p className="mt-3 max-w-[65ch] text-xs text-muted-foreground">
              {snapshot.methodology}
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

          <Drawer summary="Limitations">
            {/* Every caveat the primary flow no longer carries lives here,
                said once (spec 093 discipline, spec 123 round 2 placement). */}
            <p className="max-w-[65ch] text-xs text-muted-foreground">
              Point-in-time sample based on these captured questions and test
              dates — not market share, lead volume, or a permanent AI
              ranking. Everything on this page comes from public records and
              published AI answers — no estimates, no proprietary scores.
            </p>
            <p className="mt-2 max-w-[65ch] text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                How to read this report:
              </span>{" "}
              a point-in-time audit of a defined set of AI answers, designed
              to identify visibility gaps and possible source patterns. It is
              not a judgment of service quality, and it does not predict lead
              flow, prove competitive superiority, or guarantee future AI
              recommendations. Results can vary by prompt wording, model
              version, session, location, available sources, and time.
            </p>
            <p className="mt-2 max-w-[65ch] text-xs text-muted-foreground">
              {snapshot.benchmark.limitations} Answers are content-hashed at
              capture and never edited.
            </p>
          </Drawer>
        </div>
      </section>
    </div>
  );
}
