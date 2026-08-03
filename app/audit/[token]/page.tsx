/**
 * Public prospect audit page (spec 032). The platform's only anonymous
 * content surface: resolves a high-entropy token to a published snapshot and
 * renders nothing else. No auth call, no live internal queries — internal
 * notes cannot leak because they were never put in the snapshot. Wrong,
 * revoked, and expired tokens are indistinguishable (all 404).
 *
 * This page is read by a PROSPECTIVE CLIENT: plain words, the punchline
 * first, every number traceable to the captured answers behind it.
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getAuditByToken } from "@/lib/prospects/service";

export const metadata: Metadata = {
  title: "AI Visibility Benchmark",
  robots: { index: false, follow: false },
};

const rate = (v: number | null): string =>
  v === null ? "not measured" : `${Math.round(v * 100)}%`;

export default async function ProspectAuditPage({
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
  if (!snapshot) notFound();

  const from = new Date(snapshot.benchmark.dateRange.from).toLocaleDateString();
  const to = snapshot.benchmark.dateRange.to
    ? new Date(snapshot.benchmark.dateRange.to).toLocaleDateString()
    : null;
  const gap = snapshot.authorityGap;

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      {/* ---------------------------------------------------------- hero */}
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Private AI visibility report · {snapshot.marketName} · prepared for{" "}
        {snapshot.prospectName}
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{snapshot.headline}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Buyers and sellers now ask ChatGPT and other AI assistants who to hire. We
        measured what those assistants say about {snapshot.marketName} — this page is
        what they say about you. It&apos;s private to you and not indexed by search engines.
      </p>

      {gap && (
        <section className="mt-8 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border p-4">
            <p className="text-xs text-muted-foreground">Your standing in the market</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {Math.round(gap.authorityScore)}
              <span className="text-sm font-normal text-muted-foreground"> / 100</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              from verified rankings, sales volume, and reviews — sources listed below
            </p>
          </div>
          <div className="rounded-lg border p-4">
            <p className="text-xs text-muted-foreground">Your visibility in AI answers</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {Math.round(gap.visibilityScore)}
              <span className="text-sm font-normal text-muted-foreground"> / 100</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              measured across {gap.organicResponses} real AI answers to buyer and seller
              questions
            </p>
          </div>
          <div className="rounded-lg border border-foreground/20 bg-muted/40 p-4">
            <p className="text-xs text-muted-foreground">The gap</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {Math.round(gap.gap)}
              <span className="text-sm font-normal text-muted-foreground"> points</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              the distance between how good you are and how often AI says so
            </p>
          </div>
        </section>
      )}

      {/* ------------------------------------------------------- stakes */}
      {snapshot.stakes && (
        <section className="mt-8 rounded-lg border p-5">
          <h2 className="text-lg font-medium">Why this matters to your pipeline</h2>
          <p className="mt-2 text-sm">
            Across the answers we captured, assistants pointed buyers and sellers at a
            specific team{" "}
            <span className="font-semibold tabular-nums">
              {snapshot.stakes.recommendationMomentsTotal} times
            </span>
            . You were the team{" "}
            <span className="font-semibold tabular-nums">
              {snapshot.stakes.yourRecommendations}
            </span>{" "}
            of those times.
            {snapshot.stakes.competitorsNamed.length > 0 && (
              <>
                {" "}
                The names buyers heard instead:{" "}
                <span className="font-medium">
                  {snapshot.stakes.competitorsNamed.join(", ")}
                </span>
                .
              </>
            )}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Every one of those moments is an introduction — a conversation that starts
            with someone else before you know the client exists.
          </p>
          {snapshot.stakes.avgDealUsd !== null && (
            <p className="mt-3 rounded-md bg-muted/40 p-3 text-sm">
              By your own published numbers ({snapshot.stakes.avgDealBasis}), your
              average sale is roughly{" "}
              <span className="font-semibold tabular-nums">
                ${Math.round(snapshot.stakes.avgDealUsd / 1000).toLocaleString()}K
              </span>
              . At that size, it doesn&apos;t take many AI-referred introductions going
              to another team before the gap on this page is worth closing.
            </p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Counted fairly: recommendations given on a question that asked about a team
            by name don&apos;t count for that team — only unprompted ones do. These
            answers also cite their sources (listed below); teams established on those
            surfaces keep getting named, which is why this tends to widen quietly
            rather than fix itself.
          </p>
        </section>
      )}

      {/* --------------------------------------------------- key finding */}
      <section className="mt-8 rounded-lg border p-5">
        <h2 className="text-lg font-medium">What we found</h2>
        <p className="mt-2 font-medium">{snapshot.keyFinding.title}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {snapshot.keyFinding.explanation}
        </p>
      </section>

      {/* ---------------------------------------------------- comparison */}
      {snapshot.comparison.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-medium">Who shows up when buyers ask</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Across every captured answer: how often each team was brought up, and how
            often the assistant actively recommended them.
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Team</th>
                  <th className="py-2 pr-4 text-right font-medium">Brought up</th>
                  <th className="py-2 pr-4 text-right font-medium">Recommended</th>
                  <th className="py-2 text-right font-medium">Answers analyzed</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.comparison.map((row) => (
                  <tr
                    key={row.name}
                    className={`border-b last:border-0 ${
                      row.isProspect ? "bg-muted/40 font-semibold" : ""
                    }`}
                  >
                    <td className="py-2 pr-4">
                      {row.name}
                      {row.isProspect ? " ← you" : ""}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {rate(row.mentionRate)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {rate(row.recommendationRate)}
                    </td>
                    <td className="py-2 text-right tabular-nums">{row.sampleSize}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ----------------------------------------------- what was asked */}
      {snapshot.promptEvidence.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-medium">The questions we asked</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Real questions a buyer or seller would type, asked repeatedly. Here&apos;s who
            the assistants named.
          </p>
          <ul className="mt-3 space-y-3">
            {snapshot.promptEvidence.map((e) => (
              <li key={e.responseId} className="rounded-md border p-4 text-sm">
                <p className="font-medium">“{e.promptText}”</p>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {e.recommendedNames.length > 0
                    ? `The assistant recommended: ${e.recommendedNames.join(", ")}`
                    : "The assistant recommended no specific team in this answer"}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* -------------------------------------------------- why + sources */}
      {snapshot.whyItHappens && snapshot.whyItHappens.length > 0 && (
        <section className="mt-8 rounded-lg border p-5">
          <h2 className="text-lg font-medium">Why this is happening</h2>
          <ul className="mt-3 space-y-4">
            {snapshot.whyItHappens.map((why, i) => (
              <li key={i}>
                <p className="text-sm font-medium">{why.title}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{why.explanation}</p>
                <p className="mt-1 text-sm">
                  <span className="font-medium">The fix:</span> {why.suggestedAction}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {snapshot.topSources && snapshot.topSources.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-medium">Where AI gets its answers</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The assistants cited these places while answering. Being present and strong
            on these surfaces is how the answer changes.
          </p>
          <ul className="mt-3 flex flex-wrap gap-2 text-sm">
            {snapshot.topSources.map((s) => (
              <li key={s.domain} className="rounded-md border px-3 py-1.5">
                {s.domain}{" "}
                <span className="text-xs text-muted-foreground">cited {s.citations}×</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ---------------------------------------------- your track record */}
      {gap && gap.signals.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-medium">Your track record — the part AI is missing</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            What the market already knows about you, with sources:
          </p>
          <ul className="mt-3 space-y-1.5 text-sm">
            {gap.signals.map((s, i) => (
              <li key={i}>
                {s.label}{" "}
                <span className="text-xs text-muted-foreground">
                  {s.sourceUrl ? (
                    <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="underline">
                      source
                    </a>
                  ) : (
                    s.provenance.replaceAll("_", " ")
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ------------------------------------------------- how we did it */}
      <section className="mt-8">
        <h2 className="text-lg font-medium">How this was measured</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div className="rounded-md border p-3">
            <dt className="text-xs text-muted-foreground">When</dt>
            <dd className="mt-1 font-medium tabular-nums">
              {from}
              {to ? ` – ${to}` : ""}
            </dd>
          </div>
          <div className="rounded-md border p-3">
            <dt className="text-xs text-muted-foreground">AI assistants</dt>
            <dd className="mt-1 font-medium">{snapshot.benchmark.providers.join(", ")}</dd>
          </div>
          <div className="rounded-md border p-3">
            <dt className="text-xs text-muted-foreground">Questions asked</dt>
            <dd className="mt-1 font-medium tabular-nums">{snapshot.benchmark.promptCount}</dd>
          </div>
          <div className="rounded-md border p-3">
            <dt className="text-xs text-muted-foreground">Answers captured</dt>
            <dd className="mt-1 font-medium tabular-nums">
              {snapshot.benchmark.responseCount}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">{snapshot.methodology}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          {snapshot.benchmark.limitations}
        </p>
      </section>

      {/* -------------------------------------------------------- CTA */}
      <section className="mt-10 rounded-lg border bg-muted/40 p-5 text-center">
        <p className="font-medium">{snapshot.cta}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Reply to the email that brought you here and we&apos;ll walk through the full data
          together — every number on this page traces to a captured answer we can show
          you.
        </p>
      </section>
    </div>
  );
}
