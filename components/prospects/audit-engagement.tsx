/**
 * Prospect detail: what their audit page received, and when (spec 098).
 * Server component — pure presentation over derived facts. Every line is a
 * statement about the PAGE ("3 sessions, 2 browser identities"), never about
 * a person; the operator reads intent from it privately and never quotes it
 * back to the prospect.
 */
import { Badge } from "@/components/ui/badge";
import { Section, Stat, StatGrid } from "@/components/layout/page";
import type { TimelineEvent } from "@/lib/prospects/dashboard";
import { formatOperatorTime as when } from "@/lib/format";
import { INTENT_WEIGHTS, type ProspectIntent } from "@/lib/prospects/intent";

const duration = (seconds: number | null): string => {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m < 60 ? (s > 0 ? `${m}m ${s}s` : `${m}m`) : `${Math.floor(m / 60)}h ${m % 60}m`;
};

const yesNo = (v: boolean): string => (v ? "Yes" : "No");

export function AuditEngagementSection({
  intent,
  timeline,
}: {
  intent: ProspectIntent;
  timeline: TimelineEvent[];
}) {
  const e = intent.engagement;
  const s = intent.sales;
  const attribution = e.outsideLedger
    ? "external activity with no recorded send (went out another way?)"
    : e.attribution === "attributed_link"
      ? "arrived via the emailed link"
      : e.attribution === "unattributed_external"
        ? "external activity, not provably from the email"
        : e.attribution === "pre_outreach_only"
          ? "activity before outreach only"
          : "no external activity";
  return (
    <Section
      title="Audit engagement"
      description={
        <>
          What the audit page received after the first send — {attribution}. Human-like external
          traffic only (our QA, operator IPs, scripts, and mail-scanner fetches excluded).
          Behavioral intent: <Badge variant={e.postOutreachViews > 0 || s.replied ? "default" : "outline"}>{intent.intentLabel}</Badge>{" "}
          <span className="tabular-nums">(score {intent.intentScore})</span> · Recommended: {intent.recommendedAction}
        </>
      }
    >
      {!s.contacted && e.postOutreachViews === 0 ? (
        <p className="text-sm text-muted-foreground">Not contacted yet — engagement facts start with the first allowed send.</p>
      ) : (
        <StatGrid columns={4}>
          <Stat label={e.outsideLedger ? "First external view" : "First post-outreach view"} value={when(e.firstPostOutreachViewAt)} hint={e.secondsToFirstView !== null ? `${duration(e.secondsToFirstView)} after the first send (${when(s.firstSentAt)})` : e.outsideLedger ? "no allowed send in the ledger" : `first send ${when(s.firstSentAt)}`} />
          <Stat label="Last activity" value={when(e.lastActivityAt)} hint={e.preOutreachViews > 0 ? `${e.preOutreachViews} view(s) before outreach not counted` : undefined} />
          <Stat label="Sessions" value={String(e.sessions)} hint={e.repeat ? `multiple sessions · ${e.visitorIdentities} known browser identit${e.visitorIdentities === 1 ? "y" : "ies"} — not a claim the same person returned` : e.sessions === 1 ? "single visit" : "none"} />
          <Stat
            label="Browser identities"
            value={e.visitorIdentities === 0 ? (e.postOutreachViews > 0 ? "unknown" : "—") : String(e.visitorIdentities)}
            hint={e.possibleAdditionalVisitor ? "possible additional visitor — identity is not verified" : e.unknownIdentityViews > 0 ? `${e.unknownIdentityViews} view(s) reported no identity` : "anonymous browser ids, not people"}
          />
          <Stat label="Engaged time" value={duration(e.engagedSeconds) === "0s" ? "not measured" : duration(e.engagedSeconds)} hint="active, tab-visible seconds summed across sessions" />
          <Stat label="Max scroll" value={e.maxScrollPercent > 0 ? `${e.maxScrollPercent}%` : "not measured"} />
          <Stat label="Competitor section" value={e.competitorSectionViewed ? "Viewed" : "Not viewed"} hint={e.authoritySectionViewed ? "track-record section opened" : undefined} />
          <Stat label="Evidence expanded · CTA" value={`${yesNo(e.evidenceExpanded)} · ${yesNo(e.ctaClicked)}`} hint={`multiple sessions +${INTENT_WEIGHTS.repeatSession}, CTA +${INTENT_WEIGHTS.ctaClicked}, reply +${INTENT_WEIGHTS.reply} in the score; High intent needs meaningful engagement or a CTA`} />
        </StatGrid>
      )}

      {timeline.length > 0 && (
        <ol className="mt-4 max-w-prose space-y-1 text-sm">
          {timeline.map((ev, i) => (
            <li key={`${ev.kind}-${i}`} className="flex gap-3">
              <span className="w-36 shrink-0 text-xs text-muted-foreground tabular-nums">{when(ev.at)}</span>
              <span className={ev.kind === "view" || ev.kind === "cta" ? "font-medium" : "text-muted-foreground"}>{ev.label}</span>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
