/**
 * Prospecting command center (spec 095 → 098 → 100). The operator's screen
 * in the order the questions get asked: what requires me → what is the OS
 * about to do → what needs review → is the strategy working → who is in the
 * pipeline → is the machine healthy → backlog → data confidence. A critical
 * transport failure jumps to the top. Server component, one load; every
 * number derives from measured events. Audit activity is described as what
 * the AUDIT PAGE received — "4 external sessions" — never as who did it.
 *
 * Operator reading of the numbers (kept here so headings stay short):
 * Contacted = transmitted sends in the ledger (gmail/mock dispatched, or a
 * human-recorded manual send) — never the stage field alone, never approved
 * or scheduled drafts. Viewers = contacted prospects whose audit received
 * human-like external views after the first send (our QA, operator IPs,
 * scripts, scanners excluded). Email opens are an upper bound.
 */
import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, Flame, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  EmptyState,
  PageHeader,
  PageShell,
  Section,
  Stat,
  StatGrid,
} from "@/components/layout/page";
import { cockpit, machineHealth, upcomingAutomation, WINDOWS, type UpcomingSend, type Window } from "@/lib/prospects/dashboard";
import { medianHoursToFirstReply, momentum, type Momentum } from "@/lib/prospects/momentum";
import { MomentumSection } from "@/components/prospects/momentum-section";
import { DAILY_SEND_QUOTA } from "@/lib/prospects/constants";
import { dashboardHref, type DashboardFilters } from "@/lib/prospects/dashboard-url";
import { outreachMetrics, type Rate } from "@/lib/prospects/analytics";
import { AnalyzeView, OPEN_SIGNAL_CAVEAT, POSITIVE_REPLY_CAVEAT } from "@/components/prospects/analyze-view";
import { formatOperatorTime } from "@/lib/format";
import {
  DIAGNOSTIC_MIN_CONTACTED,
  DIAGNOSTIC_MIN_COHORT_AGE_DAYS,
  ENGAGEMENT_RULES,
  FOLLOW_UP_RULES,
  FULL_FUNNEL_MIN_CONTACTED,
  LATENCY_MIN_SAMPLE,
  followUpDueAt,
  OPERATOR_TIMEZONE,
  PRIORITY_TIERS,
  type IntentLabel,
  type ProspectIntent,
} from "@/lib/prospects/intent";

export const dynamic = "force-dynamic";

type Filters = DashboardFilters;
/** `launch=all` is the explicit zoom-out; no param = the active cohort. */
const ALL_COHORTS = "all";
const DAY_MS = 86_400_000;

const INTENT_FILTERS: { key: string; label: string; test: (p: ProspectIntent) => boolean }[] = [
  { key: "cold", label: "Cold", test: (p) => p.intentLabel === "Cold" },
  { key: "interested", label: "Interested+", test: (p) => ["Interested", "High intent", "Engaged", "Opportunity"].includes(p.intentLabel) },
  { key: "high", label: "High intent+", test: (p) => ["High intent", "Engaged", "Opportunity"].includes(p.intentLabel) },
  { key: "unresolved", label: "Unresolved", test: (p) => p.intentLabel === "Unresolved" },
];
const ACTIVITY_FILTERS: { key: string; label: string; test: (p: ProspectIntent) => boolean }[] = [
  { key: "never", label: "Never viewed", test: (p) => p.engagement.postOutreachViews === 0 },
  { key: "viewed", label: "Viewed", test: (p) => p.engagement.postOutreachViews > 0 },
  { key: "repeat", label: "Multiple sessions", test: (p) => p.engagement.repeat },
  { key: "deep", label: "Deep engagement", test: (p) => p.engagement.meaningfullyEngaged },
  { key: "cta", label: "CTA", test: (p) => p.engagement.ctaClicked },
];
const OUTREACH_FILTERS: { key: string; label: string; test: (p: ProspectIntent) => boolean }[] = [
  { key: "not", label: "Not contacted", test: (p) => !p.sales.contacted },
  { key: "contacted", label: "Contacted", test: (p) => p.sales.contacted },
  { key: "due", label: "Follow-up due", test: (p) => p.followUpDue },
];
const SALES_FILTERS: { key: string; label: string; test: (p: ProspectIntent) => boolean }[] = [
  { key: "noreply", label: "No reply", test: (p) => p.sales.contacted && !p.sales.replied },
  { key: "replied", label: "Replied", test: (p) => p.sales.replied },
  { key: "meeting", label: "Meeting", test: (p) => p.sales.meeting },
  { key: "proposal", label: "Proposal", test: (p) => p.sales.proposal },
  { key: "won", label: "Won", test: (p) => p.sales.won },
  { key: "lost", label: "Lost", test: (p) => p.sales.lost },
];

const when = formatOperatorTime;

const duration = (seconds: number | null): string => {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};

const pct = (rate: number | null): string => (rate === null ? "—" : `${Math.round(rate * 1000) / 10}%`);

