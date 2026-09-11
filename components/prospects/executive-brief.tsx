/**
 * Executive brief section (spec 121). Renders the deterministic synthesis
 * from lib/prospects/brief.ts at the top of the cockpit's Operate view:
 * headline and top actions always visible, observations behind a disclosure.
 * Server component — the href resolver comes from the page so the brief
 * module stays URL-agnostic.
 */
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { Section } from "@/components/layout/page";
import type { DashboardFilters } from "@/lib/prospects/dashboard-url";
import type { BriefObservation, ExecutiveBrief } from "@/lib/prospects/brief";

const TONE_ICON: Record<BriefObservation["tone"], typeof CheckCircle2> = {
  good: CheckCircle2,
  watch: Info,
  bad: AlertTriangle,
};

export function ExecutiveBriefSection({
  brief,
  hrefFor,
}: {
  brief: ExecutiveBrief;
  hrefFor: (patch: Partial<DashboardFilters>) => string;
}) {
  return (
    <Section
      title="Executive brief"
      description="What the data says and what to do next — computed from the ledger, no AI."
    >
      <div className="rounded-md border p-4">
        <p className="text-sm font-medium">{brief.headline}</p>
        {brief.actions.length > 0 && (
          <ol className="mt-3 space-y-1.5 text-sm">
            {brief.actions.map((a, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-muted-foreground tabular-nums">{i + 1}.</span>
                <span className="min-w-0">
                  {a.text}
                  <span className="text-xs text-muted-foreground"> — {a.evidence}</span>
                </span>
                {a.target.kind === "filter" && (
                  <Link
                    href={hrefFor(a.target.patch)}
                    className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    open →
                  </Link>
                )}
              </li>
            ))}
          </ol>
        )}
        {brief.observations.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              {brief.observations.length} observation{brief.observations.length === 1 ? "" : "s"} · details
            </summary>
            <ul className="mt-2 space-y-1.5 text-sm">
              {brief.observations.map((o, i) => {
                const Icon = TONE_ICON[o.tone];
                return (
                  <li key={i} className="flex items-start gap-2">
                    <Icon
                      className={`mt-0.5 size-3.5 shrink-0 ${o.tone === "bad" ? "text-destructive" : "text-muted-foreground"}`}
                      aria-label={o.tone}
                    />
                    <span className="min-w-0">
                      {o.text}
                      <span className="text-xs text-muted-foreground tabular-nums"> — {o.evidence}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </details>
        )}
        {brief.epilogue && (
          <p className="mt-3 text-xs font-medium text-muted-foreground">{brief.epilogue}</p>
        )}
      </div>
    </Section>
  );
}
