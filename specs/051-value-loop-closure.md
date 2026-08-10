# Spec 051 — Value Loop Closure (queued)

**Status:** Queued — do not start until spec 050 is done.
**Source:** Architecture gap audit 2026-08-09 (F11, F19, F24, F26, F28, F43).

The retest verdicts the platform exists to produce never reach the client, and the loop
intervention → live verification → retest → verdict → evidence → client report has three breaks.

Scope (to be specified fully before implementation):
1. **Surface verdicts:** render the snapshotted `SnapshotProgram` (gap findings, interventions, measured verdicts) in the published report HTML, and replace the portal's literal "Shipped — remeasured on schedule" with the computed verdict. "Did it work" must be answerable from the portal.
2. **Causal-language gate on the client path:** apply the existing `CAUSAL_PHRASES` linter (today executive-brief-only) to report narrative at publish; numberless causal prose must no longer pass the evidence gate.
3. **Live verification:** on `markPublished`/intervention creation with URLs, fetch each URL (via `safeFetch`) and record verified-live status; accuracy findings stop self-certifying `corrected` at task creation — add an in-progress state, corrected only on verification.
4. **Intervention lifecycle fields:** owner, approval, cost, status; populate `action_outcomes.intervention_id` on the product path so learnings can cite real intervention verdicts.
5. **Delivery:** a minimal report delivery mechanism (email with link or attached PDF) behind operator approval.
6. Delta table shows sample sizes; `first_position_rate` joins the noise-verdict metric set.