const intentVariant = (label: IntentLabel): "default" | "secondary" | "outline" =>
  label === "Opportunity" || label === "Engaged" || label === "High intent"
    ? "default"
    : label === "Cold" || label === "Unresolved"
      ? "outline"
      : "secondary";

/** One sentence of facts about what the audit page received. */
function activityFacts(p: ProspectIntent): string {
  const e = p.engagement;
  if (e.postOutreachViews === 0) {
    return e.preOutreachViews > 0
      ? `${e.preOutreachViews} view${e.preOutreachViews === 1 ? "" : "s"} before outreach only`
      : p.sales.contacted
        ? `no audit activity · sent ${when(p.sales.lastSentAt)} · ${p.sales.touches} touch${p.sales.touches === 1 ? "" : "es"}`
        : "not contacted";
  }
  const parts = [`${e.sessions} external session${e.sessions === 1 ? "" : "s"}`];
  if (e.repeat) parts.push("multiple sessions");
  if (e.possibleAdditionalVisitor) parts.push(`${e.visitorIdentities} browser identities — possible additional visitor`);
  if (e.engagedSeconds > 0) parts.push(`engaged ${duration(e.engagedSeconds)}`);
  if (e.maxScrollPercent > 0) parts.push(`${e.maxScrollPercent}% depth`);
  if (e.competitorSectionViewed) parts.push("competitor section");
  if (e.evidenceExpanded) parts.push("evidence expanded");
  if (e.ctaClicked) parts.push("CTA clicked");
  parts.push(
    e.outsideLedger
      ? "no recorded send — attribution unresolved"
      : e.attribution === "attributed_link"
        ? "via emailed link"
        : "unattributed external"
  );
  parts.push(`last ${when(e.lastActivityAt)}`);
  return parts.join(" · ");
}

function FunnelBar({ count, max }: { count: number; max: number }) {
  const width = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <svg className="h-2 w-full" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label={`${count} of ${max}`}>
      <rect width="100" height="8" rx="4" className="fill-foreground/10" />
      {width > 0 && <rect width={Math.max(width, 2)} height="8" rx="4" className="fill-foreground/50" />}
    </svg>
  );
}

/** Heading-level help without a paragraph: an info glyph carrying the rule. */
function Help({ text }: { text: string }) {
  return (
    <span title={text} className="inline-flex align-middle text-muted-foreground" aria-label={text}>
      <Info className="size-3.5" />
    </span>
  );
}

const stateLabel: Record<UpcomingSend["state"], string> = {
  auto_send: "AUTO",
  manual_send: "Manual send — ready",
  approval_required: "Approval",
  blocked: "Blocked",
};

const ratePct = (r: Rate): string => (r.rate === null ? "—" : `${Math.round(r.rate * 1000) / 10}%`);

/** Short, scannable next action for the pipeline table; prose lives on the
 * prospect page. */
function nextActionShort(p: ProspectIntent, now: Date): string {
  const s = p.sales, e = p.engagement;
  if (s.won) return "Onboard";
  if (s.lost) return "—";
  if (s.meeting) return "Prepare meeting";
  if (s.replied) return "Review reply";
  if (e.outsideLedger) return "Resolve attribution";
  if (!s.contacted) return p.auditPublished ? (p.hasEmail ? "Ready to send" : "Research email") : "Publish audit";
  if (e.ctaClicked) return "Reach out now";
  if (p.followUpDue) return "Follow-up due";
  const due = followUpDueAt(e, s);
  if (due === null) return "Park";
  return `Wait until ${new Date(due).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: OPERATOR_TIMEZONE })}${due.getTime() < now.getTime() ? "" : ""}`;
}

function auditCell(p: ProspectIntent): string {
  const e = p.engagement;
  if (e.outsideLedger) return `${e.sessions} external · unqualified`;
  if (e.postOutreachViews === 0) {
    if (e.preOutreachViews > 0) return `${e.preOutreachViews} external · pre-contact`;
    if (p.unqualifiedViews > 0) return `${p.unqualifiedViews} external · unqualified`;
    return "—";
  }
  if (e.ctaClicked) return `${e.sessions} session${e.sessions === 1 ? "" : "s"} · CTA`;
  if (e.meaningfullyEngaged && e.maxScrollPercent >= ENGAGEMENT_RULES.deepScrollPercent) return `${e.sessions} session${e.sessions === 1 ? "" : "s"} · deep`;
  if (e.meaningfullyEngaged) return `${e.sessions} session${e.sessions === 1 ? "" : "s"} · engaged`;
  return `${e.sessions} session${e.sessions === 1 ? "" : "s"}`;
}

function Chip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={`rounded-md border px-2 py-0.5 text-xs ${active ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"}`}
    >
      {children}
    </Link>
  );
}

