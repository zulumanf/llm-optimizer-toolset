# Spec 127 — Competitive-mismatch follow-up sequence (Touch 2 / Touch 3)

> Status: done
> Depends on: specs/091 (gmail dispatch), 099 (cadence, unattended gate), 116 (draft QA), 124 (mismatch template, reply ledger)
> Branch: feat/127-mismatch-followups

## Goal
Prospects who received a `competitive_mismatch_reply_v1` Touch 1 get at most two deterministic follow-ups (Touch 2, Touch 3) over the same frozen evidence, on a business-day cadence in recipient-local mornings, with a human reply, bounce, DNC, suppression or OOO stopping the sequence. The KPI is human replies per delivered, never opens.

## Reuse (no parallel system)
`outreach_drafts` (unit of approval + dispatch), `prospect_outreach_sends` (ledger), `sendProspectDraft` (gate v2), `drainScheduledSends` (worker), `qaDraft` (QA), `prospect_replies` + `classifyReplyText` (reply ledger), `suppress` (suppression), gmail connector (`email.send_approved_message`, `email.read_thread`), `outreach_email_opens`, `summarizeEngagement`, `businessDaysBetween/addBusinessDays` (intent.ts), `GMAIL_DAILY_SEND_CAP`, market timezone via `markets.state_code`.

## Database changes (migration 099)
- `outreach_followup_sequences`: one row per (prospect, experiment). Frozen: `touch1_draft_id`, `touch1_send_id`, `contact_id`, `evidence_snapshot` (copied from the T1 draft), `competitor_company_id`, `distinct_competitor_questions` (computed once from the frozen run), `timezone`. State: `status` (active | paused | replied | stopped | complete), `stop_reason`, `paused_until`, `next_touch` (2 | 3 | null), `next_due_at`, `last_touch_send_id`, `enrolled_by`.
- `outreach_drafts` + `sequence_id`, `touch_number`, `branch`, `parent_send_id`, `engagement_state_at_dispatch`.
- `prospect_outreach_sends` + `gmail_thread_id`.
- `prospect_replies` + `gmail_message_id` (unique, nullable) for idempotent ingestion.

## Engagement state (deterministic, evaluated at render ≤ 20 min before dispatch and again at dispatch)
Priority: REPLIED → STOPPED → OOO_PAUSED → MEANINGFUL_ENGAGEMENT → NO_MEANINGFUL_ENGAGEMENT.
- Open signal class: `scanner` = UA null or exactly `Mozilla/5.0`; any open inside `SCANNER_WINDOW_SECONDS` (600 s) of the send is a scan; else `credible`.
- MEANINGFUL: ≥ 2 credible opens ≥ 10 min apart, OR 1 credible open + `summarizeEngagement(...).meaningfullyEngaged` on an attributed audit view.
- Everything else is NO_MEANINGFUL_ENGAGEMENT.

## Cadence
- T2 due = 3 business days after T1 `sent_at`; T3 due = 4 business days after T2 `sent_at`. Business day = Mon–Fri and not a U.S. federal holiday (observed), in the recipient timezone.
- Slot = first business-day morning ≥ due at 09:00 + deterministic offset (3–88 min from a hash of the sequence id) recipient-local.
- Human approval (PRINCIPLES #8): enrollment is the human confirmation; the enroller is recorded as `approved_by`/`scheduled_by` on every touch draft, and the worker renders the branch from the frozen snapshot only.

## Branches / templates
`competitive_mismatch_t2_no_engagement_v1` (new thread, subject `{first} — one thing I found`), `competitive_mismatch_t2_engaged_v1` (reply in T1 thread; "several questions" variant only when `distinct_competitor_questions ≥ 3`, else safe fallback), `competitive_mismatch_t3_engaged_v1`, `competitive_mismatch_t3_no_engagement_v1` (reply in most recent thread). Copy in `docs/13-prompts.md`.

## Pre-dispatch safety (fail closed)
Gate check `followup_preflight`: sequence active and not paused; no `prospect_replies` after the parent send; contact not DNC; reply sync (`connector_connections.last_sync_at` of the gmail connection) fresh within `FOLLOWUP_REPLY_SYNC_MAX_AGE_MINUTES`; live read of every sequence thread shows no inbound message after the last outbound; engagement state unchanged since render; `qaDraft` passes.

## Reply ingestion
`syncProspectReplies()` on every worker tick: gmail `email.search_messages` for inbox mail from ledger recipients (last 30 days) and from mailer-daemon; records via `recordProspectReply` (idempotent on gmail message id); bounces mark the contact DNC (`hard_bounce`) and stop the sequence.

## Acceptance criteria
- [ ] Enrolling the delivered T1 cohort creates exactly one sequence per prospect; re-running is a no-op.
- [ ] A recorded human reply, bounce, DNC, suppression or exit stage stops the sequence before any further send.
- [ ] OOO reply pauses until the parsed return date + 1 business day, else 7 days.
- [ ] Branch is decided at render time from opens/views; a single ambiguous open is NO_MEANINGFUL_ENGAGEMENT.
- [ ] T2/T3 bodies carry the frozen T1 competitor, counts, denominator and production; QA + copy linter block drift, placeholders, buzzwords, URLs.
- [ ] Preflight failures park the draft; Gmail errors fail closed.
- [ ] After T3 the sequence is `complete`; no fourth touch is ever created.
- [ ] Caps: follow-ups count toward `GMAIL_DAILY_SEND_CAP`; brokerage cap counts distinct prospects.

## Amendment 2026-09-04 — copy v2, expiry, reply safety (no migration)
- Templates bumped to `*_v2` (docs/13-prompts.md): Touch 2 = the pattern ("came up across N different questions", N = frozen distinct count ≥ 3, else the side-by-side), Touch 3 = why you ("the numbers looked backwards"). No call ask, no links, one CTA, ≤ 120 words, no em/en dash, no ChatGPT by name.
- Entity wording: "you" / "your team" from the RealTrends entity level behind the frozen production record (`prospectEntityType`); unknown → render fails closed.
- Report truthfulness: "private report" may appear only when a PUBLISHED audit whose frozen mismatch block states this exact evidence exists (`reportReadyFor`); otherwise "the exact questions and answers pulled together".
- Expiry: `FOLLOWUP_MAX_SEQUENCE_AGE_DAYS` = 21 calendar days from the successful Touch 1 → `complete` ("expired"); a deferred slot past it is never queued.
- Reply safety: an all-quoted or redacted body strips to "" → `unclear` → sequence `replied` with "needs review" (display `REPLY_NEEDS_REVIEW`), no suppression. Our own footer never classifies a reply.
- Positive reply → `founder_action_required` activity + `handoff` on the operator view (`READY_TO_SEND` / `REPORT_NOT_GENERATED`). Report generation and delivery stay founder-run.
- Threading: an in-thread touch whose parent send has no Gmail thread id is refused.
- Dispatch priority: human replies (`reply_to_id`) → due touches → cold Touch 1.

## Test cases
`tests/unit/followups.test.ts` (business days/holidays/tz slots, engagement classifier, templates, claim gate, linter, branch selection), `tests/integration/followups.test.ts` (enroll/no-dup, stops, OOO pause, preflight fail-closed, T3 completes).
