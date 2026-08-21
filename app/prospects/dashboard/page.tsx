/**
 * Prospecting cockpit (spec 095 → 098). The operator's screen, in the order
 * the questions get asked: who needs my attention → what happened in this
 * cohort → where is it leaking → is the machine healthy → the pipeline.
 * Server component, one load; every number derives from measured events
 * with its basis stated. Audit activity is described as what the AUDIT PAGE
 * received — "4 external sessions" — never as who did it.
 */
import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, Flame } from "lucide-react";
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
import { cockpit, machineHealth, WINDOWS, type Window } from "@/lib/prospects/dashboard";
import { formatOperatorTime } from "@/lib/format";
import {
  DIAGNOSTIC_MIN_CONTACTED,
  ENGAGEMENT_RULES,
  FOLLOW_UP_RULES,
  LATENCY_MIN_SAMPLE,
  OPERATOR_TIMEZONE,
  PRIORITY_TIERS,
  type IntentLabel,
  type ProspectIntent,
} from "@/lib/prospects/intent";

export const dynamic = "force-dynamic";

type Filters = {
  window?: string;
  launch?: string;
  intent?: string;
  activity?: string;
  outreach?: string;
  sales?: string;
};

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
  const window: Window = (WINDOWS.find((w) => w.key === filters.window)?.key ?? "batch") as Window;
  const launchId = filters.launch && /^[0-9a-f-]{36}$/i.test(filters.launch) ? filters.launch : undefined;

  let data;
  try {
    const [c, health] = await Promise.all([cockpit({ launchId, window }), machineHealth()]);
    data = { c, health };
  } catch {
    return (
      <PageShell>
        <PageHeader crumbs={[{ label: "Prospects", href: "/prospects" }]} title="Pipeline dashboard" />
        <EmptyState message="The dashboard queries failed — check the database connection and reload." />
      </PageShell>
    );
  }
  const { c, health } = data;
  const { cohort } = c;
  const launchName = c.launches.find((l) => l.id === launchId)?.name ?? "All markets";
  // "Batch" only names a cohort once a launch is chosen; across all markets
  // it is every recorded send (spec 099).
  const windowLabel =
    window === "batch" && !launchId ? "all recorded sends" : (WINDOWS.find((w) => w.key === window)?.label ?? "Batch");
  const href = (patch: Partial<Filters>): string => {
    const q = new URLSearchParams();
    const merged = { ...filters, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, v);
    const s = q.toString();
    return `/prospects/dashboard${s ? `?${s}` : ""}`;
  };

  const gmailHealthy = health.gmailStatus === "active";
  const capNearLimit = health.capUsed24h >= health.capLimit - 3;
  const actToday = c.prospects.filter((p) => p.priorityTier <= 6).slice(0, 8);
  const earlySample = cohort.contacted < DIAGNOSTIC_MIN_CONTACTED;
  const batchAge =
    cohort.cohortAgeDays === null
      ? null
      : cohort.cohortAgeDays < 1
        ? "under 1 day"
        : `${Math.floor(cohort.cohortAgeDays)} day${Math.floor(cohort.cohortAgeDays) === 1 ? "" : "s"}`;

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

  return (
    <PageShell>
      <PageHeader
        crumbs={[{ label: "Prospects", href: "/prospects" }]}
        title="Pipeline dashboard"
        description="Who to act on, what this cohort did, where it leaks, whether the machine can send — every number derived from captured events, with its basis stated."
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            {WINDOWS.map((w) => (
              <Chip key={w.key} href={href({ window: w.key })} active={window === w.key}>
                {w.label}
              </Chip>
            ))}
            <span className="mx-1 text-xs text-muted-foreground">·</span>
            <Chip href={href({ launch: undefined })} active={!launchId}>
              All markets
            </Chip>
            {c.launches
              .filter((l) => l.prospectCount > 0)
              .map((l) => (
                <Chip key={l.id} href={href({ launch: l.id })} active={launchId === l.id}>
                  {l.name}
                </Chip>
              ))}
          </div>
        }
      />

      {/* ============================== P0: can we send? */}
      {!gmailHealthy && (
        <div className="mb-6 max-w-[65ch] rounded-md border border-destructive/40 bg-destructive/5 p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="size-4 text-destructive" /> Outreach blocked
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Gmail connection is{" "}
            <span className="font-medium text-foreground">
              {(health.gmailStatus ?? "not connected").replaceAll("_", " ")}
            </span>
            . Scheduled and manual gmail sends will refuse until it is reconnected.
            Reconnect is a one-time terminal step on the operator machine:{" "}
            <code className="rounded bg-muted px-1 text-xs">npx tsx scripts/connect-gmail.ts</code>{" "}
            — no in-app flow exists yet.
          </p>
        </div>
      )}

      {/* ============================== 1. Who needs my attention? */}
      <Section
        title="Act today"
        description="High-value prospects showing the strongest behavior, ranked: conversation → CTA → high authority + high intent → deep engagement → multiple sessions / unresolved attribution → one visit. Facts describe what the audit page received, never who opened it."
      >
        {actToday.length === 0 ? (
          <EmptyState
            message={
              cohort.contacted === 0
                ? "Nothing contacted in this window. Approve and send drafts, then activity lands here."
                : "No replies or audit activity in this window yet. When a contacted prospect's audit receives a human-like visit, it appears here first."
            }
          />
        ) : (
          <ul className="divide-y rounded-md border">
            {actToday.map((p) => (
              <li key={p.prospectId} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {p.priorityTier <= 3 && <Flame className="size-4 shrink-0" aria-label="priority" />}
                    <Link href={`/prospects/${p.prospectId}`} className="font-medium underline-offset-2 hover:underline">
                      {p.businessName}
                    </Link>
                    {p.highQuality && <Badge variant="outline">High authority{p.qualityScore !== null ? ` · ${p.qualityScore}` : ""}</Badge>}
                    <Badge variant={intentVariant(p.intentLabel)}>{p.intentLabel}</Badge>
                    <span className="text-xs text-muted-foreground">{PRIORITY_TIERS[p.priorityTier - 1]}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground tabular-nums">{activityFacts(p)}</p>
                  <p className="mt-1 text-sm">
                    <span className="text-muted-foreground">Recommended:</span> {p.recommendedAction}
                  </p>
                </div>
                <Link
                  href={`/prospects/${p.prospectId}`}
                  className="mt-1 text-muted-foreground hover:text-foreground"
                  aria-label={`Open ${p.businessName}`}
                >
                  <ArrowRight className="size-4" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ============================== 2. What happened in this cohort? */}
      <Section
        title={`${launchName} — ${windowLabel}`}
        description={
          <>
            {batchAge ? `Batch age: ${batchAge}. ` : "No sends in this window. "}
            Contacted = transmitted sends in the ledger (gmail/mock dispatched, or a human-recorded manual send) — never the stage field alone, never approved or scheduled drafts.
            Viewers = contacted prospects whose audit received ≥1 human-like external view after the first send.
          </>
        }
      >
        <StatGrid columns={4}>
          <Stat label="Contacted" value={String(cohort.contacted)} hint={`${cohort.notContacted} not yet contacted · ${cohort.followUpDue} follow-up${cohort.followUpDue === 1 ? "" : "s"} due`} />
          <Stat
            label="Audit viewers"
            value={`${cohort.viewed} / ${cohort.contacted}`}
            hint={`${pct(cohort.funnel[1]?.rate ?? null)} of contacted · ${cohort.auditViews} view${cohort.auditViews === 1 ? "" : "s"}, ${cohort.auditSessions} session${cohort.auditSessions === 1 ? "" : "s"}`}
          />
          <Stat
            label="Meaningfully engaged"
            value={`${cohort.engaged} / ${cohort.viewed}`}
            hint={`${pct(cohort.funnel[2]?.rate ?? null)} of viewers · ≥${ENGAGEMENT_RULES.engagedSecondsMeaningful}s engaged, ≥${ENGAGEMENT_RULES.deepScrollPercent}% depth, CTA, or an interaction with ≥${ENGAGEMENT_RULES.interactionMinEngagedSeconds}s engaged`}
          />
          <Stat
            label="Replies"
            value={`${cohort.replied} / ${cohort.contacted}`}
            hint={`${cohort.meeting} meeting${cohort.meeting === 1 ? "" : "s"} · ${cohort.proposal} proposal${cohort.proposal === 1 ? "" : "s"} · ${cohort.client} client${cohort.client === 1 ? "" : "s"} — recorded on the prospect page`}
          />
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
        <p className="mt-3 max-w-[65ch] text-xs text-muted-foreground">
          {earlySample && <span className="font-medium text-foreground">Early sample — directional only. </span>}
          Hover a rate for its basis.{" "}
          {cohort.medianSecondsToFirstView === null
            ? "No qualifying audit visit yet."
            : cohort.viewed >= LATENCY_MIN_SAMPLE
              ? <>Median time from first send to first qualifying audit visit: <span className="tabular-nums">{duration(cohort.medianSecondsToFirstView)}</span> · n={cohort.viewed}.</>
              : <>Time to first view: <span className="tabular-nums">{duration(cohort.medianSecondsToFirstView)}</span> · n={cohort.viewed} — no median until {LATENCY_MIN_SAMPLE} viewers.</>}
        </p>

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <div className="rounded-md border p-4">
            <p className="text-sm font-medium">Where it might be leaking</p>
            {cohort.diagnosis.verdict === "not_enough_data" ? (
              <p className="mt-1 text-sm text-muted-foreground">Not enough data yet. {cohort.diagnosis.reason}</p>
            ) : cohort.diagnosis.verdict === "healthy" ? (
              <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="size-4" /> {cohort.diagnosis.reason}
              </p>
            ) : (
              <>
                <p className="mt-1 text-sm">
                  Possible bottleneck: <span className="font-medium">{cohort.diagnosis.bottleneck?.replaceAll("_", " ")}</span>
                  <span className="text-muted-foreground"> — {cohort.diagnosis.reason}</span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">Review: {cohort.diagnosis.review.join(", ")}.</p>
              </>
            )}
          </div>
          <div className="rounded-md border p-4">
            <p className="text-sm font-medium">Data confidence</p>
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground tabular-nums">
              <li>
                {cohort.auditViews} human-like external views · {cohort.auditSessions} sessions ·{" "}
                {cohort.auditVisitorIdentities} known browser identit{cohort.auditVisitorIdentities === 1 ? "y" : "ies"} (our QA, operator IPs, scripts, link scanners excluded)
              </li>
              <li>
                {cohort.attributedLinkProspects} viewer{cohort.attributedLinkProspects === 1 ? "" : "s"} arrived via the emailed link · {cohort.unattributedProspects} unattributed external · {cohort.preOutreachViews} view{cohort.preOutreachViews === 1 ? "" : "s"} before outreach (not counted)
              </li>
              <li>
                {cohort.prospectsWithAnyView} prospect{cohort.prospectsWithAnyView === 1 ? "" : "s"} with any audit view, contacted or not ·{" "}
                {cohort.unresolvedSessions} session{cohort.unresolvedSessions === 1 ? "" : "s"} on never-contacted audits excluded from campaign metrics (no recorded send)
              </li>
              <li title="Mail clients prefetch images and privacy proxies fetch pixels; security scanners open links. Not a human-intent metric and not used in intent scoring.">
                Open signal: {cohort.opens} opens on {cohort.openedProspects} prospect{cohort.openedProspects === 1 ? "" : "s"} — upper bound, diagnostics only
              </li>
            </ul>
          </div>
        </div>
      </Section>

      {/* ============================== 3. Is the machine healthy? */}
      <Section title="Machine health" description="Transport telemetry — separate from campaign counts above.">
        <StatGrid columns={4}>
          <Stat
            label="Gmail connection"
            value={gmailHealthy ? "active" : (health.gmailStatus ?? "not connected").replaceAll("_", " ")}
            hint={gmailHealthy ? "token refresh verified" : "sends refuse until reconnected (see alert above)"}
          />
          <Stat
            label="Send capacity (24h)"
            value={`${health.capUsed24h} / ${health.capLimit}`}
            hint={capNearLimit ? "near the cap — further gmail sends refuse until the window clears" : "gmail messages transmitted in the trailing 24 hours, including follow-ups"}
          />
          <Stat label="Scheduled sends" value={String(health.scheduledPending)} hint="approved drafts the worker will transmit at their named time" />
          <Stat label="Suppression list" value={String(health.activeSuppressions)} hint="opt-outs and bounces — enforced on every send, forever" />
        </StatGrid>

        {(health.parkedSends.length > 0 || health.expiringAudits.length > 0 || health.draftsAwaitingApproval > 0 || c.stageDrift > 0) && (
          <ul className="mt-4 max-w-[65ch] space-y-1.5 text-sm text-muted-foreground">
            {health.parkedSends.map((p) => (
              <li key={p.prospectId} className="flex items-center gap-2">
                <AlertTriangle className="size-4 shrink-0" />
                <span>
                  <Link href={`/prospects/${p.prospectId}`} className="text-foreground underline-offset-2 hover:underline">{p.businessName}</Link>: send parked — {p.error.slice(0, 90)}
                </span>
              </li>
            ))}
            {health.expiringAudits.map((e) => (
              <li key={e.prospectId}>
                <Link href={`/prospects/${e.prospectId}`} className="text-foreground underline-offset-2 hover:underline">{e.businessName}</Link>: audit expires {new Date(e.expiresAt).toLocaleDateString()} — republish or let it lapse
              </li>
            ))}
            {health.draftsAwaitingApproval > 0 && (
              <li>{health.draftsAwaitingApproval} draft{health.draftsAwaitingApproval === 1 ? "" : "s"} awaiting approval</li>
            )}
            {c.stageDrift > 0 && (
              <li>
                {c.stageDrift} contacted prospect{c.stageDrift === 1 ? "" : "s"} still recorded at a pre-contact stage — this page derives contact from the ledger, so nothing here is wrong; advance them when convenient.
              </li>
            )}
          </ul>
        )}

        <div className="mt-4 max-w-[65ch] rounded-md border p-4">
          <p className="text-sm font-medium">
            Research queue · {health.researchQueue.length} prospect{health.researchQueue.length === 1 ? "" : "s"} need{health.researchQueue.length === 1 ? "s" : ""} a contact email
          </p>
          {health.researchQueue.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">Every published audit has a contact — nothing to research.</p>
          ) : (
            <>
              <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
                {researchTop.map((r) => (
                  <li key={r.prospectId}>
                    <Link href={`/prospects/${r.prospectId}`} className="text-foreground underline-offset-2 hover:underline">{r.businessName}</Link>
                    {r.qualityScore !== null && <span className="tabular-nums"> · score {r.qualityScore}</span>}
                  </li>
                ))}
              </ul>
              {health.researchQueue.length > researchTop.length && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                    View all {health.researchQueue.length} →
                  </summary>
                  <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
                    {health.researchQueue.slice(researchTop.length).map((r) => (
                      <li key={r.prospectId}>
                        <Link href={`/prospects/${r.prospectId}`} className="text-foreground underline-offset-2 hover:underline">{r.businessName}</Link>
                        {r.qualityScore !== null && <span className="tabular-nums"> · score {r.qualityScore}</span>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>
      </Section>

      {/* ============================== 4. The pipeline */}
      <Section
        title="Pipeline"
        description={`Every active prospect in ${launchName}, ranked by commercial opportunity — not by created date. Follow-up due after ${FOLLOW_UP_RULES.silentCadenceBusinessDays} silent business days (${FOLLOW_UP_RULES.engagedCadenceBusinessDays} after audit activity — behavior raises priority, not frequency), capped at ${FOLLOW_UP_RULES.maxTouches} touches. Times in ${OPERATOR_TIMEZONE}.`}
      >
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
              <Chip href={href({ [dim]: undefined })} active={!filters[dim]}>
                any
              </Chip>
              {opts.map((o) => (
                <Chip key={o.key} href={href({ [dim]: o.key })} active={filters[dim] === o.key}>
                  {o.label}
                </Chip>
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
                  <TableHead>Stage</TableHead>
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
                      {p.sales.contacted ? `${when(p.sales.lastSentAt)} · ${p.sales.touches}×` : p.engagement.outsideLedger ? "no recorded send" : "—"}
                      {p.followUpDue && <span className="block text-foreground">follow-up due</span>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">
                      {p.engagement.postOutreachViews > 0
                        ? `${p.engagement.sessions} session${p.engagement.sessions === 1 ? "" : "s"}${p.engagement.meaningfullyEngaged ? " · engaged" : ""}${p.engagement.repeat ? " · repeat" : ""}`
                        : p.engagement.preOutreachViews > 0
                          ? "pre-outreach only"
                          : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={intentVariant(p.intentLabel)}>{p.intentLabel}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {p.sales.meeting ? "meeting" : p.sales.replied ? "replied" : p.sales.contacted ? "none" : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{p.stage.replaceAll("_", " ")}</Badge>
                    </TableCell>
                    <TableCell className="max-w-[28ch] text-xs text-muted-foreground">{p.recommendedAction}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {table.length > TABLE_LIMIT && (
              <p className="mt-2 text-xs text-muted-foreground">
                Showing the top {TABLE_LIMIT} of {table.length} — narrow with a filter.
              </p>
            )}
          </div>
        )}
      </Section>
    </PageShell>
  );
}
