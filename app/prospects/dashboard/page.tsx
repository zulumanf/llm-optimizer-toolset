/**
 * Prospecting dashboard (spec 095) — the operator's morning screen, in the
 * order the questions get asked: did anything happen → who do I act on →
 * how's the funnel → is the machine healthy. Server component, one load;
 * every number derives from measured events with its basis stated.
 */
import Link from "next/link";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import {
  EmptyState,
  PageHeader,
  PageShell,
  Section,
  Stat,
  StatGrid,
} from "@/components/layout/page";
import {
  actionQueues,
  engagementNow,
  eventFunnel,
  machineHealth,
} from "@/lib/prospects/dashboard";

export const dynamic = "force-dynamic";

/** Single-hue horizontal funnel bar (dataviz: magnitude → bar; one series →
 * no legend; counts direct-labeled; zero keeps an empty track). SVG rects so
 * width is a presentation attribute, matching the audit page's RateBar. */
function FunnelBar({ count, max }: { count: number; max: number }) {
  const width = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <svg
      className="h-2 w-full"
      viewBox="0 0 100 8"
      preserveAspectRatio="none"
      role="img"
      aria-label={`${count} of ${max}`}
    >
      <rect width="100" height="8" rx="4" className="fill-foreground/10" />
      {width > 0 && (
        <rect width={Math.max(width, 2)} height="8" rx="4" className="fill-foreground/50" />
      )}
    </svg>
  );
}

const when = (d: Date | null): string =>
  d ? new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

