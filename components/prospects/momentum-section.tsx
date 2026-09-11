/**
 * Momentum section (spec 119): the input scoreboard. Did we do the work —
 * sends today against the quota, the streak, the 30-day activity chart,
 * follow-up depth, and draft throughput. Volume metrics are all-cohort
 * (effort is global); touch depth and replies-by-touch follow the selected
 * cohort like every other Operate section. Server component; hand-rolled
 * SVG in theme ink like the rest of the cockpit — identity is carried by
 * lightness + mark shape + the legend, never hue alone.
 */
import { Section, Stat, StatGrid } from "@/components/layout/page";
import { byTouch, SAMPLE } from "@/lib/prospects/analytics";
import {
  medianHoursToFirstReply,
  quotaStreak,
  touchDepthDistribution,
  type Momentum,
  type MomentumDay,
} from "@/lib/prospects/momentum";
import { OPERATOR_TIMEZONE, type ProspectIntent } from "@/lib/prospects/intent";

const fmtHours = (h: number): string => (h < 1 ? "<1h" : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);

const dayLabel = (day: string): string => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};

function DailyChart({ days, quota }: { days: MomentumDay[]; quota: number }) {
  const W = 720, H = 190, PAD_X = 30, PAD_TOP = 14, PAD_BOT = 22;
  const plotW = W - 2 * PAD_X, plotH = H - PAD_TOP - PAD_BOT;
  const maxY = Math.max(quota, ...days.map((d) => Math.max(d.firstTouch + d.followUps, d.replies))) * 1.1;
  const y = (v: number) => PAD_TOP + plotH - (v / maxY) * plotH;
  const slot = plotW / days.length;
  const barW = Math.max(4, slot - 3);
  const x = (i: number) => PAD_X + i * slot + (slot - barW) / 2;
  const cx = (i: number) => PAD_X + i * slot + slot / 2;
  const replyPath = days
    .map((d, i) => `${i === 0 ? "M" : "L"}${cx(i)},${y(d.replies)}`)
    .join(" ");
  // Label Mondays so a 30-day axis stays readable.
  const labeled = days
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => {
      const [yy, mm, dd] = d.day.split("-").map(Number);
      return new Date(Date.UTC(yy!, mm! - 1, dd!)).getUTCDay() === 1;
    });
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-3xl" role="img" aria-label="Sends and replies per day, last 30 days">
        <line x1={PAD_X} y1={y(0)} x2={W - PAD_X} y2={y(0)} className="stroke-foreground/20" />
        {/* quota reference */}
        <line x1={PAD_X} y1={y(quota)} x2={W - PAD_X} y2={y(quota)} strokeDasharray="4 4" className="stroke-foreground/30" />
        <text x={PAD_X} y={y(quota) - 4} textAnchor="start" className="fill-muted-foreground text-[10px] tabular-nums">
          quota {quota}
        </text>
        {days.map((d, i) => {
          const total = d.firstTouch + d.followUps;
          return (
            <g key={d.day}>
              <title>
                {`${dayLabel(d.day)} — ${d.firstTouch} first-touch, ${d.followUps} follow-up${d.followUps === 1 ? "" : "s"}, ${d.replies} repl${d.replies === 1 ? "y" : "ies"}${d.refused > 0 ? `, ${d.refused} refused` : ""}`}
              </title>
              {/* hover target for the whole day column */}
              <rect x={PAD_X + i * slot} y={PAD_TOP} width={slot} height={plotH} className="fill-transparent" />
              {d.firstTouch > 0 && (
                <rect x={x(i)} y={y(d.firstTouch)} width={barW} height={y(0) - y(d.firstTouch)} rx={1.5} className="fill-foreground/75" />
              )}
              {d.followUps > 0 && (
                <rect x={x(i)} y={y(total)} width={barW} height={Math.max(0, y(d.firstTouch) - y(total) - 2)} rx={1.5} className="fill-foreground/35" />
              )}
            </g>
          );
        })}
        {days.some((d) => d.replies > 0) && (
          <path d={replyPath} fill="none" strokeWidth={1.5} className="stroke-foreground" />
        )}
        {days.map((d, i) =>
          d.replies > 0 ? <circle key={`r-${d.day}`} cx={cx(i)} cy={y(d.replies)} r={3} className="fill-foreground stroke-background" strokeWidth={1.5} /> : null
        )}
        {labeled.map(({ d, i }) => (
          <text key={`l-${d.day}`} x={cx(i)} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">
            {dayLabel(d.day)}
          </text>
        ))}
      </svg>
      <figcaption className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-foreground/75" /> First touch</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-foreground/35" /> Follow-up</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-0.5 w-3 rounded bg-foreground" /> First replies (recorded stage changes)</span>
        <span>All cohorts · days in {OPERATOR_TIMEZONE.replace("America/", "").replace("_", " ")}</span>
      </figcaption>
    </figure>
  );
}

