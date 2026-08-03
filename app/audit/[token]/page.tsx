/**
 * Public prospect audit page (spec 032/045). The platform's only anonymous
 * content surface: resolves a high-entropy token to a published snapshot and
 * renders nothing else. No auth call, no live internal queries — internal
 * notes cannot leak because they were never put in the snapshot. Wrong,
 * revoked, and expired tokens are indistinguishable (all 404).
 *
 * Built for a cold-email reader with a five-second attention budget:
 * the first screen is the entire punch (how many times AI recommended a
 * team, how many were you, who got named instead); everything below the
 * table is progressive disclosure (<details>) for the second read.
 */
import type { Metadata } from "next";
import Link from "next/link";
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
  const stakes = snapshot.stakes;
  const firstExcerpt = snapshot.evidenceExcerpts?.[0];
  // A real seller-side moment from the captured answers: the question a
  // listing client would ask, and who the assistant sent them to.
  const sellerMoment = snapshot.promptEvidence.find(
    (e) => /sell/i.test(e.promptText) && e.recommendedNames.length > 0
  );

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      {/* ============================================= the first screen */}
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Private AI visibility report · {snapshot.marketName} · for {snapshot.prospectName}
        {snapshot.preparedBy && ` · ${snapshot.preparedBy.date}`}
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{snapshot.headline}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Your next seller may never ask a friend for a name — a growing share ask
        ChatGPT first. We captured what it tells them: {snapshot.benchmark.promptCount}{" "}
        real buyer and seller questions, asked repeatedly,{" "}
        {snapshot.benchmark.responseCount} answers recorded verbatim.
      </p>

      {stakes ? (
        <section className="mt-6 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border p-4">
            <p className="text-2xl font-semibold tabular-nums">
              {stakes.recommendationMomentsTotal}×
            </p>
            <p className="mt-1 text-sm">AI recommended a specific team</p>
          </div>
          <div className="rounded-lg border border-foreground/30 bg-muted/40 p-4">
            <p className="text-2xl font-semibold tabular-nums">
              {stakes.yourRecommendations}×
            </p>
            <p className="mt-1 text-sm font-medium">it was you</p>
          </div>
          <div className="rounded-lg border p-4">
            <p className="text-sm font-medium leading-snug">
              {stakes.competitorsNamed.slice(0, 4).join(" · ")}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              are who buyers heard instead
            </p>
          </div>
        </section>
      ) : (
        gap && (
          <section className="mt-6 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border p-4">
              <p className="text-2xl font-semibold tabular-nums">
                {Math.round(gap.authorityScore)}
              </p>
              <p className="mt-1 text-sm">your standing in the market</p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-2xl font-semibold tabular-nums">
                {Math.round(gap.visibilityScore)}
              </p>
              <p className="mt-1 text-sm">your visibility in AI answers</p>
            </div>
            <div className="rounded-lg border border-foreground/30 bg-muted/40 p-4">
              <p className="text-2xl font-semibold tabular-nums">{Math.round(gap.gap)}</p>
              <p className="mt-1 text-sm font-medium">the gap</p>
            </div>
          </section>
        )
      )}

      {stakes && (
        <p className="mt-3 text-sm">
          Think of AI as the market&apos;s newest referral source — one that made{" "}
          {stakes.recommendationMomentsTotal} referrals in our sample and never once
          referred you. Each one is a conversation that starts with another team
          before you know the client exists.
        </p>
      )}

      {sellerMoment && (
        <p className="mt-3 rounded-md border-l-4 border-foreground/20 bg-muted/30 p-3 text-sm">
          One that should sting: we asked{" "}
          <span className="font-medium">“{sellerMoment.promptText}”</span> — a listing
          client&apos;s question. The answer sent them to{" "}
          <span className="font-medium">{sellerMoment.recommendedNames[0]}</span>.
          That&apos;s a listing appointment forming, and your name never came up.
        </p>
      )}

      {stakes?.avgDealUsd != null && (
        <p className="mt-3 text-sm text-muted-foreground">
          At your average sale of roughly{" "}
          <span className="font-semibold text-foreground tabular-nums">
            ${Math.round(stakes.avgDealUsd / 1000).toLocaleString()}K
          </span>{" "}
          ({stakes.avgDealBasis}), even one of those introductions is worth more than
          the 15 minutes this takes to fix a plan for.
        </p>
      )}

      <p className="mt-4 rounded-md border bg-muted/40 px-4 py-2.5 text-sm">
        <span className="font-medium">
          Reply “show me” to the email that brought you here.
        </span>{" "}
        You&apos;ll get a 15-minute walkthrough: the exact sources AI reads for{" "}
        {snapshot.marketName}, and what it takes to become the name in the answer.
      </p>

      {/* ================================================== the receipt */}
      {snapshot.comparison.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-medium">Who shows up when buyers ask</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Team</th>
                  <th className="py-2 pr-4 text-right font-medium">Brought up</th>
                  <th className="py-2 pr-4 text-right font-medium">Recommended</th>
                  <th className="py-2 text-right font-medium">Answers</th>
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
          {snapshot.transcripts && snapshot.transcripts.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Don&apos;t take the table&apos;s word for it —{" "}
              <Link href={`/audit/${token}/answers`} className="underline">
                read all {snapshot.transcripts.length} answers, complete and verbatim
              </Link>
              , and search them for any name, including your own.
            </p>
          )}
        </section>
      )}

      {firstExcerpt && (
        <blockquote className="mt-6 rounded-md border-l-4 border-foreground/20 bg-muted/30 p-4 text-sm">
          <p className="italic">“{firstExcerpt.quote}”</p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            — the assistant, recommending {firstExcerpt.teamName} ·{" "}
            {new Date(firstExcerpt.capturedAt).toLocaleDateString()}
          </p>
        </blockquote>
      )}

      {snapshot.exampleChats && snapshot.exampleChats.length > 0 && (
        <p className="mt-4 text-sm">
          <span className="font-medium">See it live:</span>{" "}
          {snapshot.exampleChats.map((chat, i) => (
            <span key={i}>
              {i > 0 && " · "}
              <a href={chat.url} target="_blank" rel="noreferrer" className="underline">
                a real {chat.assistant === "chatgpt" ? "ChatGPT" : "Perplexity"}{" "}
                conversation from {chat.capturedOn}
              </a>
            </span>
          ))}{" "}
          — hosted on the assistant&apos;s own site, not ours.
        </p>
      )}

      {/* ====================================== the second read (folded) */}
      <div className="mt-10 space-y-3">
        {snapshot.whyItHappens && snapshot.whyItHappens.length > 0 && (
          <details className="rounded-lg border p-4">
            <summary className="cursor-pointer text-sm font-medium">
              Why this is happening — and what fixes it
            </summary>
            <ul className="mt-3 space-y-4">
              {snapshot.whyItHappens.map((why, i) => (
                <li key={i}>
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
              <p className="mt-3 text-xs text-muted-foreground">
                Where the answers pulled from:{" "}
                {snapshot.topSources
                  .map((s) => `${s.domain} (${s.citations}×)`)
                  .join(", ")}{" "}
                — presence on these surfaces is how the answer changes.
              </p>
            )}
          </details>
        )}

        <details className="rounded-lg border p-4">
          <summary className="cursor-pointer text-sm font-medium">
            What we found, in one paragraph
          </summary>
          <p className="mt-2 text-sm font-medium">{snapshot.keyFinding.title}</p>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {snapshot.keyFinding.explanation}
          </p>
        </details>

        {snapshot.promptEvidence.length > 0 && (
          <details className="rounded-lg border p-4">
            <summary className="cursor-pointer text-sm font-medium">
              The questions we asked — and who was named
            </summary>
            <ul className="mt-3 space-y-3">
              {snapshot.promptEvidence.map((e) => (
                <li key={e.responseId} className="text-sm">
                  <p className="font-medium">“{e.promptText}”</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {e.recommendedNames.length > 0
                      ? `Recommended: ${e.recommendedNames.join(", ")}`
                      : "No specific team recommended in this answer"}
                  </p>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              Try one yourself in ChatGPT right now. Any single answer varies — that&apos;s
              why we report rates over {snapshot.benchmark.responseCount} captured
              answers, not one reply. The pattern is the finding.
            </p>
          </details>
        )}

        {gap && gap.signals.length > 0 && (
          <details className="rounded-lg border p-4">
            <summary className="cursor-pointer text-sm font-medium">
              Your track record — the part AI is missing
            </summary>
            <ul className="mt-3 space-y-1.5 text-sm">
              {gap.signals.map((s, i) => (
                <li key={i}>
                  {s.label}{" "}
                  <span className="text-xs text-muted-foreground">
                    {s.sourceUrl ? (
                      <a
                        href={s.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
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
          </details>
        )}

        <details className="rounded-lg border p-4">
          <summary className="cursor-pointer text-sm font-medium">
            How this was measured
          </summary>
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
              <dd className="mt-1 font-medium">
                {snapshot.benchmark.providers.join(", ")}
              </dd>
            </div>
            <div className="rounded-md border p-3">
              <dt className="text-xs text-muted-foreground">Questions</dt>
              <dd className="mt-1 font-medium tabular-nums">
                {snapshot.benchmark.promptCount}
              </dd>
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
            {snapshot.benchmark.limitations} Answers are content-hashed at capture and
            never edited.
          </p>
          {snapshot.evidenceExcerpts && snapshot.evidenceExcerpts.length > 1 && (
            <ul className="mt-3 space-y-2">
              {snapshot.evidenceExcerpts.slice(1).map((e, i) => (
                <li key={i} className="rounded-md bg-muted/30 p-3 text-sm">
                  <p className="italic">“{e.quote}”</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    recommending {e.teamName} ·{" "}
                    {new Date(e.capturedAt).toLocaleDateString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </details>
      </div>

      {/* ========================================================= CTA */}
      <section className="mt-10 rounded-lg border bg-muted/40 p-5 text-center">
        <p className="font-medium">
          The answers change slowly — whoever fixes this first becomes the default
          recommendation, and compounding does the rest.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Reply “show me” to the email that brought you here. Every number on this page
          traces to a captured answer we can show you — skepticism welcome.
        </p>
        {snapshot.preparedBy && (
          <p className="mt-2 text-xs text-muted-foreground">
            Prepared by {snapshot.preparedBy.name} · {snapshot.preparedBy.date} · report{" "}
            {snapshot.preparedBy.reportId}
          </p>
        )}
      </section>
    </div>
  );
}