export default async function ProspectingDashboardPage() {
  let data;
  try {
    const [engagement, funnel, queues, health] = await Promise.all([
      engagementNow(),
      eventFunnel(),
      actionQueues(),
      machineHealth(),
    ]);
    data = { engagement, funnel, queues, health };
  } catch {
    return (
      <PageShell>
        <PageHeader crumbs={[{ label: "Prospects", href: "/prospects" }]} title="Pipeline dashboard" />
        <EmptyState message="The dashboard queries failed — check the database connection and reload." />
      </PageShell>
    );
  }
  const { engagement, funnel, queues, health } = data;
  const maxCount = funnel[0]?.count ?? 0;
  const capNearLimit = health.capUsed24h >= health.capLimit - 3;
  const gmailHealthy = health.gmailStatus === "active";

  return (
    <PageShell>
      <PageHeader
        crumbs={[{ label: "Prospects", href: "/prospects" }]}
        title="Pipeline dashboard"
        description="What happened, who to act on, how the funnel reads, and whether the machine is healthy — every number derived from captured events, with its basis stated."
      />

      {/* ============================== 1. Did anything happen? */}
      <Section
        title="Since yesterday"
        description={
          engagement.lastEventAt
            ? `Last engagement event ${when(engagement.lastEventAt)}.`
            : "No engagement events recorded yet — the batch is young."
        }
      >
        <StatGrid columns={4}>
          <Stat
            label="Email opens (24h)"
            value={String(engagement.opens24h)}
            hint={`${engagement.opensTotal} total · upper bound — mail clients prefetch images; audit views are the real intent signal`}
          />
          <Stat
            label="Audit views (24h)"
            value={String(engagement.views24h)}
            hint={`${engagement.viewsTotal} total · human-like external views only (our QA scripts excluded)`}
          />
          <Stat
            label="Prospects engaged"
            value={String(
              Math.max(engagement.openedProspects, engagement.viewedProspects)
            )}
            hint={`${engagement.openedProspects} opened · ${engagement.viewedProspects} viewed their audit`}
          />
          <Stat
            label="Replies recorded"
            value={String(engagement.repliesRecorded)}
            hint="from recorded stage changes — record replies on the prospect page as they arrive"
          />
        </StatGrid>
      </Section>

      {/* ============================== 2. Who do I act on? */}
      <Section
        title="Act on these"
        description="The queue, hottest first. Everything here has a next step."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <p className="text-sm font-medium">Viewed their audit this week</p>
            {queues.hot.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                No audit views yet — when a prospect opens their link, they appear
                here, hottest first.
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {queues.hot.map((h) => (
                  <li key={h.prospectId} className="text-sm">
                    <Link
                      href={`/prospects/${h.prospectId}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {h.businessName}
                    </Link>{" "}
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {h.views} view{h.views === 1 ? "" : "s"} · last {when(h.lastViewAt)}
                      {h.opens > 0 ? ` · ${h.opens} open${h.opens === 1 ? "" : "s"}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="text-sm font-medium">Sent 3+ days ago, no engagement</p>
            {queues.stalled.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Nothing stalled — every contacted prospect is under 3 days old or
                has engaged.
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {queues.stalled.map((s) => (
                  <li key={s.prospectId} className="text-sm">
                    <Link
                      href={`/prospects/${s.prospectId}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {s.businessName}
                    </Link>{" "}
                    <span className="text-xs text-muted-foreground tabular-nums">
                      sent {s.daysSinceSend}d ago — consider a follow-up
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {(queues.parkedSends.length > 0 ||
          queues.missingEmail.length > 0 ||
          queues.expiringAudits.length > 0 ||
          queues.draftsAwaitingApproval > 0 ||
          queues.stageDrift > 0) && (
          <div className="mt-6 max-w-[65ch] rounded-md border p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="size-4" /> Needs a decision
            </p>
            <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
              {queues.parkedSends.map((p) => (
                <li key={p.prospectId}>
                  <Link href={`/prospects/${p.prospectId}`} className="text-foreground underline-offset-2 hover:underline">
                    {p.businessName}
                  </Link>
                  : send parked — {p.error.slice(0, 90)}
                </li>
              ))}
              {queues.missingEmail.map((m) => (
                <li key={m.prospectId}>
                  <Link href={`/prospects/${m.prospectId}`} className="text-foreground underline-offset-2 hover:underline">
                    {m.businessName}
                  </Link>
                  : audit published but no contact email — research one to unlock outreach
                </li>
              ))}
              {queues.expiringAudits.map((e) => (
                <li key={e.prospectId}>
                  <Link href={`/prospects/${e.prospectId}`} className="text-foreground underline-offset-2 hover:underline">
                    {e.businessName}
                  </Link>
                  : audit expires {new Date(e.expiresAt).toLocaleDateString()} — republish or let it lapse
                </li>
              ))}
              {queues.draftsAwaitingApproval > 0 && (
                <li>
                  {queues.draftsAwaitingApproval} draft
                  {queues.draftsAwaitingApproval === 1 ? "" : "s"} awaiting approval
                </li>
              )}
              {queues.stageDrift > 0 && (
                <li>
                  {queues.stageDrift} contacted prospect
                  {queues.stageDrift === 1 ? "" : "s"} still recorded at a
                  pre-contact stage — advance them so the recorded pipeline
                  matches the ledger
                </li>
              )}
            </ul>
          </div>
        )}
      </Section>

      {/* ============================== 3. How's the funnel? */}
      <Section
        title="The funnel, as measured"
        description="Counted from the send ledger, open events, human-like audit views, and recorded stage history — never the stage field alone."
      >
        <ul className="max-w-prose space-y-2">
          {funnel.map((step, i) => {
            const prev = i > 0 ? funnel[i - 1]!.count : null;
            const rate =
              prev && prev > 0 && i > 0
                ? Math.round((step.count / prev) * 100)
                : null;
            return (
              <li key={step.key} className="flex items-center gap-3 text-sm">
                <span className="w-36 shrink-0 text-muted-foreground">{step.label}</span>
                <FunnelBar count={step.count} max={maxCount} />
                <span className="w-10 text-right font-medium tabular-nums">{step.count}</span>
                <span
                  className="w-16 text-right text-xs text-muted-foreground tabular-nums"
                  title={step.basis}
                >
                  {rate !== null ? `${rate}%` : ""}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 max-w-[65ch] text-xs text-muted-foreground">
          Percentages are step-to-step conversion. Hover a rate for the number&apos;s
          basis. Opens remain an upper bound; &quot;not measured&quot; never renders as zero.
        </p>
      </Section>

      {/* ============================== 4. Is the machine healthy? */}
      <Section title="The machine" description="Sending capacity and transport health.">
        <StatGrid columns={4}>
          <Stat
            label="Daily send cap"
            value={`${health.capUsed24h}/${health.capLimit}`}
            hint={
              capNearLimit
                ? "near the cap — further sends refuse until the 24h window clears"
                : "gmail sends in the trailing 24 hours"
            }
          />
          <Stat
            label="Gmail connection"
            value={gmailHealthy ? "active" : (health.gmailStatus ?? "not connected")}
            hint={
              gmailHealthy
                ? "token refresh verified"
                : "sends will refuse — reconnect via scripts/connect-gmail.ts"
            }
          />
          <Stat
            label="Scheduled sends"
            value={String(health.scheduledPending)}
            hint="approved drafts the worker will transmit at their named time"
          />
          <Stat
            label="Suppression list"
            value={String(health.activeSuppressions)}
            hint="opt-outs and bounces — enforced on every send, forever"
          />
        </StatGrid>
        <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          {gmailHealthy && !capNearLimit ? (
            <>
              <CheckCircle2 className="size-4" /> All clear — the pipeline can send.
            </>
          ) : (
            <>
              <AlertTriangle className="size-4" /> Attention needed before the next
              batch.
            </>
          )}
        </p>
      </Section>
    </PageShell>
  );
}
