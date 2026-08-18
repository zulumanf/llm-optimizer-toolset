# Spec 085 — Client Dashboard: The Four Questions

> Status: implemented — acceptance criteria verified 2026-08-17
> Depends on: spec 031 (portal), audit-page-design skill (dials pinned: trust-first, variance 3-4, motion 2-3), prospect-voice (copy rules), docs/04 type scale (enforced)
> Branch: feat/085-client-dashboard

## Why

The portal overview shows three equal tiles of raw percentages. A client
logs in with four questions — is it working; where do I stand against my
rivals; what are you doing for me; when do I hear from you next — and the
page answers none of them directly. The data for all four already exists.

## Design (inverted pyramid)

1. **Hero: the answer to "is it working?"** One stat, large by weight not
   size (type scale is law): the recommendation rate with its delta since
   the FIRST scored run — "Recommended in 12% of AI answers · up from 0%
   at baseline (Jul 30)". Sub-line: mentioned rate + first-position rate
   as quiet secondary stats. `text-destructive` only when the current
   value is the pain (0%); no decorative color.
2. **Market position: "you vs the rivals you lose listings to."** New
   `portalCompetitive` read: latest run's scored entities — client +
   top 5 tracked rivals by recommendation rate, horizontal bars
   (existing chart conventions, tabular-nums, sample size stated).
   Client row emphasized by weight. Empty state: "Rival tracking starts
   with the next benchmark."
3. **Trend with a takeaway.** The existing chart, plus one generated
   sentence of arithmetic (not narrative): "Recommendation rate moved
   0% → 12% across 6 measurements since Jul 30." Charts get captions.
4. **Latest delivered work (×3) + next measurement.** The top of the
   Work feed inlined with a "see all work" link; a cadence line — "last
   measured {date} · next scheduled {next Monday}" — computed from the
   baseline config's existence, "measurement paused" honesty otherwise.
   Latest published report linked when one exists.
5. **Shell polish (from the 2026-08-17 review):** active tab underline +
   `aria-current`; sign-out link in the portal header; methodology
   footnote reworded to plain language ("methodology version recorded
   with every number" — the exact string stays in reports).

All server-rendered, snapshot-of-now reads through the existing
deny-by-default portal service; no new client JS beyond zero; every number
keeps its sample size; PROHIBITED_PHRASES applies to all copy.

## Out of scope

Report rendering changes; client notifications/email; the Work tab beyond
the inline top-3; theming/branding pass (own decision later).

## Acceptance criteria

- [x] Hero shows current rate + delta vs the first scored run with dates;
      falls back honestly with one run (no delta) and zero runs (setup
      message) (integration on the service read + render).
- [x] Competitive section lists client + up to 5 rivals from the latest
      run with sample size; empty state without competitor scores
      (integration).
- [x] Cadence line: next-Monday when baseline configured, "measurement
      paused" when not (unit on the date math + integration).
- [x] Active tab is visually indicated with aria-current; sign-out link
      present (shell code; client-role GATING is pinned by the existing
      portal integration suite — e2e browses as staff preview under dev
      auth).
- [x] Type-scale/layout guards pass; portal pages stay phone-clean (the
      390px fence extended to /portal pages).

## Definition of done

Criteria pass · suites green (honest exits) · lint/typecheck clean ·
docs/05 line · demoed against the seeded client project.