export default async function ProspectingDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Filters>;
}) {
  const filters = await searchParams;
  const now = new Date();
  const view = filters.view === "analyze" ? "analyze" : "operate";
  const window: Window = (WINDOWS.find((w) => w.key === filters.window)?.key ?? "batch") as Window;
  const requestedLaunch = filters.launch && /^[0-9a-f-]{36}$/i.test(filters.launch) ? filters.launch : undefined;
  const zoomOut = filters.launch === ALL_COHORTS;

  let data;
  try {
    // Two passes only when the default cohort must be derived first.
    let c = await cockpit({ launchId: requestedLaunch, window }, now);
    let launchId = requestedLaunch;
    if (!requestedLaunch && !zoomOut && c.activeLaunchId) {
      launchId = c.activeLaunchId;
      c = await cockpit({ launchId, window }, now);
    }
    const [health, upcoming, all] = await Promise.all([
      machineHealth(),
      upcomingAutomation(launchId),
      // Analyze compares batches: it needs every cohort in the same window.
      view === "analyze" && launchId ? cockpit({ window }, now) : Promise.resolve(null),
    ]);
    // After the batch, not inside it — the pooler's session cap is close.
    const mo: Momentum | null = view === "operate" ? await momentum(now) : null;
    data = { c, health, upcoming, launchId, all, mo };
  } catch {
    return (
      <PageShell>
        <PageHeader crumbs={[{ label: "Prospects", href: "/prospects" }]} title="Prospecting" />
        <EmptyState message="The dashboard queries failed — check the database connection and reload." />
      </PageShell>
    );
  }
  const { c, health, upcoming, launchId, all, mo } = data;
  const { cohort } = c;
  const launch = c.launches.find((l) => l.id === launchId);
  const cohortName = launch ? `${launch.name} · Batch 1` : "All active cohorts";
  const windowLabel = WINDOWS.find((w) => w.key === window)?.label ?? "Batch";
  const href = (patch: Partial<Filters>): string => dashboardHref(filters, patch);

  // ---------------------------------------------------------------- derive
  const gmailHealthy = health.gmailStatus === "active";
  const capNearLimit = health.capUsed24h >= health.capLimit - 3;
  const blocked = upcoming.filter((u) => u.state === "blocked");
  const approvals = upcoming.filter((u) => u.state === "approval_required");
  const manualReady = upcoming.filter((u) => u.state === "manual_send");
  const in24h = (d: Date | null): boolean => d !== null && d.getTime() <= now.getTime() + DAY_MS;
  const scheduled24h = upcoming.filter((u) => u.state === "auto_send" && in24h(u.scheduledAt));
  const scheduledLater = upcoming.filter((u) => u.state === "auto_send" && !in24h(u.scheduledAt));
  const withDraft = new Set(upcoming.map((u) => u.prospectId));
  // Follow-ups the cadence makes eligible within 24h and nobody has drafted.
  const eligible24h = c.prospects
    .map((p) => ({ p, at: followUpDueAt(p.engagement, p.sales) }))
    .filter((x): x is { p: ProspectIntent; at: Date } => x.at !== null && in24h(x.at) && !withDraft.has(x.p.prospectId))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const criticalBlock = !gmailHealthy;

  // Revenue actions: only what deserves a human now. Unresolved attribution
  // is review work, not intent (spec 100) — it is excluded here.
  const revenue = c.prospects.filter(
    (p) => !p.engagement.outsideLedger && (p.priorityTier <= 3 || p.followUpDue)
  );
  const repliesWaiting = c.prospects.filter((p) => p.sales.replied && !p.sales.meeting && !p.sales.won && !p.sales.lost).length;
  const meetings = c.prospects.filter((p) => p.sales.meeting && !p.sales.won && !p.sales.lost).length;
  const review = c.prospects.filter((p) => p.engagement.outsideLedger);
  const reviewCount = review.length + blocked.length + health.expiringAudits.length;
  const rates = outreachMetrics(c.prospects);
  const upcomingCount = scheduled24h.length + eligible24h.length;

  const earlySample =
    cohort.contacted < DIAGNOSTIC_MIN_CONTACTED ||
    cohort.cohortAgeDays === null ||
    cohort.cohortAgeDays < DIAGNOSTIC_MIN_COHORT_AGE_DAYS;
  const compactFunnel = cohort.contacted < FULL_FUNNEL_MIN_CONTACTED;
  const batchAge =
    cohort.cohortAgeDays === null
      ? null
      : cohort.cohortAgeDays < 1
        ? "under 1 day old"
        : `${Math.floor(cohort.cohortAgeDays)} day${Math.floor(cohort.cohortAgeDays) === 1 ? "" : "s"} old`;

  const active = {
    intent: INTENT_FILTERS.find((f) => f.key === filters.intent),
    activity: ACTIVITY_FILTERS.find((f) => f.key === filters.activity),
    outreach: OUTREACH_FILTERS.find((f) => f.key === filters.outreach),
    sales: SALES_FILTERS.find((f) => f.key === filters.sales),
  };
  const table = c.prospects.filter(
    (p) =>
      (!active.intent || active.intent.test(p)) &&
      (!active.activity || active.activity.test(p)) &&
      (!active.outreach || active.outreach.test(p)) &&
      (!active.sales || active.sales.test(p))
  );
  const TABLE_LIMIT = 60;
  const researchTop = health.researchQueue.slice(0, 3);
  const cohortOptions = c.launches.filter((l) => l.prospectCount > 0);

  const UpcomingRow = ({ u }: { u: UpcomingSend }) => (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/prospects/${u.prospectId}`} className="font-medium underline-offset-2 hover:underline">{u.businessName}</Link>
          <span className="text-xs text-muted-foreground">Touch {u.touch} · {u.touch === 1 ? "Initial audit email" : "Follow-up"}{u.subject ? ` · "${u.subject}"` : ""}</span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
          {u.scheduledAt ? when(u.scheduledAt) : u.state === "approval_required" ? "after approval" : u.state === "blocked" ? (u.error ?? "blocked").slice(0, 90) : "when you press send"}
          {" · Reason: "}{u.state === "auto_send" ? "scheduled by operator" : u.state === "blocked" ? "transport error — parked" : u.state === "approval_required" ? "awaiting approval" : "awaiting manual send"}
          {" · "}
          <Badge variant={u.state === "blocked" ? "destructive" : u.state === "auto_send" ? "default" : "outline"}>{stateLabel[u.state]}</Badge>
        </p>
      </div>
      <Link href={`/prospects/${u.prospectId}`} className="mt-1 text-xs text-muted-foreground hover:text-foreground">Review →</Link>
    </li>
  );

  return (
    <PageShell>
      <PageHeader
        crumbs={[{ label: "Prospects", href: "/prospects" }]}
        title="Prospecting"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <details className="relative">
              <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md border px-2.5 py-1 text-sm font-medium hover:bg-muted [&::-webkit-details-marker]:hidden">
                {cohortName} <ChevronDown className="size-3.5" />
              </summary>
              <ul className="absolute right-0 z-10 mt-1 min-w-56 rounded-md border bg-background p-1 text-sm shadow-sm">
                {cohortOptions.map((l) => (
                  <li key={l.id}>
                    <Link href={href({ launch: l.id })} className={`block rounded px-2 py-1 hover:bg-muted ${launchId === l.id ? "font-medium" : ""}`}>
                      {l.name} · Batch 1
                      <span className="ml-2 text-xs text-muted-foreground tabular-nums">{l.contactedCount}/{l.prospectCount} contacted</span>
                    </Link>
                  </li>
                ))}
                <li>
                  <Link href={href({ launch: ALL_COHORTS })} className={`block rounded px-2 py-1 hover:bg-muted ${!launchId ? "font-medium" : ""}`}>All active cohorts</Link>
                </li>
              </ul>
            </details>
            <span className="flex items-center gap-1">
              {WINDOWS.map((w) => (
                <Chip key={w.key} href={href({ window: w.key })} active={window === w.key}>
                  {w.key === "batch" ? "Batch" : w.label.replace(" days", "D")}
                </Chip>
              ))}
            </span>
          </div>
        }
      />

      <div className="-mt-3 mb-6 flex gap-1 border-b">
        {(["operate", "analyze"] as const).map((v) => (
          <Link
            key={v}
            href={href({ view: v === "operate" ? undefined : v })}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm capitalize ${view === v ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            aria-current={view === v ? "page" : undefined}
          >
            {v}
          </Link>
        ))}
      </div>

      {view === "analyze" && (
        <AnalyzeView
          prospects={c.prospects}
          allProspects={(all ?? c).prospects}
          cohortName={cohortName}
          metricKey={filters.metric ?? "view"}
          segmentKey={filters.segment ?? "quality"}
          href={(patch) => href(patch)}
        />
      )}

      {view === "operate" && (<>
      {/* ===================== critical transport issues break the order */}
      {criticalBlock && (
        <div className="mb-6 max-w-[65ch] rounded-md border border-destructive/40 bg-destructive/5 p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="size-4 text-destructive" /> Outbound automation blocked
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Gmail connection is <span className="font-medium text-foreground">{(health.gmailStatus ?? "not connected").replaceAll("_", " ")}</span>
            {health.scheduledPending > 0 ? ` · ${health.scheduledPending} scheduled send${health.scheduledPending === 1 ? "" : "s"} waiting` : ""}.
            Reconnect from the operator machine: <code className="rounded bg-muted px-1 text-xs">npx tsx scripts/connect-gmail.ts</code> — no in-app flow yet.
          </p>
        </div>
      )}

      {/* ===================== today strip */}
      <dl className="mb-6 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {[
          ["Replies to answer", repliesWaiting],
          ["Meetings to prepare", meetings],
          [manualReady.length > 0 || approvals.length === 0 ? "Ready to send" : "Approvals", manualReady.length > 0 || approvals.length === 0 ? manualReady.length : approvals.length],
          ["Auto follow-ups", upcomingCount],
          ["Needs review", reviewCount],
        ].map(([label, n]) => (
          <div key={String(label)} className="flex items-baseline gap-1.5">
            <dd className="text-lg font-medium tabular-nums">{String(n)}</dd>
            <dt className="text-xs text-muted-foreground">{String(label)}</dt>
          </div>
        ))}
      </dl>

      {/* ===================== 0. did we do the work (spec 119) */}
      {mo && <MomentumSection momentum={mo} prospects={c.prospects} cohortName={cohortName} quota={DAILY_SEND_QUOTA} />}

      {/* ===================== 1. what requires me */}
      <Section
        title="Needs your attention"
        description={<>Revenue actions only. <Help text="Ranked: replies and meetings → CTA clicks → high authority with verified high intent → follow-ups the cadence says are due. Unresolved attribution never appears here; it goes to Needs review." /></>}
      >
        {revenue.length === 0 && manualReady.length === 0 && approvals.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><CheckCircle2 className="size-4" /> Nothing needs your attention right now.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {manualReady.length > 0 && (
              <li className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{manualReady.length} initial email{manualReady.length === 1 ? "" : "s"} ready to send</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">Top prospects: {manualReady.slice(0, 3).map((u) => u.businessName).join(" · ")}</p>
                </div>
                <Link href={href({ outreach: "not", intent: undefined, activity: undefined, sales: undefined })} className="mt-1 text-xs text-muted-foreground hover:text-foreground">Review queue →</Link>
              </li>
            )}
            {approvals.length > 0 && (
              <li className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{approvals.length} draft{approvals.length === 1 ? "" : "s"} awaiting your approval</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{approvals.slice(0, 3).map((u) => u.businessName).join(" · ")}</p>
                </div>
                <Link href={`/prospects/${approvals[0]!.prospectId}`} className="mt-1 text-xs text-muted-foreground hover:text-foreground">Review →</Link>
              </li>
            )}
            {revenue.slice(0, 8).map((p) => (
              <li key={p.prospectId} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {p.priorityTier <= 3 && <Flame className="size-4 shrink-0" aria-label="priority" />}
                    <Link href={`/prospects/${p.prospectId}`} className="font-medium underline-offset-2 hover:underline">{p.businessName}</Link>
                    {p.highQuality && <Badge variant="outline">High authority{p.qualityScore !== null ? ` · ${p.qualityScore}` : ""}</Badge>}
                    <Badge variant={intentVariant(p.intentLabel)}>{p.intentLabel}</Badge>
                    <span className="text-xs text-muted-foreground">{p.followUpDue && p.priorityTier > 3 ? "follow-up due" : PRIORITY_TIERS[p.priorityTier - 1]}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground tabular-nums">{activityFacts(p)}</p>
                  <p className="mt-1 text-sm"><span className="text-muted-foreground">Recommended:</span> {p.recommendedAction}</p>
                </div>
                <Link href={`/prospects/${p.prospectId}`} className="mt-1 text-muted-foreground hover:text-foreground" aria-label={`Open ${p.businessName}`}>
                  <ArrowRight className="size-4" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ===================== 2. what the OS is about to do */}
      <Section
        title="Next 24 hours"
        description={<>What the OS does without you. <Help text={`Scheduled sends transmit at their named time. Follow-ups become eligible ${FOLLOW_UP_RULES.silentCadenceBusinessDays} business days after a silent send (${FOLLOW_UP_RULES.engagedCadenceBusinessDays} after audit activity), up to ${FOLLOW_UP_RULES.maxTouches} touches; nothing sends without an approved draft.`} /></>}
      >
        <p className="mb-3 text-sm font-medium tabular-nums">
          {scheduled24h.length} scheduled send{scheduled24h.length === 1 ? "" : "s"} · {eligible24h.length} follow-up{eligible24h.length === 1 ? "" : "s"} becoming eligible · {approvals.length} awaiting approval · {blocked.length} blocked
          {scheduledLater.length > 0 ? <span className="font-normal text-muted-foreground"> · {scheduledLater.length} scheduled later</span> : null}
        </p>
        {scheduled24h.length + eligible24h.length === 0 ? (
          <p className="text-sm text-muted-foreground">No automated outreach scheduled in the next 24 hours.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {scheduled24h.slice(0, 5).map((u) => <UpcomingRow key={u.draftId} u={u} />)}
            {eligible24h.slice(0, Math.max(0, 5 - scheduled24h.length)).map(({ p, at }) => (
              <li key={p.prospectId} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/prospects/${p.prospectId}`} className="font-medium underline-offset-2 hover:underline">{p.businessName}</Link>
                    <span className="text-xs text-muted-foreground">Touch {p.sales.touches + 1} · {p.engagement.postOutreachViews > 0 ? "Audit-specific follow-up" : "No-view value reframe"}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                    eligible {when(at)} · Reason: {p.engagement.postOutreachViews > 0 ? "qualifying audit engagement + no reply" : `no audit activity after Touch ${p.sales.touches}`} · <Badge variant="outline">ELIGIBLE · draft needed</Badge>
                  </p>
                </div>
                <Link href={`/prospects/${p.prospectId}`} className="mt-1 text-xs text-muted-foreground hover:text-foreground">Review →</Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ===================== 3. needs review — hidden when clean */}
      {reviewCount > 0 && (
        <Section title="Needs review" description={<>Data and state anomalies, not buyer intent. <Help text="Audit activity with no recorded send, parked sends, audits about to expire. Resolve these so campaign metrics stay honest." /></>}>
          <ul className="divide-y rounded-md border text-sm">
            {review.map((p) => (
              <li key={p.prospectId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <Link href={`/prospects/${p.prospectId}`} className="font-medium underline-offset-2 hover:underline">{p.businessName}</Link>
                  <span className="text-muted-foreground"> — {p.engagement.sessions} external audit session{p.engagement.sessions === 1 ? "" : "s"}, but no corresponding outbound send is recorded. Attribution unresolved.</span>
                </div>
                <Link href={`/prospects/${p.prospectId}`} className="text-xs text-muted-foreground hover:text-foreground">Resolve →</Link>
              </li>
            ))}
            {blocked.map((u) => (
              <li key={u.draftId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <Link href={`/prospects/${u.prospectId}`} className="font-medium underline-offset-2 hover:underline">{u.businessName}</Link>
                  <span className="text-muted-foreground"> — send parked: {(u.error ?? "").slice(0, 90)}</span>
                </div>
                <Link href={`/prospects/${u.prospectId}`} className="text-xs text-muted-foreground hover:text-foreground">Resolve →</Link>
              </li>
            ))}
            {health.expiringAudits.map((e) => (
              <li key={e.prospectId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <Link href={`/prospects/${e.prospectId}`} className="font-medium underline-offset-2 hover:underline">{e.businessName}</Link>
                  <span className="text-muted-foreground"> — audit expires {when(e.expiresAt)}; republish or let it lapse.</span>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* ===================== 4. is the strategy working */}
      <Section
        title={cohortName}
        description={
          <>
            {batchAge ?? "no sends yet"} · {cohort.contacted} contacted{window !== "batch" ? ` · ${windowLabel}` : ""}{" "}
            <Help text="Contacted counts only after an outbound message is transmitted or a human records a manual send; scheduled or approved drafts do not count. Viewers = contacted prospects whose audit received ≥1 human-like external view after the first send. Engaged = ≥30s engaged, ≥75% depth, CTA, or an interaction with engaged time. Replies and meetings come from recorded stage changes." />
          </>
        }
      >
        {compactFunnel ? (
          <div className="flex flex-wrap items-end gap-x-2 gap-y-2">
            {cohort.funnel.slice(0, 5).map((step, i) => (
              <div key={step.key} className="flex items-end gap-2">
                {i > 0 && <span className="pb-1 text-muted-foreground">→</span>}
                <div title={step.basis}>
                  <p className="text-2xl font-medium tabular-nums">{step.count}</p>
                  <p className="text-xs text-muted-foreground">{step.label}{step.of !== null && step.of > 0 && step.count > 0 ? ` · ${pct(step.rate)}` : ""}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <>
            <StatGrid columns={4}>
              <Stat label="Contacted" value={String(cohort.contacted)} hint={`${cohort.notContacted} not yet contacted`} />
              <Stat label="Audit viewers" value={`${cohort.viewed} / ${cohort.contacted}`} hint={`${pct(cohort.funnel[1]?.rate ?? null)} of contacted`} />
              <Stat label="Meaningfully engaged" value={`${cohort.engaged} / ${cohort.viewed}`} hint={`${pct(cohort.funnel[2]?.rate ?? null)} of viewers · ≥${ENGAGEMENT_RULES.engagedSecondsMeaningful}s, ≥${ENGAGEMENT_RULES.deepScrollPercent}% depth, CTA, or interaction`} />
              <Stat label="Replies" value={`${cohort.replied} / ${cohort.contacted}`} hint={`${cohort.meeting} meeting${cohort.meeting === 1 ? "" : "s"}`} />
            </StatGrid>
            <ul className="mt-5 max-w-prose space-y-2">
              {cohort.funnel.map((step) => (
                <li key={step.key} className="flex items-center gap-3 text-sm">
                  <span className="w-40 shrink-0 text-muted-foreground">{step.label}</span>
                  <FunnelBar count={step.count} max={cohort.contacted} />
                  <span className="w-10 text-right font-medium tabular-nums">{step.count}</span>
                  <span className="w-24 text-right text-xs text-muted-foreground tabular-nums" title={step.basis}>
                    {step.of !== null && step.of > 0 ? `${pct(step.rate)} of ${step.of}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <dl className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums">
          {(
            [
              ["Delivery", rates.delivery, undefined],
              ["Open signal", rates.openSignal, OPEN_SIGNAL_CAVEAT],
              ["Audit view", rates.auditView, undefined],
              ["Engaged view", rates.engagedView, undefined],
              ["Reply", rates.reply, undefined],
              ["Positive reply", rates.positiveReply, POSITIVE_REPLY_CAVEAT],
              ["Meeting", rates.meeting, undefined],
            ] as const
          ).map(([label, r, caveat]) => (
            <div key={label} title={caveat ?? (r.of ? `${r.n} of ${r.of}` : "no data")}>
              <dt className="inline text-muted-foreground">{label} </dt>
              <dd className="inline font-medium">{ratePct(r)}{caveat && r.rate !== null ? "*" : ""}</dd>
            </div>
          ))}
          <span className="text-muted-foreground">* directional only</span>
        </dl>
        <p className="mt-3 max-w-[65ch] text-xs text-muted-foreground">
          {cohort.proposal > 0 || cohort.client > 0 ? `${cohort.proposal} proposal${cohort.proposal === 1 ? "" : "s"} · ${cohort.client} client${cohort.client === 1 ? "" : "s"} · ` : ""}
          {earlySample ? (
            <span className="font-medium text-foreground">Early sample — do not diagnose yet.</span>
          ) : cohort.diagnosis.verdict === "healthy" ? (
            <span className="inline-flex items-center gap-1"><CheckCircle2 className="size-3.5" /> {cohort.diagnosis.reason}</span>
          ) : cohort.diagnosis.verdict === "possible_bottleneck" ? (
            <>Possible bottleneck: <span className="font-medium text-foreground">{cohort.diagnosis.bottleneck?.replaceAll("_", " ")}</span> — {cohort.diagnosis.reason} Review {cohort.diagnosis.review.join(", ")}.</>
          ) : (
            cohort.diagnosis.reason
          )}
          {cohort.medianSecondsToFirstView !== null && cohort.viewed >= LATENCY_MIN_SAMPLE && (
            <> Median time to first audit visit <span className="tabular-nums">{duration(cohort.medianSecondsToFirstView)}</span> (n={cohort.viewed}).</>
          )}
          {(() => {
            const r = medianHoursToFirstReply(c.prospects);
            return r.hours !== null && r.n >= LATENCY_MIN_SAMPLE ? (
              <> Median time to first reply <span className="tabular-nums">{duration(Math.round(r.hours * 3600))}</span> (n={r.n}).</>
            ) : null;
          })()}
        </p>
      </Section>

      {/* ===================== 5. pipeline */}
      <Section title="Pipeline" description={<>Ranked by commercial opportunity. <Help text="Order: conversation → CTA → high authority + high intent → depth → sessions → one visit → follow-up due → contacted, silent → not contacted. Filters compose; each link keeps the others." /></>}>
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          {(
            [
              ["intent", INTENT_FILTERS],
              ["activity", ACTIVITY_FILTERS],
              ["outreach", OUTREACH_FILTERS],
              ["sales", SALES_FILTERS],
            ] as const
          ).map(([dim, opts]) => (
            <div key={dim} className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-muted-foreground capitalize">{dim}</span>
              <Chip href={href({ [dim]: undefined })} active={!filters[dim]}>any</Chip>
              {opts.map((o) => (
                <Chip key={o.key} href={href({ [dim]: o.key })} active={filters[dim] === o.key}>{o.label}</Chip>
              ))}
            </div>
          ))}
        </div>
        {table.length === 0 ? (
          <EmptyState message="No prospects match these filters. Clear a filter above." />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Prospect</TableHead>
                  <TableHead className="text-right">Quality</TableHead>
                  <TableHead>Outreach</TableHead>
                  <TableHead>Audit</TableHead>
                  <TableHead>Intent</TableHead>
                  <TableHead>Reply</TableHead>
                  <TableHead>Sales stage</TableHead>
                  <TableHead>Next action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {table.slice(0, TABLE_LIMIT).map((p) => (
                  <TableRow key={p.prospectId}>
                    <TableCell className="font-medium">
                      <Link href={`/prospects/${p.prospectId}`} className="underline-offset-2 hover:underline">{p.businessName}</Link>
                      {launchId ? null : <span className="block text-xs font-normal text-muted-foreground">{p.launchName}</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{p.qualityScore ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">
                      {p.sales.contacted ? `${when(p.sales.lastSentAt)} · Touch ${p.sales.touches}` : p.engagement.outsideLedger ? "no recorded send" : "—"}
                      {p.followUpDue && <span className="block text-foreground">follow-up due</span>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">{auditCell(p)}</TableCell>
                    <TableCell><Badge variant={intentVariant(p.intentLabel)}>{p.intentLabel}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{p.sales.meeting ? "meeting" : p.sales.replied ? "replied" : p.sales.contacted ? "none" : "—"}</TableCell>
                    <TableCell><Badge variant="secondary">{p.stage.replaceAll("_", " ")}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground" title={p.recommendedAction}>{nextActionShort(p, now)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {table.length > TABLE_LIMIT && (
              <p className="mt-2 text-xs text-muted-foreground">Showing the top {TABLE_LIMIT} of {table.length} — narrow with a filter.</p>
            )}
          </div>
        )}
      </Section>

      {/* ===================== 6. machine health — compact when healthy */}
      <Section title="Machine health">
        {gmailHealthy && !capNearLimit && blocked.length === 0 ? (
          <details>
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm [&::-webkit-details-marker]:hidden">
              <CheckCircle2 className="size-4" /> Machine healthy · Gmail active · reply sync manual · {health.capUsed24h}/{health.capLimit} sends used · {blocked.length} blocked · {health.activeSuppressions} suppressed
              <span className="text-xs text-muted-foreground">details</span>
            </summary>
            <div className="mt-3">
              <StatGrid columns={4}>
                <Stat label="Gmail connection" value="active" hint="token refresh verified" />
                <Stat label="Send capacity (24h)" value={`${health.capUsed24h} / ${health.capLimit}`} hint="gmail messages transmitted in the trailing 24 hours, including follow-ups" />
                <Stat label="Scheduled sends" value={String(health.scheduledPending)} hint="approved drafts the worker will transmit at their named time" />
                <Stat label="Suppression list" value={String(health.activeSuppressions)} hint="opt-outs and bounces — enforced on every send, forever" />
              </StatGrid>
            </div>
          </details>
        ) : (
          <StatGrid columns={4}>
            <Stat label="Gmail connection" value={gmailHealthy ? "active" : (health.gmailStatus ?? "not connected").replaceAll("_", " ")} hint={gmailHealthy ? "token refresh verified" : "sends refuse until reconnected (see alert above)"} />
            <Stat label="Send capacity (24h)" value={`${health.capUsed24h} / ${health.capLimit}`} hint={capNearLimit ? "near the cap — further gmail sends refuse until the window clears" : "gmail messages transmitted in the trailing 24 hours"} />
            <Stat label="Blocked sends" value={String(blocked.length)} hint="parked after a transport error — see Needs review" />
            <Stat label="Suppression list" value={String(health.activeSuppressions)} hint="opt-outs and bounces — enforced on every send, forever" />
          </StatGrid>
        )}
        {c.stageDrift > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            {c.stageDrift} contacted prospect{c.stageDrift === 1 ? "" : "s"} still recorded at a pre-contact stage — contact derives from the ledger, so nothing here is wrong; new sends advance the stage automatically.
          </p>
        )}
      </Section>

      {/* ===================== 7. backlog */}
      <Section title="Research queue">
        {health.researchQueue.length === 0 ? (
          <p className="text-sm text-muted-foreground">Every published audit has a contact — nothing to research.</p>
        ) : (
          <details>
            <summary className="cursor-pointer list-none text-sm [&::-webkit-details-marker]:hidden">
              {health.researchQueue.length} prospect{health.researchQueue.length === 1 ? "" : "s"} need{health.researchQueue.length === 1 ? "s" : ""} contact enrichment
              <span className="ml-2 text-xs text-muted-foreground">
                {researchTop.map((r) => r.businessName).join(" · ")}{health.researchQueue.length > researchTop.length ? " · view all →" : ""}
              </span>
            </summary>
            <ul className="mt-2 space-y-0.5 text-sm text-muted-foreground">
              {health.researchQueue.map((r) => (
                <li key={r.prospectId}>
                  <Link href={`/prospects/${r.prospectId}`} className="text-foreground underline-offset-2 hover:underline">{r.businessName}</Link>
                  {r.qualityScore !== null && <span className="tabular-nums"> · score {r.qualityScore}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Section>

      {/* ===================== 8. data confidence — collapsed */}
      <Section title="Data confidence">
        <details>
          <summary className="cursor-pointer list-none text-sm [&::-webkit-details-marker]:hidden">
            {review.length > 0 ? (
              <span className="font-medium">{review.length} attribution issue{review.length === 1 ? "" : "s"} require{review.length === 1 ? "s" : ""} review</span>
            ) : (
              <span className="font-medium">High confidence</span>
            )}
            <span className="ml-2 text-xs text-muted-foreground">Human-like traffic only · internal QA/scripts/known scanners excluded · {review.length} attribution issue{review.length === 1 ? "" : "s"} · details</span>
          </summary>
          <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground tabular-nums">
            <li>
              {cohort.auditViews} human-like external views · {cohort.auditSessions} sessions · {cohort.auditVisitorIdentities} known browser identit{cohort.auditVisitorIdentities === 1 ? "y" : "ies"} (our QA, operator IPs, scripts, link scanners excluded)
            </li>
            <li>
              {cohort.attributedLinkProspects} viewer{cohort.attributedLinkProspects === 1 ? "" : "s"} arrived via the emailed link · {cohort.unattributedProspects} unattributed external · {cohort.preOutreachViews} view{cohort.preOutreachViews === 1 ? "" : "s"} before outreach (not counted)
            </li>
            <li>
              {cohort.prospectsWithAnyView} prospect{cohort.prospectsWithAnyView === 1 ? "" : "s"} with any audit view, contacted or not · {cohort.unresolvedSessions} session{cohort.unresolvedSessions === 1 ? "" : "s"} on never-contacted audits excluded from campaign metrics (no recorded send)
            </li>
            <li title="Mail clients prefetch images and privacy proxies fetch pixels; security scanners open links. Not a human-intent metric and not used in intent scoring.">
              Open signal: {cohort.opens} opens on {cohort.openedProspects} prospect{cohort.openedProspects === 1 ? "" : "s"} — upper bound, diagnostics only
            </li>
            <li>Times shown in {OPERATOR_TIMEZONE.replace("America/", "").replace("_", " ")}.</li>
          </ul>
        </details>
      </Section>
      </>)}
    </PageShell>
  );
}
