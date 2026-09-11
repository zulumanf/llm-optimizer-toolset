# Spec 137 — Autonomous, evidence-locked fulfillment lane (low-ambiguity positive replies)

> Status: implemented — default mode SHADOW
> Depends on: specs/129 (positive-reply report hand-off), 134 (private report access), 136 (evidence release verification), 127 (frozen Touch 1 evidence), 091 (Gmail send channel + outbox)
> Branch: feat/136-evidence-release-verification (stacked on spec 136)

## Goal
Fulfil a narrow class of positive replies ("Yes", "Send it", "Sure", "Show me", "I'd like to see it") without the founder being available, while making it structurally impossible for uncertain evidence to leave. Not an autonomous salesperson: pricing, scope, guarantees, objections, corrections, questions and hedges always escalate. The same foundation (one evidence package, one fact manifest, one release gate, one state machine, one artifact ledger) is what the private report, the positive-reply email and the future video walkthrough consume.

## Flow
```
positive reply (Gmail sync / hand-recorded, idempotent on gmail_message_id)
→ prospect_report_handoffs row (one per canonical reply; unique reply_id)
→ pending ──classifyForAutonomy──▶ autonomy_eligible | needs_review (ESCALATED_TO_FOUNDER: <reason>)
→ autonomy_eligible ──verifyEvidenceRelease (spec 136)──▶ evidence_verified | needs_review (EVIDENCE_RELEASE_BLOCKED: <codes>)
→ evidence_verified ──publishAudit over the frozen snapshot──▶ report_published
→ report_published ──fresh verdict → compileFactManifest → assertReportMatchesManifest
                     → renderReportDelivery(manifest) → lint + assertDeliveryMatchesManifest
                     → stage draft with send intent (approved, UNSCHEDULED)
                     → ONE adversarial review (fulfillment_release_review)──▶ qa_passed | needs_review (RELEASE_BLOCKED: …)
→ qa_passed ──releaseDecision(mode)──▶ release_ready (auto_verdict would_send | transmit) | needs_review (MANUAL_ONLY)
→ release_ready ──fulfillmentSendRecheck every tick; transmit only──▶ scheduled (scheduled_send_at on the outbox row)
→ scheduled ──existing dispatcher → sendProspectDraft (all gates + fulfillment_manifest_current)──▶ sent
```
`needs_review` leaves only by `reactivateHandoff` (founder; re-enters at `autonomy_eligible`) or a stop. `sent` and `stopped` are terminal. Every state write is `transition(from → to)` guarded by `LANE_TRANSITIONS` and `where status = <from>`; an illegal move throws.

## Reuse (no parallel truth)
- Workflow instance: `prospect_report_handoffs` (spec 129) — statuses extended, plus `lane_mode`, `autonomy_class/_reason`, `auto_verdict`, `manifest_id`, `release_verdict`, `claimed_at`, `reactivated_*`.
- Evidence: `MismatchEvidenceSnapshot` frozen on the delivered Touch 1 + `verifyEvidenceRelease` (spec 136: entities, relationships, production records/periods, frozen run, provider, completeness, denominator, primary = shadow counts, zero safety, corrections). No new evidence model.
- Report: `publishAudit` + `prospect_audits.snapshot.mismatch`; access via spec 134 invitations.
- Outbox / send intent: `outreach_drafts` (approved + `scheduled_send_at`) with new `send_intent_key` (unique) and `send_message_id`; the ledger stays `prospect_outreach_sends` (insert-only, new `reconciled_from`).
- Send path: `sendProspectDraft` (every gate re-runs at transmission), `drainScheduledSends` (claim → dispatch → finalize).
- Today: `positiveRepliesWaiting` now carries the lane's operator view.

