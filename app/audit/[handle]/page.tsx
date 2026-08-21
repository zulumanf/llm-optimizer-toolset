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
import { getAuditPageByToken } from "@/lib/prospects/service";
import { EngagementBeacon } from "@/components/audit/engagement-beacon";
import { visibilityThreshold } from "@/lib/prospects/constants";
import { formatVerifiedProduction } from "@/lib/prospects/realtrends";
import { getCurrentUserOrNull, isStaff } from "@/lib/auth";
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
  signalSection,
  signalEvidence,
}: {
  summary: string;
  children: React.ReactNode;
  /** Engagement beacon keys (spec 098): opening reports a section view or
   * an evidence expansion. Presentation-neutral data attributes only. */
  signalSection?: string;
  signalEvidence?: string;
}) {
  return (
    <details
      className="group py-4"
      data-signal-section={signalSection}
      data-signal-evidence={signalEvidence}
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
  params: Promise<{ handle: string; linkKey?: string }>;
}) {
  const { handle: token, linkKey } = await params;
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
  // Completeness is claimed only when provable (launch fix 2026-08-14):
  // "every answer" appears solely when the snapshot holds every qualifying
  // capture (transcriptTotal, stamped at publish); a capped appendix states
  // shown-of-total instead. Legacy snapshots lack the total and never claim
  // completeness.
  const transcriptsShown = snapshot.transcripts?.length ?? 0;
  const transcriptTotal = snapshot.transcriptTotal ?? null;
  const transcriptsComplete =
    transcriptsShown > 0 && transcriptTotal === transcriptsShown;
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
      data-signal-cta="walkthrough"
      className="inline-flex w-full items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto"
    >
      Review the captured answers — 15-minute walkthrough
    </a>
  );

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <EngagementBeacon viewId={viewId} />
      {/* ============================================= the first screen */}
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Private AI visibility report · {snapshot.marketName} · for {snapshot.prospectName}
        {snapshot.preparedBy && ` · ${snapshot.preparedBy.date}`}
      </p>
      {heroVariant === "rival" && dominantRival && stakes ? (
        // A named rival owns the answers: more urgent than open space, and
        // never insult-first toward a high performer (PR B amendment 2).
        <h1
          className={`${serif.className} mt-3 max-w-[32ch] text-balance text-2xl font-medium tracking-tight`}
        >
          In this {snapshot.benchmark.responseCount}-answer sample,{" "}
          {dominantRival.name} was explicitly recommended in{" "}
          {recsOf(dominantRival)} answers.
          <br />
          You were recommended in{" "}
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
      {/* The ONE above-the-fold caveat (spec 093): a compact scope line said
          before any number is argued with. Everything else it used to carry
          lives in "How this was measured" — a reader qualified at every turn
          stops reading, so caveats appear exactly twice on this page. */}
      <p className="mt-2 max-w-[65ch] text-xs text-muted-foreground">
        Point-in-time sample based on these captured prompts and test dates —
        not market share, lead volume, or a permanent AI ranking.
        {transcriptsShown > 0 && (
          <>
            {" "}
            <Link
              href={`/audit/${token}/answers`}
              className="underline underline-offset-2 transition-colors hover:text-foreground"
            >
              View the {transcriptsComplete ? "complete " : ""}captured-answer
              set and search every mention.
            </Link>
          </>
        )}
      </p>
      <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">
        We put {snapshot.benchmark.promptCount} real {snapshot.marketName}{" "}
        buyer and seller questions to{" "}
        {testedSystemPhrase(snapshot.benchmark.providers, snapshot.collection)},
        each asked {repsLabel};{" "}
        {transcriptsComplete
          ? "every answer is published below."
          : transcriptsShown > 0 && transcriptTotal !== null
            ? `${transcriptsShown} of the ${transcriptTotal} captured answers are published below.`
            : transcriptsShown > 0
              ? "captured answers are published below."
              : "every answer was captured word-for-word."}
      </p>
      {/* Provenance up front (PR B, P5d): the trust claim before any number. */}
      <p className="mt-2 max-w-[65ch] text-xs text-muted-foreground">
        Everything on this page comes from public records and published AI
        answers — no estimates, no proprietary scores.
      </p>

      {stakes ? (
        <section className="mt-10">
          {/* Honest units (Team Moza review rounds 1+2): the count is
              EXPLICIT recommendations only (m.recommended in the stakes
              query — never bare name-drops), spanning teams, agents, and
              brokerage brands, and must never read as 189 answers. The unit
              and the "why more than 64" note sit AT the number. */}
          <p className="text-2xl font-semibold tracking-tight">
            <span className="tabular-nums">{stakes.recommendationMomentsTotal}</span>{" "}
            <span className="font-normal text-muted-foreground">
              explicit recommendations — of a team, agent, or brokerage —
              across the {snapshot.benchmark.responseCount} answers.
            </span>
          </p>
          <p className="mt-1 text-2xl font-semibold tracking-tight">
            <span className="tabular-nums text-destructive">
              {stakes.yourRecommendations}
            </span>{" "}
            <span className="font-normal text-muted-foreground">
              {stakes.yourRecommendations === 1 ? "was" : "were"} you.
            </span>
          </p>
          <p className="mt-2 max-w-[65ch] text-xs text-muted-foreground">
            {MENTIONS_VS_ANSWERS_NOTE}
          </p>
          {stakes.competitorsNamed.length > 0 && (
            // "Buyers heard instead" implied real buyers were being diverted
            // (round 2) — this is what the sample actually shows, and the
            // list is ordered by recommendation count, so "most frequently
            // recommended" is the counted truth.
            <p className="mt-3 text-sm text-muted-foreground">
              Most frequently recommended alternatives in this sample:{" "}
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
        <div className="mt-8 max-w-[65ch] rounded-md border border-foreground/25 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Market rank vs AI recommendations
          </p>
          <p className="mt-1.5 text-sm">
            In {snapshot.benchmark.responseCount} answers, the #
            {rankCallout.bestRank}-ranked team was recommended in{" "}
            {rankCallout.bestRecs}, the #{rankCallout.topRank}-ranked in{" "}
            {rankCallout.topRecs}
            {prospectRank != null && stakes
              ? ` — and you (#${prospectRank}) in ${stakes.yourRecommendations}`
              : ""}
            .
          </p>
          {/* "Proportionally" implied a mathematical relationship the data
              doesn't establish (round 2) — say only what the sample shows. */}
          <p className="mt-1.5 text-sm font-medium">
            In this sample, reported market rank did not correspond with AI
            recommendation frequency.
          </p>
        </div>
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

      {/* A share link the assistant's site no longer serves is dropped from
          the demo line rather than rendered dead (link health, 2026-08-19). */}
      {snapshot.exampleChats &&
        snapshot.exampleChats.filter((c) => receiptHref(c.url).href).length > 0 && (
        <p className="mt-6 max-w-[65ch] text-sm">
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

      <div className="mt-6">
        {ctaButton ?? (
          <p className="max-w-[65ch] text-sm">
            Reply to the email that brought you here — you&apos;ll get the
            15-minute walkthrough.
          </p>
        )}
        <p className="mt-2 max-w-[65ch] text-xs text-muted-foreground">
          I&apos;ll walk you through the captured responses, the methodology,
          likely visibility gaps, and practical next steps. No obligation.
        </p>
      </div>

      {/* Below the fold: the record-vs-visibility contrast in FACTS.
          Independently verified production (RealTrends) leads when present —
          rank ONLY ever renders with its exact scope; otherwise the legacy
          sourced-record line. */}
      {snapshot.verifiedProduction ? (
        <p className="mt-10 max-w-[65ch] text-sm">
          <span className="font-medium">Verified market performance:</span>{" "}
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
              (source retrieved {snapshot.verifiedProduction.retrievedOn}; the
              original page has since moved — the citation is preserved and
              available on request)
            </span>
          )}
          . <span className="font-medium">AI recommendation visibility:</span>{" "}
          <span className="tabular-nums text-destructive">
            {stakes?.yourRecommendations ?? 0} of {snapshot.benchmark.responseCount}
          </span>{" "}
          answers. <span className="font-medium">The good news:</span> the record
          isn&apos;t the problem — its visibility is, and that part is workable.
        </p>
      ) : (
        stakes &&
        (stakes.volumeUsd != null || prospectRank != null) && (
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
        )
      )}

      {/* Business significance folds behind a click (spec 093): a dollar
          calculation in the first viewport shifts the tone from evidence-led
          to sales arithmetic. Full illustrative-estimate disclaimer intact
          inside — an illustrative estimate, never a verified claim. */}
      {stakes?.avgDealUsd != null && snapshot.commissionEstimate && (
        <div className="mt-2 max-w-[65ch]">
          <Drawer summary="Why this could matter financially — an illustrative calculation">
            {/* Statement first, arithmetic shown as arithmetic (round 2):
                the reader can check the multiplication themselves. */}
            <p className="max-w-[65ch] text-xs text-muted-foreground">
              At {snapshot.prospectName}&apos;s reported average closed volume
              per side ({stakes.avgDealBasis}), one additional transaction
              could be commercially meaningful. Illustration only — an
              illustrative estimate, not a measurement: ≈ $
              {Math.round(stakes.avgDealUsd / 1000).toLocaleString()}K average
              volume × an assumed {snapshot.commissionEstimate.ratePct}%
              commission ≈ $
              {snapshot.commissionEstimate.amountUsd.toLocaleString()} gross
              commission. This is not a forecast of referrals, commissions, or
              revenue from AI visibility; the sourced record reports
              production volume, not commission income.
            </p>
          </Drawer>
        </div>
      )}

      {/* ================================================== the receipt */}
      {snapshot.comparison.length > 0 && (
        <section className="mt-14" data-signal-section="competitors">
          <h2 className="text-lg font-medium">
            Teams and brands named in {snapshot.benchmark.responseCount}{" "}
            captured AI answers
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Who shows up when {snapshot.marketName} buyers and sellers ask.
          </p>
          {/* The recipe in two sentences AT the figures it explains (spec
              093 tightening of spec 048's list): the full method and
              limitations stay in "How this was measured" below. */}
          <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">
            We asked each of the {snapshot.benchmark.promptCount} questions{" "}
            {repsLabel} and counted the pattern across all{" "}
            {snapshot.benchmark.responseCount} answers — never one lucky
            reply. The table is those counts, nothing estimated.
          </p>
          <p className="mt-3 max-w-[65ch] text-xs text-muted-foreground">
            <span className="text-foreground">Brought up</span> = named at all.{" "}
            <span className="text-foreground">Recommended</span> = the answer
            expressly suggested hiring or using the team or agent. One answer
            can name several, so counts overlap. The set is every entity the
            answers named — individual agents, teams, and brokerage brands
            together — not a curated peer group.
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
                read{" "}
                {transcriptsComplete
                  ? `all ${transcriptsShown}`
                  : transcriptTotal !== null
                    ? `${transcriptsShown} of the ${transcriptTotal}`
                    : `${transcriptsShown}`}{" "}
                answers verbatim
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
            Why these answers may be missing {snapshot.prospectName}
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
                {/* Measured fact vs our reading of it, kept visibly apart
                    (spec 086) — the reader can accept the count and argue
                    with the interpretation. Older snapshots carry no
                    observations and render as before. */}
                {why.observations && why.observations.length > 0 ? (
                  <>
                    {why.observations.map((obs, j) => (
                      <p key={j} className="mt-0.5 text-sm">
                        <span className="font-medium">Counted:</span>{" "}
                        <span className="text-muted-foreground">{obs}</span>
                      </p>
                    ))}
                    <p className="mt-0.5 text-sm">
                      <span className="font-medium">Our read:</span>{" "}
                      <span className="text-muted-foreground">
                        {why.explanation}
                      </span>
                    </p>
                  </>
                ) : (
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {why.explanation}
                  </p>
                )}
                <p className="mt-1.5 text-sm">
                  <span className="font-medium">The fix:</span> {why.suggestedAction}
                </p>
              </li>
            ))}
          </ul>
          {snapshot.topSources && snapshot.topSources.length > 0 && (
            <div className="mt-3 max-w-[65ch] text-xs text-muted-foreground">
              <p>
                Sources the captured answers cited most:{" "}
                {snapshot.topSources
                  .map(
                    (s) =>
                      `${s.domain} (${s.citations}×${
                        s.category === "competitor" ? ", competitor-owned" : ""
                      })`
                  )
                  .join(", ")}
                .
              </p>
              {/* ONE causality sentence (spec 093) — the stacked disclaimers
                  it replaces made the page sound uncertain of its own data. */}
              <p className="mt-1.5">
                Citation frequency does not establish that any one source
                caused a recommendation — the list identifies the public
                information environment the models surfaced.
              </p>
            </div>
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
              Any single answer varies — that&apos;s
              why we report rates over {snapshot.benchmark.responseCount} captured
              answers, not one reply. The pattern is the finding.
            </p>
          </Drawer>
        )}

        {gap && gap.signals.length > 0 && (
          <Drawer summary="Your track record — the part AI is missing" signalSection="authority">
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

        <Drawer summary="How this was measured" signalSection="methodology">
          <p className="mb-3 max-w-[65ch] text-sm">
            In plain terms: we asked the same questions many times, saved every
            answer untouched, and counted the names. The details below are for
            the technically minded — the counting recipe above is the whole
            method.
          </p>
          {/* Compact disclosure (compliance pass 2026-08-19), every figure
              derived from the snapshot — dates, counts, and the tested
              system are never hardcoded. */}
          <p className="mb-3 max-w-[65ch] text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Methodology:</span>{" "}
            we ran {snapshot.benchmark.promptCount} {snapshot.marketName} buyer
            and seller prompts, each {repsLabel}, through{" "}
            {testedSystemPhrase(snapshot.benchmark.providers, snapshot.collection)}{" "}
            between {from}{to ? ` and ${to}` : ""}, producing{" "}
            {snapshot.benchmark.responseCount} captured answers.
            &ldquo;Recommended&rdquo; means the answer expressly suggested
            hiring or using a named team or agent. Results can vary by prompt
            wording, model version, session, location, available sources, and
            time.
            {transcriptsShown > 0 &&
              " Exact model identifiers are shown with each captured answer in the appendix."}
          </p>
          {/* The reading rules that used to repeat across the page (spec 093)
              live here now, said once. */}
          <p className="mb-3 max-w-[65ch] text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              How to read this report:
            </span>{" "}
            a point-in-time audit of a defined set of AI answers, designed to
            identify visibility gaps and possible source patterns. It is not a
            judgment of service quality, and it does not predict lead flow,
            prove competitive superiority, or guarantee future AI
            recommendations.
          </p>
          {snapshot.adoptionStat && (
            <p className="mb-3 max-w-[65ch] text-xs text-muted-foreground">
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
                {snapshot.benchmark.responseCount}
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
                Separately from the systematic measurement above, we asked the
                same questions by hand in fresh sessions of the consumer apps
                ({snapshot.consumerValidation.performedFrom}
                {snapshot.consumerValidation.performedTo !==
                snapshot.consumerValidation.performedFrom
                  ? ` – ${snapshot.consumerValidation.performedTo}`
                  : ""}
                ): {snapshot.prospectName} appeared in{" "}
                <span className="tabular-nums">
                  {snapshot.consumerValidation.mentioned} of{" "}
                  {snapshot.consumerValidation.observations}
                </span>{" "}
                answers. Counted separately — these never mix into the numbers
                above.
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
          The clearest opportunity: make {snapshot.prospectName}&apos;s
          credentials consistently visible across the credible public sources
          that appeared in these answers.
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
