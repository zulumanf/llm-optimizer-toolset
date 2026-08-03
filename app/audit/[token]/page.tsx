/**
 * Public prospect audit page (spec 032). The platform's only anonymous
 * content surface: resolves a high-entropy token to a published snapshot and
 * renders nothing else. No auth call, no live internal queries — internal
 * notes cannot leak because they were never put in the snapshot. Wrong,
 * revoked, and expired tokens are indistinguishable (all 404).
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

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Private AI visibility benchmark · {snapshot.marketName}
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{snapshot.headline}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Prepared for {snapshot.prospectName}. This page is private to you and is not indexed.
      </p>

      <section className="mt-8">
        <h2 className="text-lg font-medium">Benchmark overview</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div className="rounded-md border p-3">
            <dt className="text-xs text-muted-foreground">Window</dt>
            <dd className="mt-1 font-medium tabular-nums">
              {from}
              {to ? ` – ${to}` : ""}
            </dd>
          </div>
          <div className="rounded-md border p-3">
            <dt className="text-xs text-muted-foreground">AI engines</dt>
            <dd className="mt-1 font-medium">{snapshot.benchmark.providers.join(", ")}</dd>
          </div>
          <div className="rounded-md border p-3">
            <dt className="text-xs text-muted-foreground">Prompts</dt>
            <dd className="mt-1 font-medium tabular-nums">{snapshot.benchmark.promptCount}</dd>
          </div>
          <div className="rounded-md border p-3">
            <dt className="text-xs text-muted-foreground">Responses captured</dt>
            <dd className="mt-1 font-medium tabular-nums">
              {snapshot.benchmark.responseCount}
            </dd>
          </div>
        </dl>
      </section>

      <section className="mt-8 rounded-lg border p-5">
        <h2 className="text-lg font-medium">Key finding</h2>
        <p className="mt-2 font-medium">{snapshot.keyFinding.title}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {snapshot.keyFinding.explanation}
        </p>
      </section>

      {snapshot.authorityGap && (
        <section className="mt-8 rounded-lg border p-5">
          <h2 className="text-lg font-medium">Real-world authority vs AI visibility</h2>
          <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
            <div className="rounded-md border p-3">
              <dt className="text-xs text-muted-foreground">Local market authority</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">
                {Math.round(snapshot.authorityGap.authorityScore)}
                <span className="text-xs font-normal text-muted-foreground"> / 100</span>
              </dd>
            </div>
            <div className="rounded-md border p-3">
              <dt className="text-xs text-muted-foreground">AI visibility (intent-weighted)</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">
                {Math.round(snapshot.authorityGap.visibilityScore)}
                <span className="text-xs font-normal text-muted-foreground"> / 100</span>
              </dd>
            </div>
            <div className="rounded-md border p-3">
              <dt className="text-xs text-muted-foreground">Visibility gap</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">
                {Math.round(snapshot.authorityGap.gap)}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            Authority is computed from the evidence below ({snapshot.authorityGap.authorityVersion}
            ); visibility from {snapshot.authorityGap.organicResponses} captured responses to
            questions that did not name you, weighted by commercial intent (
            {snapshot.authorityGap.visibilityVersion}).
          </p>
          {snapshot.authorityGap.signals.length > 0 && (
            <ul className="mt-3 space-y-1.5 text-sm">
              {snapshot.authorityGap.signals.map((s, i) => (
                <li key={i}>
                  {s.label}{" "}
                  <span className="text-xs text-muted-foreground">
                    ({s.provenance.replaceAll("_", " ")}
                    {s.sourceUrl ? (
                      <>
                        {" · "}
                        <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="underline">
                          source
                        </a>
                      </>
                    ) : null}
                    )
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {snapshot.comparison.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-medium">How the market compares</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Team</th>
                  <th className="py-2 pr-4 text-right font-medium">Mentioned</th>
                  <th className="py-2 pr-4 text-right font-medium">Recommended</th>
                  <th className="py-2 text-right font-medium">Responses</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.comparison.map((row) => (
                  <tr
                    key={row.name}
                    className={`border-b last:border-0 ${row.isProspect ? "font-semibold" : ""}`}
                  >
                    <td className="py-2 pr-4">
                      {row.name}
                      {row.isProspect ? " (you)" : ""}
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

      {snapshot.promptEvidence.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-medium">What we asked</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Representative prompts from the monitored set, with the teams each engine surfaced.
          </p>
          <ul className="mt-3 space-y-3">
            {snapshot.promptEvidence.map((e) => (
              <li key={e.responseId} className="rounded-md border p-4 text-sm">
                <p className="font-medium">“{e.promptText}”</p>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {e.provider} ·{" "}
                  {e.recommendedNames.length > 0
                    ? `recommended: ${e.recommendedNames.join(", ")}`
                    : "no specific team recommended in this response"}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-lg font-medium">Methodology</h2>
        <p className="mt-2 text-sm text-muted-foreground">{snapshot.methodology}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {snapshot.benchmark.limitations}
        </p>
      </section>

      <section className="mt-10 rounded-lg border bg-muted/40 p-5 text-center">
        <p className="font-medium">{snapshot.cta}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Reply to the email that brought you here and we’ll walk through the full data together.
        </p>
      </section>
    </div>
  );
}