## New (`lib/prospects/`)
- `reply-preprocess.ts` — `preprocessReply` (quoted history, our footer, signatures, legal trailers, autoresponder flag) and `classifyForAutonomy` (positive_interest ∧ short ∧ allowlisted form ∧ no exclusion vocabulary → `autonomy_eligible`, else `escalate` with a named reason). `autonomy-class-v1`.
- `fact-manifest.ts` — `compileFactManifest` (only from a VERIFIED verdict with known entity types on both sides), `FACT_*` ids with value + display + source, `derivedClaimFigures` reused for ratio/multiple/gap, `validatedSummarySentence` (compiled, cites fact ids; "roughly 44%", "12.5x as often"), `assertReportMatchesManifest`, `assertTextNumbersManifested`, `assertNoInternalFields`. Content-hashed (`manifestHash`) and evidence-hashed.
- `fulfillment-lane.ts` — modes (`SHADOW` default | `CANARY` % | `NARROW_AUTONOMOUS` | `MANUAL_ONLY`; kill switch holds in every mode), `LANE_TRANSITIONS` + `assertTransition`, `canaryBucket` (deterministic), `sendIntentKey` (prospect + reply + manifest hash + message type + template), `sendMessageIdFor` (RFC 5322 fingerprint), `operatorView`, `reactivateHandoff`, `fulfillmentMetrics`, `reconstructFulfillment`.
- `video-walkthrough-contract.ts` — `VideoWalkthroughInput` (prospect, market, evidencePackageId, factManifestId, manifest, approved examples/first action, report artifact ref, template/intro/voice versions), `compileVideoWalkthrough` → typed scenes (FounderIntro, ProspectTitle, ProductionComparison, RecommendationComparison, ExampleEvidence, FirstAction, Closing) + script lines with `factIds`/`approvedIds` + video fact manifest + content hash; `assertVideoMatchesManifest` (props QA, not OCR); `videoArtifactStale`. No renderer.
- `report-handoff.ts` — the lane itself (see Flow), `renderReportDelivery` v2 (manifest-fed), `assertDeliveryMatchesManifest`, `fulfillmentSendRecheck`, artifact ledger writes.

## Tables (migration 110)
`prospect_fact_manifests` (insert-only, unique prospect+manifest_hash) · `prospect_fulfillment_artifacts` (kind ∈ private_report | positive_reply_email | video_script | video_walkthrough | evidence_summary; revision; manifest_id; template_version; content_hash; status prepared/ready/stale/sent/superseded) · `outreach_drafts.send_intent_key` (unique) + `send_message_id` · `prospect_outreach_sends.reconciled_from` · `prospect_report_qa_runs.kind` += release_gate | manifest_assertion | release_review · handoff columns above. Down is tested.

## Effectively-once sends
1. The staged draft IS the durable intent (unique key; a retried or concurrent worker finds it — `prospect.fulfillment_duplicate_prevented`).
2. The dispatcher commits its claim before dispatch (spec 091).
3. The outgoing mail carries our own `Message-ID` (`<rf-<intent>@<sender domain>>`, plumbed through `channels.ts` → `email.send_approved_message` → `encodeMessage`).
4. A stale claim (worker died after Gmail may have accepted) is reconciled by `rfc822msgid:` search: found → ledger row written from the mailbox (`reconciled_from`), draft marked sent, no resend; not found → parked "safe to reschedule"; search failed → parked. Never a blind resend.
5. `sendProspectDraft` refuses a draft that already has a recorded send, and (new) any intent-bearing draft whose handoff is not `release_ready`/`scheduled` or whose recompiled manifest hash differs (`fulfillment_manifest_current`); artifacts are marked stale.

## Configuration
`AUTONOMOUS_POSITIVE_REPLY_MODE` (default SHADOW; legacy `REPORT_HANDOFF_AUTOSEND=true` ⇒ NARROW_AUTONOMOUS when the mode is unset), `AUTONOMOUS_POSITIVE_REPLY_CANARY_PERCENT` (default 10), `AUTONOMOUS_POSITIVE_REPLY_KILL_SWITCH=true` (no autonomous transmission in any mode). Promotion SHADOW → CANARY → NARROW_AUTONOMOUS is a founder-set env change, never automatic.

## Shadow success criteria (before CANARY)
A useful sample of qualified handoffs; zero material factual errors in held artifacts; zero wrong `autonomy_eligible` classifications (compare `auto_verdict = would_send` against what the founder actually sent); no duplicate actions; no gate bypass; founder agreement with the staged reply. No invented accuracy score — `fulfillmentMetrics` are row counts.

## Acceptance (tests)
Unit: `tests/unit/autonomy-reply-class.test.ts` (matrix 1–12), `fact-manifest.test.ts` (34–36, derived math, UNKNOWN fails closed), `fulfillment-lane.test.ts` (29–33, modes, canary, intent key, operator view), `video-walkthrough-contract.test.ts` (39–44), `report-handoff.test.ts` (template v2 + manifest assertion). Integration: `tests/integration/report-handoff.test.ts` (happy path + reconstruction, BLOCK review, SHADOW hold + hand send, unverified entity 13, kill switch + stop 32, escalation + reactivation 20/31, duplicate ingestion 24, concurrent workers 26/48 + one artifact revision 25, reconciliation 27/27b/28, correction after render 23/46, suppression 45, territory 47, canary + metrics). Entity/count/denominator/RealTrends cases 13–22 are the spec 136 suites the lane calls.
