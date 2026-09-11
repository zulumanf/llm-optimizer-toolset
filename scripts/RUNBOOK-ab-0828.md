# Touch-2 reply-CTA A/B test — Wilmington, Friday 2026-08-28

**Question:** does removing the link unlock replies from people who open but
don't click? (Evidence: 9/14 Wilmington T1 recipients show opens on 8/25,
zero qualifying audit views.)

## Arms (8 prospects, balanced by open signal — each arm gets 2 human-timed openers)

| Arm | Prospect | Open signal (8/25) |
|---|---|---|
| A (link + trust lines) | Barrows and Associates | 2 opens, first 17m — human-timed |
| A | The Debbie Reed Team | 1 open, 51m — human-timed |
| A | Bryce Lingo & Shaun Tull Team | 1 open, 0m — scanner |
| A | Mary Beth Adelman | 0 opens |
| B (no link, reply-CTA) | The Crifasi Group | 3 opens, first 20m — human-timed |
| B | Steven Anzulewicz | 1 open, 258m — human-timed |
| B | First State Home Team | 2 opens, 0m — scanner |
| B | Toni & The Schrockstars Team | 0 opens |

Copy: `scripts/wil-t2-ab-drafts.json`. Arm A = current follow-up style with
naked branded URL + "nothing to log into, nothing to download". Arm B = no
URL; finding stated in body; CTA is reply "show me" → paste three transcript
answers into the thread. All counts match the QA-gated touch-1 bodies.

## Excluded / held (do not send)

- **Katina Geralis** — hard bounce 8/25, DNC + suppressed.
- **Brandon Murray, The Leslie Kopp Group, The Levy Group** — all Long &
  Foster: 3/3 brokerage sends used 8/25 (spec 052 cap). Eligible ~09/24.
- **Griffin Higgins Group** — Keller Williams Realty at 2/3 with Anzulewicz's
  T1; Anzulewicz's T2 takes the third slot (he showed a human open, Griffin
  none). Griffin eligible ~09/24.
- **The Lee Ann Wilkinson Group** (13 opens) — reserved for personal
  outreach/call; cap-eligible if a systematic send is preferred instead.
- Note: the JC "5 stalled at one touch" on the dashboard are ALL
  brokerage-cap-held until ~09/19 (see jc-followup-apply.ts) — the stalled
  metric doesn't know about policy holds yet.

## Commands (operator)

```bash
# tonight/anytime: create + approve (dry-run first, then --apply)
npx tsx scripts/wil-t2-ab-apply.ts --create --approve
npx tsx scripts/wil-t2-ab-apply.ts --create --approve --apply
# Friday morning: schedule 11:10 ET, 10-min stagger (8 sends by 12:20 ET)
npx tsx scripts/wil-t2-ab-apply.ts --schedule 2026-08-28T15:10:00Z --apply
```

Capacity check: Wed 8/26 city batch is 20 scheduled sends; Friday's 8 fit
the 25/24h Gmail cap with headroom.

## Measurement

- **Primary: replies within 72h**, recorded manually as stage changes (no
  reply ingestion exists — check the inbox Fri/Sat/Mon and record same-day).
- Secondary: qualifying audit views within 72h (auto; only meaningful for
  arm A — arm B has no link, a view there means they searched us out, which
  counts as a strong positive).
- n=4/arm is directional, not statistical. Decision rule: any replies in B
  with none in A → reply-CTA becomes default touch 2 and the test repeats on
  the city cohorts' T2 wave (~28 more prospects) for confirmation. Zero
  replies in both arms → the finding itself, not the CTA, is the suspect;
  rewrite the value proposition before the city T2s.
