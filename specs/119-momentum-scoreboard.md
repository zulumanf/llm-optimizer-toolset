# Spec 119 — Momentum scoreboard (input-first prospecting view)

Status: implementing
Branch: feat/119-momentum-scoreboard

## Why

The cockpit (095→101) measures output quality rigorously but effort not at
all: there is no daily-volume view, no quota, no visibility of follow-up
depth, refused sends, or draft→approve→send throughput. Operating philosophy:
track the inputs the operator controls (sends/day against a commitment)
before optimizing outputs; find the throughput constraint; follow up to full
depth. Reply/bounce ingestion stay out of scope (spec 118 and a future spec) —
this spec only surfaces what the ledgers already record.

## What

A **Momentum** section at the top of the Operate tab (after the today strip),
all-cohort (effort is global), plus two small additions elsewhere. No new
tables, no writes — derive-on-read like everything else in the cockpit.

1. **Input scoreboard.** Sends today vs `DAILY_SEND_QUOTA` (new constant,
   env-overridable, default 15; the Gmail cap 25 remains the hard limit) ·
   quota streak in business days (Mon–Fri, operator TZ; weekends neither
   count nor break) · follow-up share of sends (7d) · refused sends (7d) ·
   median time to first reply.
2. **Daily activity chart** (last 30 operator days, hand-rolled SVG per the
   existing OverTimeChart pattern, theme tokens only): stacked bars of
   first-touch vs follow-up allowed sends (identity by lightness + legend),
   a quota reference line, and a replies line (first recorded reply per
   prospect, by day). Native `<title>` tooltips per day; weekly axis labels.
3. **Touch depth.** Contacted prospects by max touch (1 / 2 / 3+), with the
   count stalled at touch 1 past the follow-up cadence; replies-by-touch
   reuses `byTouch` (analytics.ts) so Operate finally answers "do follow-ups
   work?" — with the existing sample labels.
4. **Throughput (7d).** drafts created → approved → sent counts, median
   approval latency (30d), refused sends count. Shows the constraint;
   no verdict prose, numbers only.
5. **Elsewhere:** cohort section footer gains median time-to-first-reply
   (n≥LATENCY_MIN_SAMPLE) beside the existing time-to-first-view.

## How

- `lib/prospects/momentum.ts`: one sequential set of queries (pooler-safe,
  same reason as machineHealth): daily sends by touch ordinal
  (`row_number() over (partition by prospect_id order by sent_at)`), daily
  refusals (`allowed = false`), daily first replies from stage history,
  draft throughput from `outreach_drafts` timestamps. Days grouped by
  `sent_at at time zone OPERATOR_TIMEZONE`.
- Pure, unit-tested helpers exported: `fillDailySeries`, `quotaStreak`,
  `touchDepthDistribution`, `medianHoursToFirstReply`.
- `components/prospects/momentum-section.tsx` server component; page wires
  it with data fetched alongside the existing queries.

## Acceptance

- Operate tab shows the Momentum section with scoreboard, chart, touch
  depth, and throughput; page still renders with zero sends (empty states).
- Streak logic: weekend days are skipped, a sub-quota business day resets,
  today counts only once quota is met.
- Refused sends are visible for the first time (count, 7d).
- Unit tests for the four pure helpers pass; lint + typecheck clean.
- No schema changes; no new persisted metrics; all-cohort numbers ignore
  the cohort filter (labeled as such).
