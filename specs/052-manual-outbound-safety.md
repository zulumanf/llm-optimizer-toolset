# Spec 052 — Manual Outbound Safety (queued)

**Status:** Queued — do not start until spec 051 is done.
**Source:** Architecture gap audit 2026-08-09 (growth/security findings). Goal: make *manual* outbound safe and truthful without waiting for the automated acquisition engine.

Scope (to be specified fully before implementation):
1. **Evidence-bound prospect audits:** snapshot numbers carry response/score IDs; `humanFinding`/`adoptionStat` require publisher + URL + date (spec 045 as written) and pass `findProhibitedPhrase`; publish warnings that indicate a disqualified pitch require an explicit recorded override.
2. **Compliant sender setup:** `APP_URL` required before any draft is created; sender identity model (name, company, physical postal address) configured once and force-appended to the opt-out footer; the prospect send path routed through the unified `assertSendAllowed` gate (tenant match, approval-hash binding, suppression, unsubscribe).
3. **Suppression/opt-out:** reply-based opt-out recorded same-day into the suppression list as SOP; per-person and per-brokerage re-contact guard (not just per-prospect).
4. **PII deletion:** a deletion path for prospect contacts (erasure request → suppression tombstone + PII columns nulled via a sanctioned, audited operation), retention clock, and documented reconciliation with the raw-data immutability principle (measurement data is not PII; contact PII is deletable).
5. **Territory re-checks:** exclusivity conflict re-check inside the send gate (not only at `outreach_ready`); `reserved`/`pending_proposal` agreement states; signing a new agreement sweeps and blocks conflicting in-flight drafts.
6. **Client access revocation:** portal grants revocable from the product; `users.active` settable by an admin.
