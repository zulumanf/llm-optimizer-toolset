# Spec 139 — Report copy at the template layer + video-dependent release (Kirsch Team hold)

> Status: implemented — Laura Kirsch held (WAITING_FOR_VIDEO), nothing sent
> Depends on: specs/128 (private report), 137 (fulfillment lane), 138 (video walkthrough lane)

## Goal
Fix the customer-facing report wording the spec 137 adversarial reviewer blocked on — at the reusable template layer, not per prospect — so the report passes semantic QA without the founder's acceptance; and make a handoff's release depend on a releasable personalized video walkthrough under the configured policy, without ever auto-sending when the video finishes.

## Copy (template layer)
- Headline: "RealTrends has {ref} ahead. In our test, {competitor} was recommended more often." (was "AI recommends…").
- Figure 01 title: "Production vs recommendation frequency"; table/row labels "Recommended in the test".
- Change section (`changeFirstRows`): "Bring {yours} profiles on those sites in line…" / "profile pages for {ref} (including the lead agent's team pages)" / "confirmed at the start of the work" (no "audit").
- "How to read this report" caption: "a point-in-time review of a defined set of AI answers".
- Neighborhood row: "{areas}, if those areas matter to you" / "state your team's sales there plainly…" (was "areas you want to win"). Context questions: "which parts of {market} matter most to you". Founder's note: "If the real-world numbers had favored {competitor}, there would be nothing unusual to point out." / "What stood out is that your production record…". "What it may mean" hypotheses are observations plus what to check ("the answers alone do not say why").
- Section intro: "What I observed in the answers, the smallest change I'd look at first, and how to run the same test again afterwards to compare."
- Product name stays "Private AI recommendation report".

## Reviewer calibration (policy, not per prospect) + deterministic lint
Reviewer v3/v4 (`fulfillment-release-review-v4`): a blocker is an ASSERTION (stated cause, promised/predicted outcome, consumer-ChatGPT generalization); the reviewer re-reads its own quote for hedges; named non-blockers: a change paired with a before/after re-run of the same test, hedged hypotheses under "Why this may be happening", a one-sentence walkthrough offer, quoted saved answers (evidence, judged only for leaks). The deterministic half, `lintReportAssertions`, runs in the handoff's deterministic QA before any model: asserted causes about recommendations, promised outcomes, guarantees, rank claims and consumer generalizations block in code; hedged/negated sentences and the founder's note are exempt. Regression fixture: the corrected template narrative passes; asserted examples fail.

## Entity-aware wording (deterministic)
`entityRef(entityType)` → team: your team / your team's / is; individual: you / your / are; brokerage: your brokerage / your brokerage's / is; unknown reads as team. The MEASURED entity is always the production-record business; the recipient's name appears only in the greeting. `serializeReportForReview` (what the reviewer reads) mirrors the page.

## Founder acceptance, bound to the artifact
`reactivateHandoff(…, { acceptReviewConcerns: true })` records the blocked review's content hash; `reviewOverrideFor(handoffId, hash)` honours it only for that exact email+report content. A revised report or email is reviewed again. Evidence and assertion blocks are never acceptable.

## Release policy (`FULFILLMENT_RELEASE_POLICY`)
`report_and_video` (default, fail closed) | `report_only`. Under report_and_video:
- `qa_passed` holds with reason `WAITING_FOR_VIDEO: …` until `videoReleasableFor(handoffId)` — the video lane's own `videoReleaseRecheck` (stage release_ready, status ready, bound to the handoff's manifest, passed script/semantic/artifact QA, not delivered, release switch open) — says yes. Consultable while the handoff is held (one additive option on the video lane's function).
- When releasable: the email is re-staged as the video variant ("I put together a quick walkthrough along with…"; one destination, the report embeds it), the report-only draft is superseded (never deleted), the new email is asserted and reviewed again, and only then does the release policy run — SHADOW/canary/kill switch still decide. VIDEO_READY never sends by itself.
- A `release_ready` handoff whose video is not releasable steps back to `qa_passed` (new legal transition) — Laura's case.
- Send-time: `fulfillmentSendRecheck` refuses under report_and_video unless the video is releasable AND the draft is the video variant (`send_intent_key` carries the variant). Re-entrancy guard: the video lane's binding check calls the recheck; the inner call runs manifest checks only.

## Laura Kirsch (prospect 233a34db, handoff 55e1539c)
Draft 09d355fb unscheduled via `cancelScheduledSend` (draft + audit trail intact, approved, unscheduled). Evidence unchanged: team / 2 / 25 / 256, manifest 1ac49fc2. Report republished on the corrected template (revisions 5effc539 → d2f7033a → 43480a38 → aadfcf25 → aa4c56cc published; earlier ones superseded, nothing delivered). Reviewer v4 PASSED aa4c56cc with no founder acceptance (release_gate, deterministic incl. assertion lint, manifest assertion, release_review all true). Staged email re-staged as draft 18efc19c (report-only variant, approved, unscheduled); 09d355fb superseded. Held at `qa_passed` WAITING_FOR_VIDEO; when the video lane reports release-ready, the lane re-stages the video variant and holds `release_ready` (SHADOW, would_send) for the founder.

## Tests
`tests/unit/report-copy-entity.test.ts` (1–7, 11–12), `fulfillment-lane.test.ts` (policy default, transition), `tests/integration/report-handoff.test.ts` (hold + gate refusal 13, re-stage under SHADOW with no send 18/19, acceptance bound to hash 9/10, one manifest across report/email/video 14/16).
