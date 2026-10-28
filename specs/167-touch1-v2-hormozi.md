# Spec 167 — Touch 1 v2: outcome, candor, true scarcity, two-word reply

> Status: implemented (2026-10-28), not committed
> Depends on: specs/124, specs/150, prospect-voice skill, docs/15-pricing-policy.md
> Audience: PROSPECT (cold email). Copy follows prospect-voice hard lines.

## Why

Review against Hormozi's cold-outreach and offer principles: v1 was specific,
proof-led and low-friction, but stated no outcome, offered no candor about
variance, used no (true) scarcity, and asked "Want me to send them?" instead
of a two-word reply. Guarantees are out of scope: "guaranteed" is a
code-enforced prohibited phrase and any risk reversal needs an operator-approved
term (separate offer spec).

## Change (template `competitive_mismatch_reply_v2`)

After the unchanged comparison and implication line:

- **Candor + outcome + mechanism:** "Any single answer varies; the pattern
  across all {n} is the finding. These answers change slowly, so whoever fixes
  this first becomes the default recommendation in {market}."
- **True scarcity + two-word CTA:** "I work with one client per market. If you
  want the exact questions and the side-by-side, reply "show me". It's a
  five-minute read." (One retained client per market: pricing policy.)

No new numbers; every count is still from the frozen evidence. Subject unchanged.

## Version safety

Draft QA, follow-up enrollment and analytics matched `prompt_version` to the
single current version, so a bump would have skipped v1-era checks for v2
drafts. `MISMATCH_TEMPLATE_VERSIONS` + `isMismatchTemplate()` now cover v1 and
v2 everywhere (`draft-qa.ts`, `followups.ts`, `acquisition-facts.ts`,
`campaign-ledger.ts`). Deploy before any v2 draft is scheduled.

## Rollout

Wednesday 2026-10-28 batch stays v1 (control); the Thursday batch is
regenerated on v2 after deploy. Compare reply rates per template version.

## Phase 2 (separate spec)

Quote one real seller question and the answer naming the competitor (needs
per-question evidence in the review plus evidence-release verification).

## Acceptance criteria

- [x] v2 body rendered exactly (unit test) and free of prohibited phrases.
- [x] v1 and v2 recognised by QA, follow-up enrollment and analytics.
- [x] Full suite, lint and typecheck pass.
