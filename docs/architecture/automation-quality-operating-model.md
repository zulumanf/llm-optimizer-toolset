# Automation & Quality Operating Model

> 2026-07-29 · Companion to `specs/018` and `specs/019`.

## The operating contract

> Agents perform semantic labour. Deterministic services control calculations
> and state. The knowledge graph controls facts. The workflow graph controls
> work. The outcome graph controls learning. Independent QA controls quality.
> Permissions and approval gates control consequential actions. Humans handle
> strategy, exceptions, relationships, and accountability.

This is `PRINCIPLES.md` #6 and #8 expressed as machinery.

## Autonomy levels

Every workflow definition and every action type carries a level. The engine
enforces it: a node whose effective autonomy is ≤ 2 cannot transition to
`succeeded` without a matching `workflow_approvals` row.

| Level | Name | Meaning |
|---|---|---|
| 0 | Manual | The platform records the work; it does not prepare it. |
| 1 | Assisted | The platform researches or drafts; a human performs the action. |
| 2 | Approval required | The platform prepares the complete action; a human approves execution. |
| 3 | Autonomous, retrospective review | Executes automatically; recorded for review. |
| 4 | Autonomous by exception | Runs continuously; escalates only anomalies. |

**Target levels** (defaults shipped in `lib/workflow/autonomy.ts`):

| Action type | Level |
|---|---|
| benchmark execution, evidence capture, metric calculation | 4 |
| analytics ingestion, CRM ingestion, routine classification | 4 |
| weekly reporting, content opportunity detection | 4 |
| monthly report preparation, revenue attribution inference | 3 (with disclosure) |
| content drafting | 3 |
| low-confidence classification, executive recommendations | 2 |
| public profile correction, CMS publishing, ranking submission | 2 |
| journalist outreach, material client claims, privacy-sensitive actions | 2 |
| legal decisions | 0 |

Resolution order (most specific wins): `project + action_type` → `project +
workflow` → `workflow` → `action_type` default. A policy may only *lower*
autonomy below the shipped default without an admin role; raising it requires
admin and is audited.

## Quality gates

Six reusable gate types, all deterministic, all recording component-level
results into `quality_gate_results`. A gate returns `pass`, `fail`, or
`insufficient_evidence` — never a score to be interpreted.

| Gate | Fails when |
|---|---|
| **Evidence completeness** | required upstream nodes incomplete · sample below minimum · raw evidence missing · hash invalid · classifications missing · low-confidence rows not routed · partial failure undisclosed |
| **Claim verification** | a material claim lacks evidence · evidence stale past its review date · evidence quality below threshold · unresolved high-severity contradiction · non-approved wording · privacy status forbids use · missing date qualification |
| **Content quality** | claims unverified · primary intent unanswered · structure incomplete · methodology missing where required · sources not linked to claims · unsupported superlative · prohibited private information · brand requirement unmet · required compliance review absent |
| **Publication** | client approval missing · compliance approval missing where required · no preview · canonical URL missing · not indexable · structured data missing · internal links missing · metadata missing · analytics tagging missing · final artifact hash absent |
| **Attribution confidence** | no referral/self-report/CRM/identifier evidence for the claimed class · confidence undisclosed · inferred attribution labelled `confirmed` |
| **Executive reporting** | data period incomplete · sample sizes absent · fact not separated from interpretation · correlation stated as causation · material claim without evidence link · recommendation without rationale · risk/uncertainty undisclosed |

## Independent verification

The creator of an artifact may not be its final verifier — enforced by
construction, not by policy. The verifier node runs a **different agent
version** with a **fresh context** containing only:

- the proposed artifact or classification,
- the original evidence,
- the verification rubric,
- the applicable approved claims.

It is never given the creator's reasoning, preferred conclusion, self-
evaluation, or any statement that the artifact is believed correct.
`buildVerifierContext()` constructs the payload by allow-list, so a creator
field cannot leak in by accident.

Verdicts: `approved` · `approved_with_minor_corrections` · `rejected` ·
`insufficient_evidence` · `human_review_required`. Disagreement between creator
and verifier raises an exception rather than resolving itself.

## Adversarial QA

For consequential assets (risk level `high` or `critical`), an adversarial
review node asks a fixed set of questions: what might be false · what is
overstated · what evidence is weak · what would a competitor challenge · what
might mislead a client · what could create legal risk · what could create
reputational risk · what could disclose confidential information · what could
read as a guaranteed ranking · what attribution statement overclaims causality.

Unresolved `high` or `critical` adversarial issues block progress. There is no
override that is not an audited human decision.

## Exception-driven operations

The operator does not inspect every client every day. Every failure,
low-confidence result, conflict, expiry, and deadline becomes a
`workflow_exceptions` row with client, severity, type, evidence, related
workflow, recommended action, due date, owner, escalation path, status, and
SLA. One prioritised queue (spec 019) merges them across clients.

## Safe stopping

The system stops rather than guesses. `safely_stopped` is a distinct terminal
state, separate from `failed`, reached when:

- evidence is insufficient for the gate that must pass,
- confidence is below the routing threshold and no verification path exists,
- a cost cap would be exceeded,
- required client facts are missing (an agent must never invent them),
- an approval times out.

A safe stop always names its reason and produces an exception. That is the
difference between an automated system you can hand a client and one you
cannot.

## Measuring automation instead of asserting it

The targets below are **architectural intent**, not performance claims. The
platform instruments the achieved rate (`node_runs` settled without a human
transition ÷ total settled) per workflow, per client, per period, and reports
the measured number next to the target.

| Area | Target |
|---|---|
| Data collection & monitoring · benchmark execution · evidence capture | 95–99% |
| Routine classification | 90–97% |
| Reporting preparation · attribution ingestion | 90–98% |
| Reputation monitoring | 90–95% |
| Content preparation | 80–95% |
| Diagnosis & planning | 80–90% |
| Public execution | approval-controlled |
| Strategic prioritisation | human-approved |
| Client relationship management | human-led |
