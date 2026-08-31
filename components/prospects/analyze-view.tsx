/**
 * Analyze tab (spec 101): is the outbound machine getting better, and why?
 * Scorecard → funnel → over time → cohorts → touches → strategy → subjects →
 * segments → timing → economics → insights. Every number comes from
 * lib/prospects/analytics.ts — the same functions Operate uses. Server
 * component; tables and one restrained SVG chart, nothing decorative.
 */
import Link from "next/link";
import { Info } from "lucide-react";
import { Section, Stat, StatGrid } from "@/components/layout/page";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  byArm,
  byCohort,
  bySegment,
  byStrategy,
  bySubject,
  byTemplate,
  byTiming,
  byTouch,
  funnelConversion,
  funnelDiagnostic,
  insights,
  outreachMetrics,
  SAMPLE,
  SEGMENT_DIMENSIONS,
  yieldPer100,
  type GroupRow,
  type OutreachMetrics,
  type Rate,
  type SegmentDimension,
  type SendGroupRow,
} from "@/lib/prospects/analytics";
import type { ProspectIntent } from "@/lib/prospects/intent";

export const OPEN_SIGNAL_CAVEAT =
  "Directional only. Mail privacy, image proxies, and security systems can inflate opens.";
export const POSITIVE_REPLY_CAVEAT =
  "Counted from recorded reply classifications. Blank until a classified reply exists in the group — replies recorded only as stage moves carry no sentiment.";

const pct = (r: Rate | null | undefined): string =>
  !r || r.rate === null ? "—" : `${Math.round(r.rate * 1000) / 10}%`;
const frac = (r: Rate): string => (r.of === 0 ? "" : `${r.n} / ${r.of}`);

export const OVER_TIME_METRICS: { key: string; label: string; pick: (m: OutreachMetrics) => Rate }[] = [
  { key: "view", label: "Audit view rate", pick: (m) => m.auditView },
  { key: "engaged", label: "Meaningful engagement rate", pick: (m) => m.engagedView },
  { key: "reply", label: "Reply rate", pick: (m) => m.reply },
  { key: "positive", label: "Positive reply rate", pick: (m) => m.positiveReply },
  { key: "meeting", label: "Meeting rate", pick: (m) => m.meeting },
];

function Help({ text }: { text: string }) {
  return (
    <span title={text} className="inline-flex align-middle text-muted-foreground" aria-label={text}>
      <Info className="size-3.5" />
    </span>
  );
}

function RateCell({ r, caveat }: { r: Rate; caveat?: string }) {
  return (
    <TableCell className="text-right tabular-nums" title={caveat ?? (r.of ? `${r.n} of ${r.of}` : undefined)}>
      {pct(r)}
      {caveat && r.rate !== null ? "*" : ""}
    </TableCell>
  );
}

