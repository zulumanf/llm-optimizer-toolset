# Automation Safety & Autonomy

The operating rules for anything the platform does without a human in the loop.
Companion to `docs/architecture/automation-quality-operating-model.md` (which
defines the levels) and `docs/10-security.md`.

## Autonomy levels

| Level | Name | The system… | The human… |
|---|---|---|---|
| 0 | Manual | records and supports | does the work |
| 1 | Assisted | researches and drafts | decides and executes |
| 2 | Approval required | prepares the exact action | approves before execution |
| 3 | Autonomous, retrospective review | executes and records | reviews after the fact |
| 4 | Autonomous by exception | runs continuously | is called only for anomalies |

Resolution order (`lib/workflow/autonomy.ts`, extended by this work):

```
node override  →  client+workflow policy  →  client+action-type policy
→  connector policy  →  workflow default  →  risk-based floor
```

The **risk-based floor** cannot be raised past by any policy: a `critical`-risk
action never resolves above level 2, and a legal/privacy action type never
resolves above 0. A policy that tries is rejected at write time with a
classified error, not silently clamped at read time.

## Default policies

| Action | Default | Rationale |
|---|---|---|
| Benchmark execution | 4 | Measurement, no external effect |
| Evidence capture | 4 | Insert-only, immutable |
| Metric calculation | 4 | Deterministic and reproducible |
| Analytics ingestion | 4 | Read-only |
| CRM read synchronisation | 4 | Read-only |
| Routine classification | 4 | Above confidence floor, verified |
| Low-confidence classification | 2 | Below floor ⇒ a person decides |
| Weekly internal reporting | 4 | Internal audience |
| Client reporting publication | 2 | Leaves the building |
| Content drafting | 2 | Becomes a public claim |
| CMS draft creation | 3 | Not public yet |
| CMS public publishing | 2 | Public and attributable to the client |
| Prospect first outreach | 2 | First impression, unrecoverable |
| Approved follow-ups | 3 | Content already approved |
| Profile correction | 2 | Represents the client to a third party |
| Journalist outreach | 2 | Reputational exposure |
| Ranking submission | 2 | Factual assertions to an external body |
| Billing reminders | 4 | Standard, from an approved schedule |
| Billing dispute | 0 | Commercial relationship |
| Legal or privacy decision | 0 | Never automated |

Configurable by tenant, client, workflow, node, action type, risk level,
connector and user role — within the floor above.

## External-send checklist

Every outward-facing action passes all seven, in order, and a missing check
fails **closed**:

1. **Sender authorisation** — the connection is active, scoped, unrevoked, and
   belongs to this client.
2. **Recipient authorisation or business purpose** — a recorded relationship or
   an explicit, logged legitimate-interest basis.
3. **Suppression** — global do-not-contact, per-client suppression, bounce and
   opt-out lists. Checked on the normalised value, so casing and plus-addressing
   cannot slip past.
4. **Approval requirement** — resolved autonomy satisfied by an approval row,
   or a policy that explicitly permits.
5. **Tenant match** — run project == connection project == recipient record
   project.
6. **Message version** — the exact artifact version that was approved is the
   one sent. A changed draft invalidates its approval.
7. **Compliance fields** — sender identity, unsubscribe path, and consent basis
   present.

`assertSendAllowed()` implements this and is the only path to a send
capability. It is tested for each failure mode individually.

## Suppression

`suppression_entries` is global and append-only. Sources: explicit opt-out,
hard bounce, complaint, client request, legal request, manual operator entry.
Matching is on a normalised value (lowercased email with plus-tags stripped for
matching only; E.164 for phone; registrable domain for domain-level
suppression). Removing a suppression is an admin action with a reason and an
audit row — and never removes the historical entry.

## Stop conditions

Sequenced outreach stops immediately and permanently on: reply, opt-out, hard
bounce, meeting booked, client request, or manual stop. Each is a recorded
terminal state on `outreach_sequences`, not the absence of a next step. A
sequence in a stopped state cannot be resumed; a new sequence must be created,
which forces a fresh decision.

## Content claim rules

No public asset may assert "best", "top", guaranteed results, undocumented
sales volume, or confidential transaction detail unless a verified claim with
current evidence and the required approvals exists. The claim-verification gate
blocks publication; it does not soften the language and proceed. Softening
would hide that we could not support the statement.

## Test mode

A test run may not send email, publish content, create an invoice, or mutate a
CRM record. It records what *would* have happened, with the exact payload, in
the would-have-happened ledger, which the test-run inspector shows. Records a
test run creates are tagged and excluded from every client-facing query.
Production and test runs are distinguished at the database level
(`workflow_runs.mode`), not by convention.

## Data minimisation for agents

- An agent sees only its run's client scope. There is no cross-client agent
  context, ever.
- `allowedDataScopes` on the agent definition is an allowlist; anything not
  listed is withheld.
- Credentials are never in scope, and structurally cannot be — an agent node's
  `NodeContext` has no accessor.
- PII goes into a prompt only when the task requires it and the client's
  configuration permits it; the lead-classification agent, for example,
  receives a normalised business profile, not a raw form submission.
- Protected or sensitive personal characteristics are never inferred. The lead
  and reply classification schemas have no field for them, which is a stronger
  guarantee than a prompt instruction.

## Incident handling

| Event | Response |
|---|---|
| Credential compromise suspected | Revoke connection → rotate → replay health checks → audit review of every call in the window |
| Wrong recipient contacted | Suppress → stop sequence → exception at `critical` → operator review before any further send for that client |
| Published content found unsupported | Unpublish request → claim marked disputed → contradiction row → correction workflow |
| Cross-tenant access detected | Hard failure at the boundary, `tenant_scope_violation` exception, run safe-stops; this is treated as a defect, not an operational event |
| Runaway cost | Cost cap safe-stops the run before spending; `cost_anomaly` exception |

## What is deliberately never automated

Legal decisions, privacy decisions, pricing, contract changes, service
suspension, billing disputes, complaint handling, performance guarantees, and
any statement of causality that the evidence does not support.
