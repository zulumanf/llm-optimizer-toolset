# Spec 150 — Pre-send outreach hardening

> **Status:** implemented (2026-10-03). Not deployed.
>
> **Audience:** internal operators. It changes what a prospect may receive: some emails that would have sent now refuse.
>
> **Why:** the first controlled production draft test (Spec 149, 2026-10-03) produced three Jersey City drafts. Two of them were factually wrong in ways no gate caught:
> - one quoted a finding from a 49.7-day-old benchmark;
> - one named Perplexity, which returned 0 valid answers.
>
> Reply-first copy also pasted audit-page prose, used raw provider ids and called an individual agent a team. The sender postal address in production is "Brooklyn, NY". This spec closes those gaps without new features, LLM calls or migrations.

## Rules

1. **Freshness comes from the finding's own run.** The chain is finding → `benchmark_id` → `prospect_benchmarks.run_id` → run. Each link must exist and belong to the draft's prospect. The finding must still be `approved`, the run must be `completed` or `partial`, and it must have `completed_at` no older than `MISMATCH_THRESHOLDS.maxBenchmarkAgeDays` (14).
   - A newer benchmark linked to the same prospect never makes an older finding fresh.
   - Any failure is refused, never warned.
2. **Providers are named only if they produced valid evidence.** A provider counts only if it has at least one valid answer (`error is null`, non-empty text) in the finding's run. Copy uses prospect-readable names (`providerDisplayName`). An unknown provider id, or a run with no valid evidence, fails closed.
3. **Reply-first copy is built from structured fields:** counts, competitor names and signal labels. It never pastes `finding.explanation`. Unknown finding kinds or missing data fail closed.
4. **Entity wording follows the prospect's type.**
   - Reply-first: `individual_agent` reads as "agents", `team` as "teams", `brokerage` as "brokerages", anything else as "real estate firms".
   - Mismatch Touch 1: reuses the follow-up wording ("you" / "your team"). The source is the frozen RealTrends entity level, falling back to `prospect_type`; if neither resolves, the draft falls back to the reply-first template.
5. **The sender postal address must be complete.** This is a conservative structural check, not legal validation: at least two comma- or line-separated parts, and the first part must contain a number (street number or PO Box). "Brooklyn, NY" fails. The check runs when the identity is saved, when a draft is created, at approval, at scheduling and at send.
6. **Leaked copy is refused at approval and at send:**
   - raw lowercase provider ids;
   - audit-page framing ("Both measurements are shown with their sources", "the contrast is the observation");
   - snake_case or JSON labels;
   - `{placeholder}` tokens;
   - an individual addressed as a team, or a team as "You:".
7. **Audit expiry: existing policy, unchanged and now tested.** A body linking an audit that expires within 7 days, or links an audit no longer published, refuses at approval and at send. Expiry dates are never extended automatically.
8. **No exemptions for existing drafts.** These checks live in `qaDraft`, which `approveOutreachDraft`, `sendProspectDraft` and therefore the scheduled drain already run. A draft approved or scheduled before this spec is re-checked at transmission and refused if it fails.

**Scope of rules 1, 2 and 6 (provider names only):** cold first-touch drafts, meaning no `sequence_id`, `reply_to_id` or `send_intent_key`. Follow-ups, replies and fulfillment drafts already have their own evidence gates (specs 127, 128, 137).

## Acceptance

- [x] A finding from a 5-day-old run passes. A finding from a 49-day-old run fails even when the prospect has a 4-day-old run.
- [x] A missing run, a missing timestamp, a foreign benchmark or a foreign finding each fail.
- [x] A stale finding blocks draft creation, approval and send of an already-approved or scheduled draft.
- [x] A configured provider with 0 valid answers is never named; one-provider evidence produces one-provider wording; raw ids never appear.
- [x] Audit-only prose and placeholders refuse.
- [x] An individual is never called a team, and team wording stays correct.
- [x] "Brooklyn, NY" and an empty address fail; a complete address passes.
- [x] A previously approved send that becomes invalid refuses at transmission.
