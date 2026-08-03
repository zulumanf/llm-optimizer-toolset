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
function RateBar({ value, isSubject }: { value: number | null; isSubject: boolean }) {
  if (value === null) {
    return <span className="text-xs text-muted-foreground">not measured</span>;
  }
  const pct = Math.round(value * 100);
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
        className={`w-9 text-right tabular-nums ${isSubject ? "text-destructive" : ""}`}
      >
        {pct}%
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
  const firstExcerpt = snapshot.evidenceExcerpts?.[0];
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
      Reply “show me” — get the 15-minute walkthrough
    </a>
  );

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      {/* ============================================= the first screen */}
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Private AI visibility report · {snapshot.marketName} · for {snapshot.prospectName}
        {snapshot.preparedBy && ` · ${snapshot.preparedBy.date}`}
      </p>
      <h1
        className={`${serif.className} mt-3 max-w-[24ch] text-balance text-2xl font-medium tracking-tight`}
      >
        {snapshot.headline}
      </h1>
      <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">
        Buyers and sellers increasingly ask ChatGPT who to hire. We asked it{" "}
        {snapshot.benchmark.promptCount} real questions about {snapshot.marketName}{" "}
        — {snapshot.benchmark.responseCount} answers, captured verbatim.
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
      ) : (
        gap && (
          <section className="mt-10">
            <p className="text-2xl font-semibold tracking-tight">
              <span className="tabular-nums">{Math.round(gap.authorityScore)}</span>{" "}
              <span className="font-normal text-muted-foreground">
                your standing in the market,
              </span>{" "}
              <span className="tabular-nums text-destructive">
                {Math.round(gap.visibilityScore)}
              </span>{" "}
              <span className="font-normal text-muted-foreground">
                your visibility in AI answers.
              </span>
            </p>
          </section>
        )
      )}

      {sellerMoment && (
        <p className="mt-4 max-w-[65ch] border-l-2 border-primary/60 pl-4 text-sm">
          One that should sting: we asked{" "}
          <span className={`${serif.className} italic`}>
            “{sellerMoment.promptText}”
          </span>{" "}
          — a listing client&apos;s question. The answer sent them to{" "}
          <span className="font-medium">{sellerMoment.recommendedNames[0]}</span>.
          That&apos;s a listing appointment forming, and your name never came up.
        </p>
      )}

      {stakes?.avgDealUsd != null && (
        <p className="mt-4 max-w-[65ch] text-sm text-muted-foreground">
          Your average sale:{" "}
          <span className="font-semibold text-foreground tabular-nums">
            ~${Math.round(stakes.avgDealUsd / 1000).toLocaleString()}K
          </span>{" "}
          ({stakes.avgDealBasis}). One introduction going elsewhere outweighs the 15
          minutes this takes to plan.
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
          15 minutes, no deck, no obligation: the exact sources AI reads for{" "}
          {snapshot.marketName}, and what it takes to become the name in the answer.
        </p>
      </div>

      {/* ================================================== the receipt */}
      {snapshot.comparison.length > 0 && (
        <section className="mt-14">
          <h2 className="text-lg font-medium">Who shows up when buyers ask</h2>
          {(() => {
            const hasRanks = snapshot.comparison.some((r) => r.marketRank != null);
            return (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
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
                        <td className="py-2 pr-4">
                          {row.name}
                          {row.isProspect ? " ← you" : ""}
                        </td>
                        {hasRanks && (
                          <td className="py-2 pr-4 text-right tabular-nums">
                            {row.marketRank != null ? `#${row.marketRank}` : "—"}
                          </td>
                        )}
                        <td className="py-2 pr-4 text-right">
                          <RateBar value={row.mentionRate} isSubject={row.isProspect} />
                        </td>
                        <td className="py-2 pr-4 text-right">
                          <RateBar
                            value={row.recommendationRate}
                            isSubject={row.isProspect}
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
                          <RateBar value={b.mentionRate} isSubject={false} />
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
          <p className={`${serif.className} text-lg italic leading-snug`}>
            “{firstExcerpt.quote}”
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

      {/* ====================================== the second read (folded) */}
      <div className="mt-14 divide-y border-y">
        {snapshot.whyItHappens && snapshot.whyItHappens.length > 0 && (
          <Drawer summary="Why this is happening — and what fixes it">
            <ul className="space-y-4">
              {snapshot.whyItHappens.map((why, i) => (
                <li key={i} className="max-w-[65ch]">
                  <p className="text-sm font-medium">{why.title}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {why.explanation}
                  </p>
                  <p className="mt-1 text-sm">
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
          </Drawer>
        )}

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
                  <p className={`${serif.className} italic`}>“{e.quote}”</p>
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
        <p className={`${serif.className} max-w-[40ch] text-balance text-lg`}>
          The answers change slowly — whoever fixes this first becomes the default
          recommendation, and compounding does the rest.
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
