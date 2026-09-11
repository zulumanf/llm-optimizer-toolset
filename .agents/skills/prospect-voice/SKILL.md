---
name: prospect-voice
description: Copywriting rules for anything a PROSPECT might read — audit pages, outreach drafts, exhibits. Load before writing or editing prospect-facing text. The platform's no-fabrication rules made operational.
---

# Prospect-facing voice

The reader is a successful real-estate agent who gets pitched daily, gives a
cold link five seconds, and assumes every vendor chart is cherry-picked.
Every rule here exists because it survived that reader.

## Hard lines (never cross — some are code-enforced)

1. **No fabricated losses.** `PROHIBITED_PHRASES` in
   `lib/prospects/constants.ts` bans "lost/losing revenue", "costing you",
   "missed commissions", "losing/lost deals", "guaranteed", hype words —
   and `findProhibitedPhrase` gates outreach approval on it. Apply the same
   standard to page copy even where no gate runs.
2. **Every number is a receipt.** Counted from captured answers, cited from a
   sourced signal, or arithmetic on the prospect's own record (say which:
   "$18.32M across 31 sides, per the sourced record above"). Never an
   estimate, projection, or industry stat without an operator-verified
   source + URL + date.
3. **"Not measured" over zero.** Absence of data is never rendered as a bad
   score.
4. **Absences need total proof.** "You never appear" is only claimable next
   to the complete-transcripts appendix. An excerpt can prove presence,
   never absence.
5. **Nothing invented, ever** — no placeholder names, imagery, or "realistic"
   demo data on evidence surfaces (this overrides any design-skill advice).

## What persuades this reader

- **Their vocabulary, not ours**: referrals, listing appointments,
  introductions — never "visibility optimization" or "SEO for AI".
- **Counted moments beat projected dollars**: "35 recommendations; 0 were
  you; here's who buyers heard instead" out-hits any invented loss figure,
  and can't be attacked.
- **Their own numbers do the dollar work**: average sale from their volume ÷
  sides; we assert no loss rate — their deal size makes one lost introduction
  feel expensive.
- **A specific moment stings more than a rate**: "we asked 'Who should I use
  to sell a brownstone in Downtown Jersey City?' — the answer sent them to
  Compass" (pull real seller-side prompts from the data).
- **Candor is a trust signal, said out loud**: "Counted fairly: …", "Any
  single answer varies — the pattern is the finding", "skepticism welcome".
  Show moments where the prospect DID appear when they exist; all-negative
  reads as a trick.
- **Urgency through mechanism, not pressure**: answers change slowly; whoever
  fixes it first becomes the default recommendation; compounding does the
  rest.

## Structure and CTA

- **Punchline first**: the whole story in the first screen (the five-second
  read); depth folds below for the second read.
- **Two-word reply ask**: reply "show me" — styled as a chip, repeated top
  and bottom, matching the outreach email's ask. State what replying gets
  them and how long it takes (15 minutes).
- **Sign it**: prepared-by name, date, report id. Anonymous analysis reads
  as spam.
- Plain sentences, sentence case, no exclamation marks, no "Elevate /
  Seamless / Unleash / game-changer".