export function MomentumSection({
  momentum: m,
  prospects,
  cohortName,
  quota,
}: {
  momentum: Momentum;
  prospects: ProspectIntent[];
  cohortName: string;
  quota: number;
}) {
  const today = m.days[m.days.length - 1];
  const sentToday = today ? today.firstTouch + today.followUps : 0;
  const streak = quotaStreak(m.days, quota);
  const last7 = m.days.slice(-7);
  const sent7 = last7.reduce((n, d) => n + d.firstTouch + d.followUps, 0);
  const followUps7 = last7.reduce((n, d) => n + d.followUps, 0);
  const reply = medianHoursToFirstReply(prospects);
  const depth = touchDepthDistribution(prospects);
  const touches = byTouch(prospects);
  const t = m.throughput;
  const quotaMet = sentToday >= quota;

  return (
    <Section
      title="Momentum"
      description="Did we do the work? Volume and streak count every cohort — effort is global."
    >
      <StatGrid columns={4}>
        <Stat
          label="Sends today"
          value={`${sentToday} / ${quota}`}
          hint={quotaMet ? "quota met — keep going" : `${quota - sentToday} more to hit today's quota`}
        />
        <Stat
          label="Quota streak"
          value={`${streak} day${streak === 1 ? "" : "s"}`}
          hint="consecutive business days at quota; weekends don't break it"
        />
        <Stat
          label="Sent (7 days)"
          value={String(sent7)}
          hint={sent7 > 0 ? `${Math.round((followUps7 / sent7) * 100)}% follow-ups · ${t.refused} refused by the gate` : "no sends in the last 7 days"}
        />
        <Stat
          label="Median time to reply"
          value={reply.hours === null ? "—" : fmtHours(reply.hours)}
          hint={reply.n > 0 ? `first send → first recorded reply · n=${reply.n} · ${cohortName}` : "no recorded replies yet"}
        />
      </StatGrid>

      <div className="mt-5">
        <DailyChart days={m.days} quota={quota} />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-sm font-medium">Follow-up depth · {cohortName}</p>
          {depth.contacted === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">No contacted prospects yet — depth appears after the first send.</p>
          ) : (
            <>
              <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground tabular-nums">
                {depth.rows.map((r) => (
                  <li key={r.depth}>
                    <span className="text-foreground">{r.prospects}</span> at {r.depth}
                    {r.prospects > 0 ? ` · ${r.replied} replied` : ""}
                  </li>
                ))}
              </ul>
              {depth.stalledAtOne > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{depth.stalledAtOne}</span> stalled at one touch with a follow-up already due — the cadence says these are under-worked.
                </p>
              )}
            </>
          )}
        </div>
        <div>
          <p className="text-sm font-medium">Replies by touch · {cohortName}</p>
          {touches.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">Appears once sends occur.</p>
          ) : (
            <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground tabular-nums">
              {touches.map((row) => (
                <li key={row.key}>
                  {row.label}: <span className="text-foreground">{row.reply.n}</span> repl{row.reply.n === 1 ? "y" : "ies"} of {row.delivered} delivered
                  {row.delivered >= SAMPLE.insufficient && row.reply.rate !== null ? ` (${Math.round(row.reply.rate * 100)}%)` : " · small sample"}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <p className="mt-4 text-xs text-muted-foreground tabular-nums">
        Throughput (7 days, all cohorts): {t.created} draft{t.created === 1 ? "" : "s"} created → {t.approved} approved → {t.sent} sent · {t.refused} refused by the send gate
        {t.medianApprovalHours !== null ? ` · median draft → approval ${fmtHours(t.medianApprovalHours)}` : ""}
        . The smallest number is this week&apos;s constraint.
      </p>
    </Section>
  );
}
