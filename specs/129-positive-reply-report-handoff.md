# Spec 129 — Positive-reply report handoff (generate → multi-QA → deliver)

> Status: done
> Depends on: specs/127 (sequence, reply ledger), 128 (private report v2, reply_to drafts), 077 (sense-check agent), 091 (gmail dispatch)
> Branch: feat/129-followup-copy-v2

## Goal
When a competitive-mismatch prospect replies "yes", the private report they were promised is generated from the SAME frozen Touch 1 evidence, checked three ways (deterministic evidence QA, an LLM review from the real-estate agent's point of view, the existing sense-check agent), and, only if every check passes, delivered as a threaded reply within minutes during the recipient's waking hours. Anything short of a clean pass parks the handoff for the founder with the reason. No human step sits between "yes" and the report unless a check fails.

## Reuse (no parallel system)
`prospect_replies` + `classifyReplyText` (trigger), `outreach_followup_sequences` (frozen evidence, timezone, actor), `publishAudit` (report generation, existing warning/ack gates), `mismatchBlockForProspect` (the report's content), `ensureAuditLink`/`brandedAuditUrl` (the link), `runAgent` + `AUTOMATION_PROMPTS` + `TASK_ROUTES` (agents), `audit_sense_check` prompt (second agent), `outreach_drafts.reply_to_id` + `threadingForReply` + `drainScheduledSends` + `sendProspectDraft` (delivery, threading, gate, ledger, cap), `transitionStage` (→ `audit_sent`), `lintFollowupCopy` (delivery copy lint), `prospect_activities`/`audit_log`.

## Database changes (migration 103)
- `prospect_report_handoffs`: one row per positive reply. `prospect_id`, `reply_id` (unique), `sequence_id`, `audit_id` (set when published), `draft_id` (set when the delivery draft exists), `status` (`pending | report_published | qa_passed | scheduled | sent | needs_review | stopped`), `reason`, `attempts`, `actor_id`, timestamps.
- `prospect_report_qa_runs` (insert-only): `handoff_id`, `kind` (`deterministic | prospect_review | sense_check`), `content_hash`, `passed`, `output` jsonb, `agent_version`, `model`, `error`, `created_at`.

## Pipeline (worker tick, after the follow-up pass; idempotent per row)
1. **Enqueue**: every `positive_interest` reply with a `gmail_message_id` on a prospect that has a follow-up sequence and no handoff row → `pending`.
2. **Guards** (each failure → `stopped`/`needs_review` with reason): autosend switch on; no later `unsubscribe`/`not_interested` reply; contact/prospect not DNC; not suppressed; a delivered mismatch Touch 1 exists.
3. **Report**: reuse a published audit whose frozen `mismatch` block states the sequence's exact evidence; else `publishAudit`. The ONLY publish warning the automation may acknowledge is the incomplete-run warning ("The benchmark run is incomplete…"), with a recorded reason — the mismatch counts use captured answers only. Any other refusal (stale benchmark, rank-tracks-visibility, already-recommended, dead link, sense-check concern) → `needs_review`.
4. **QA 1 — deterministic** (`qaMismatchReport`): block present; the report addresses the prospect the way RealTrends records them ("you" for an individual agent, "your team" for a team — the narrative and page are entity-aware from this spec on; older frozen reports fail this check and need a republish); prospect/competitor names, counts, denominator, production equal the frozen snapshot; `assistant` is the provider label (never bare "ChatGPT"); no prohibited phrases, no AEO/GEO/LLM/prompt/benchmark jargon, no placeholders/NaN/undefined in any prospect-visible string; ≥ 1 competitor excerpt; diagnosis, priorities and note non-empty; distinct-question counts consistent with the question rows.
5. **QA 2 — prospect review agent** (`report_prospect_review`, frontier tier): reads the report serialized in page order as a busy top-producing agent who knows nothing about AI. Returns `verdict` (`send | fix`), `concerns[]` (severity `blocking | polish`; area `clarity | relevance | jargon | numbers | tone | structure | missing`), `firstImpression`, `topQuestion`, `confidence`, `confidenceNote`. Pass = `send`, no `blocking`, confidence ≥ 0.6.
6. **QA 3 — sense-check agent**: the existing `audit_sense_check` prompt over the same serialization. Pass = no `concern`-severity finding, `overallReadsFair`, confidence ≥ 0.6.
7. **Delivery draft** (`mismatch_report_delivery_v1`, deterministic): greeting `{first},` / "Here it is: {branded URL}" / one observation from the frozen evidence (distinct questions, top neighborhoods when present) / one question / "If so, there are a couple things in the results I'd look at first." / signature + postal/opt-out. Lint = follow-up linter with exactly one URL allowed (the branded link). `reply_to_id` = the positive reply; approved as the sequence's enroller; `scheduled_send_at` = now + 4–12 min when 07:00–20:00 recipient-local, else 08:00–08:30 next local morning (weekends allowed: it answers a question they asked).
8. **Send**: the existing drain transmits it (reply_to drafts drain first; the gate threads it under the prospect's message via `threadingForReply` and refuses without a thread). The tick marks the handoff `sent` when the draft has a recorded send and moves the prospect to `audit_sent`.
9. Every agent call and its verdict is a `prospect_report_qa_runs` row; a failed LLM call is a failure row, never a pass.

## Operator surface
The follow-up sequence card/table shows the handoff state: `REPORT_NOT_GENERATED`, `QA_FAILED`, `NEEDS_REVIEW (reason)`, `SCHEDULED (local time)`, `SENT`. `scripts/report-handoff.ts [--dry] [--prospect <id>]` runs the pipeline for one prospect without/with writing.

## Kill switch
`REPORT_HANDOFF_AUTOSEND=false` stops step 7/8 (reports still generate and QA; the handoff parks `qa_passed` for a human send).

## Acceptance criteria
- [ ] A recorded `positive_interest` reply produces exactly one handoff; re-running the tick never duplicates work.
- [ ] The report published for the handoff states the frozen Touch 1 competitor, counts and denominator; a mismatch fails deterministic QA.
- [ ] Both agents run on the same content hash; any `blocking`/`concern` finding, low confidence or LLM failure parks the handoff as `needs_review` with no draft created.
- [ ] Only the incomplete-run warning is ever auto-acknowledged.
- [ ] The delivery draft threads under the prospect's reply, carries exactly one link (the branded report URL), no em/en dash, one question, and is refused by the gate if the reply's Gmail thread cannot be resolved.
- [ ] A later unsubscribe/not-interested reply, DNC or suppression stops the handoff before any send.
- [ ] After transmit the prospect is `audit_sent` and the handoff `sent`.

## Test cases
`tests/unit/report-handoff.test.ts`: serialization determinism, deterministic QA (drift, jargon, placeholders, provider label), delivery template + lint (one URL, agent/team wording, dashes), delivery window, agent-output gates. `tests/integration/report-handoff.test.ts`: yes → handoff → publish (real) → QA with stubbed agents → scheduled reply_to draft → drain (mock channel) → `sent` + `audit_sent`; failing agent parks; later unsubscribe stops; autosend off parks at `qa_passed`.