function SendGroupTable({ rows, firstHeader, showOpen = false, showAudit = true }: { rows: SendGroupRow[]; firstHeader: string; showOpen?: boolean; showAudit?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{firstHeader}</TableHead>
            <TableHead className="text-right">Sent</TableHead>
            <TableHead className="text-right">Delivered</TableHead>
            {showOpen && <TableHead className="text-right">Open signal*</TableHead>}
            {showAudit && <TableHead className="text-right">Audit view</TableHead>}
            <TableHead className="text-right">Replies</TableHead>
            <TableHead className="text-right">Positive</TableHead>
            <TableHead className="text-right">Meetings</TableHead>
            <TableHead>Sample</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.key}>
              <TableCell className="max-w-[36ch] truncate font-medium" title={r.label}>{r.label}</TableCell>
              <TableCell className="text-right tabular-nums">{r.sent}</TableCell>
              <TableCell className="text-right tabular-nums">{r.delivered}</TableCell>
              {showOpen && <RateCell r={r.openSignal} caveat={OPEN_SIGNAL_CAVEAT} />}
              {showAudit && <RateCell r={r.auditView} />}
              <RateCell r={r.reply} />
              <RateCell r={r.positiveReply} caveat={POSITIVE_REPLY_CAVEAT} />
              <RateCell r={r.meeting} />
              <TableCell className="text-xs text-muted-foreground">{r.sample}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function GroupTable({ rows, firstHeader, hrefFor }: { rows: GroupRow[]; firstHeader: string; hrefFor?: (row: GroupRow) => string }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{firstHeader}</TableHead>
            <TableHead className="text-right">Delivered</TableHead>
            <TableHead className="text-right">Audit view</TableHead>
            <TableHead className="text-right">Engaged</TableHead>
            <TableHead className="text-right">Reply</TableHead>
            <TableHead className="text-right">Positive</TableHead>
            <TableHead className="text-right">Meeting</TableHead>
            <TableHead>Sample</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((g) => (
            <TableRow key={g.key}>
              <TableCell className="font-medium">
                {hrefFor ? <Link href={hrefFor(g)} className="underline-offset-2 hover:underline">{g.label}</Link> : g.label}
              </TableCell>
              <TableCell className="text-right tabular-nums">{g.metrics.delivered}</TableCell>
              <RateCell r={g.metrics.auditView} />
              <RateCell r={g.metrics.engagedView} />
              <RateCell r={g.metrics.reply} />
              <RateCell r={g.metrics.positiveReply} caveat={POSITIVE_REPLY_CAVEAT} />
              <RateCell r={g.metrics.meeting} />
              <TableCell className="text-xs text-muted-foreground">{g.sample}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** One line: the chosen metric across cohorts in send order. SVG, neutral
 * ink, direct labels — no chart library. */
function OverTimeChart({ points }: { points: { label: string; rate: number | null; n: number }[] }) {
  const W = 640, H = 160, PAD = 28;
  const xs = points.map((_, i) => PAD + (i * (W - 2 * PAD)) / Math.max(1, points.length - 1));
  const ys = points.map((p) => (p.rate === null ? null : H - PAD - p.rate * (H - 2 * PAD)));
  const path = points
    .map((p, i) => (ys[i] === null ? null : `${xs[i]},${ys[i]}`))
    .filter((v): v is string => v !== null)
    .map((v, i) => `${i === 0 ? "M" : "L"}${v}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full max-w-2xl" role="img" aria-label="metric by cohort">
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} className="stroke-foreground/20" />
      <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} className="stroke-foreground/20" />
      {path && <path d={path} fill="none" className="stroke-foreground/70" strokeWidth={1.5} />}
      {points.map((p, i) =>
        ys[i] === null ? null : (
          <g key={p.label}>
            <circle cx={xs[i]} cy={ys[i]!} r={3} className="fill-foreground" />
            <text x={xs[i]} y={ys[i]! - 8} textAnchor="middle" className="fill-foreground text-[10px] tabular-nums">
              {Math.round(p.rate! * 100)}% · n={p.n}
            </text>
          </g>
        )
      )}
      {points.map((p, i) => (
        <text key={`l-${p.label}`} x={xs[i]} y={H - PAD + 14} textAnchor="middle" className="fill-muted-foreground text-[10px]">
          {p.label.length > 18 ? `${p.label.slice(0, 17)}…` : p.label}
        </text>
      ))}
    </svg>
  );
}

export function AnalyzeView({
  prospects,
  allProspects,
  cohortName,
  metricKey,
  segmentKey,
  href,
}: {
  prospects: ProspectIntent[];
  /** Every cohort (same window) — for comparison and over-time. */
  allProspects: ProspectIntent[];
  cohortName: string;
  metricKey: string;
  segmentKey: string;
  href: (patch: { metric?: string; segment?: string; launch?: string }) => string;
}) {
  const m = outreachMetrics(prospects);
  const funnel = funnelConversion(m);
  const diag = funnelDiagnostic(m);
  const cohorts = byCohort(allProspects);
  const touches = byTouch(prospects);
  const arms = byArm(prospects);
  const templates = byTemplate(prospects);
  const strategies = byStrategy(prospects);
  const subjects = bySubject(prospects);
  const dim = (SEGMENT_DIMENSIONS.find((d) => d.key === segmentKey)?.key ?? "quality") as SegmentDimension;
  const segments = bySegment(prospects, dim);
  const timing = byTiming(prospects);
  const metric = OVER_TIME_METRICS.find((x) => x.key === metricKey) ?? OVER_TIME_METRICS[0]!;
  const series = cohorts.map((c) => ({ label: c.label, rate: metric.pick(c.metrics).rate, n: c.metrics.delivered }));
  const per100 = yieldPer100(m);
  const found = insights(prospects);
  const card = (label: string, r: Rate, caveat?: string) => (
    <Stat label={<>{label} {caveat && <Help text={caveat} />}</>} value={`${pct(r)}${caveat && r.rate !== null ? "*" : ""}`} hint={r.of > 0 ? frac(r) : caveat ? "not recorded" : "no data"} />
  );

  return (
    <>
      <Section title="Performance" description={<>{cohortName} · {m.sent} sent · {m.delivered} delivered <Help text="Prospect-unique rates. Delivery = sent minus bounce-suppressed recipients. All view/reply/meeting rates use delivered prospects as the denominator; engaged and multiple-session rates use audit viewers." /></>}>
        <StatGrid columns={4}>
          {card("Delivery", m.delivery)}
          {card("Open signal", m.openSignal, OPEN_SIGNAL_CAVEAT)}
          {card("Audit view rate", m.auditView)}
          {card("Engaged view rate", m.engagedView)}
          {card("Multiple-session rate", m.repeatSession)}
          {card("Reply rate", m.reply)}
          {card("Positive reply rate", m.positiveReply, POSITIVE_REPLY_CAVEAT)}
          {card("Meeting rate", m.meeting)}
        </StatGrid>
        <p className="mt-2 text-xs text-muted-foreground">* directional only · Reply → meeting {pct(m.replyToMeeting)}{m.replyToMeeting.of ? ` (${frac(m.replyToMeeting)})` : ""} · {m.delivered < SAMPLE.insufficient ? "Insufficient sample" : m.delivered < SAMPLE.directional ? "Early directional signal" : "Comparable sample"}</p>
      </Section>

      <Section title="Funnel conversion">
        <ol className="max-w-md space-y-1">
          {funnel.map((st, i) => (
            <li key={st.key}>
              {i > 0 && (
                <p className="pl-2 text-xs text-muted-foreground tabular-nums">↓ {st.step === null ? "—" : `${Math.round(st.step * 100)}%`}{st.overall !== null ? ` · ${Math.round(st.overall * 100)}% of delivered` : ""}</p>
              )}
              <div className="flex items-baseline justify-between rounded-md border px-3 py-1.5">
                <span className="text-sm">{st.label}</span>
                <span className="text-lg font-medium tabular-nums">{st.count}</span>
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-3 max-w-[65ch] text-sm"><span className="font-medium">{diag.title}</span> <span className="text-muted-foreground">{diag.detail}</span></p>
      </Section>

      <Section title="Performance over time" description="One metric, by batch in send order.">
        <div className="mb-2 flex flex-wrap gap-1">
          {OVER_TIME_METRICS.map((x) => (
            <Link key={x.key} href={href({ metric: x.key })} className={`rounded-md border px-2 py-0.5 text-xs ${metric.key === x.key ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"}`}>{x.label}</Link>
          ))}
        </div>
        {series.filter((s) => s.rate !== null).length < 2 ? (
          <p className="text-sm text-muted-foreground">Trends appear once two or more batches have delivered sends.</p>
        ) : (
          <OverTimeChart points={series} />
        )}
      </Section>

      <Section title="Cohort comparison">
        {cohorts.length === 0 ? <p className="text-sm text-muted-foreground">No cohort has delivered sends yet.</p> : <GroupTable rows={cohorts} firstHeader="Cohort" hrefFor={(g) => href({ launch: g.key })} />}
      </Section>

      <Section title="Touch performance" description={<>Outcomes credited to the last touch before they happened. <Help text="A send earns the audit views, replies, and meetings that occur after it and before the next send to the same prospect." /></>}>
        {touches.length === 0 ? <p className="text-sm text-muted-foreground">Touch performance appears once sends occur.</p> : touches.length === 1 ? <><SendGroupTable rows={touches} firstHeader="Touch" /><p className="mt-2 text-xs text-muted-foreground">Follow-up performance will appear once Touch 2+ sends occur.</p></> : <SendGroupTable rows={touches} firstHeader="Touch" />}
      </Section>

      <Section title="Message strategy" description={<>By the strategy the data records today (initial vs follow-up). <Help text="A finer follow-up strategy (no-view reframe, competitor gap, authority mismatch…) is not recorded on drafts yet, so it is not reported." /></>}>
        {strategies.length === 0 ? <p className="text-sm text-muted-foreground">No sends yet.</p> : <SendGroupTable rows={strategies} firstHeader="Strategy" />}
      </Section>

      <Section
        title="Arm A vs Arm B"
        description={<>Link CTA vs reply CTA, classified from each sent body. <Help text="A link in the sent body is Arm A; no link is Arm B (reply CTA). Arm B recipients only get the link on request, so audit views under B lag by design — compare arms on replies first and open signal directionally." /></>}
      >
        {arms.length === 0 ? <p className="text-sm text-muted-foreground">No sends yet.</p> : <SendGroupTable rows={arms} firstHeader="Arm" showOpen />}
      </Section>

      <Section
        title="Template performance"
        description={<>By the versioned template stored on each sent draft. <Help text="Attribution survives copy changes — a copy change bumps the template version. Operator-written drafts carry no template and report separately. Positive replies come from recorded reply classifications." /></>}
      >
        {templates.length === 0 ? <p className="text-sm text-muted-foreground">No sends yet.</p> : <SendGroupTable rows={templates} firstHeader="Template" />}
      </Section>

      <Section title="Subject performance" description="Where open signal is most useful — still directional.">
        {subjects.length === 0 ? <p className="text-sm text-muted-foreground">No subject data yet.</p> : <SendGroupTable rows={subjects} firstHeader="Subject" showOpen />}
      </Section>

      <Section title="Prospect segments">
        <div className="mb-2 flex flex-wrap gap-1">
          {SEGMENT_DIMENSIONS.map((d) => (
            <Link key={d.key} href={href({ segment: d.key })} className={`rounded-md border px-2 py-0.5 text-xs ${dim === d.key ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"}`}>{d.label}</Link>
          ))}
        </div>
        {segments.length === 0 ? <p className="text-sm text-muted-foreground">No delivered sends to segment yet.</p> : <GroupTable rows={segments} firstHeader={SEGMENT_DIMENSIONS.find((d) => d.key === dim)?.label ?? "Segment"} />}
      </Section>

      <Section title="Send timing" description="Touch 1 sends by operator-local day and hour band.">
        {timing.length === 0 ? <p className="text-sm text-muted-foreground">No sends yet.</p> : <SendGroupTable rows={timing} firstHeader="Window" />}
      </Section>

      <Section title="Revenue economics">
        {per100 ? (
          <div>
            <p className="text-xs text-muted-foreground">Pipeline yield, normalized per 100 delivered prospects (actual rates, not observed counts).</p>
            <p className="mt-1 text-sm tabular-nums">{per100.map((y) => `${y.value} ${y.label}`).join(" → ")}</p>
            <p className="mt-2 text-sm text-muted-foreground">Revenue metrics will appear after opportunities have recorded values.</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Revenue economics will appear once opportunity values are recorded and at least {SAMPLE.insufficient} prospects are delivered.</p>
        )}
      </Section>

      <Section title="Evidence-based insights" description="Deterministic observations with their sample. Never causal; never a winner below the sample floor.">
        {found.length === 0 ? (
          <p className="text-sm text-muted-foreground">Insufficient sample — insights begin once two comparable groups each reach {SAMPLE.insufficient} delivered prospects.</p>
        ) : (
          <ul className="space-y-2">
            {found.map((i, idx) => (
              <li key={idx} className="rounded-md border px-3 py-2 text-sm">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">{i.confidence} · {i.kind}</span>
                <p className="mt-0.5">{i.title}</p>
                <p className="text-xs text-muted-foreground tabular-nums">{i.evidence}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
