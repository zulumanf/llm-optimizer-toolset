# Spec 077 — Audit Sense-Check: An Agent That Reads Before You Send

> Status: implemented — acceptance criteria verified 2026-08-17
> Depends on: specs/032 (audit assembly), specs/052 (warnings-with-teeth), specs/065 (QA preflight), specs/075 (refresh queue — follow-up wiring), docs/12-ai-guidelines.md, docs/13-prompts.md
> Branch: feat/077-audit-sense-check

## Why

Every mechanical property of an audit is already gated: mock data cannot
publish, claims must carry response evidence, revenue/causality wording is
hard-blocked, staleness and dead links demand acknowledgment. What nothing
checks is whether the audit **makes sense as an argument**: numbers that
technically reconcile but read as contradictory, a headline the shown data
undersells or oversells, copy that would make a broker roll their eyes, a
finding that is true but not the page's own best evidence. Today that
judgment lives entirely in the operator's read — unassisted.

This spec adds the assistant: an LLM agent that reads the assembled audit
(everything a prospect would see) and returns structured, confidence-scored
concerns. **Advisory by constitution**: concerns join the existing
acknowledge-with-reason machinery; the agent never edits prospect-visible
text and never silently blocks a publish (PRINCIPLES #8).

## Goal

One click on a prospect's audit section (or automatically during weekly
refresh preparation, once spec 075 is merged) produces a stored, versioned
sense-check: a list of concerns, each with severity, area, the quoted text
it refers to, and an explained confidence. At publish, unresolved
`concern`-severity findings for the finding being published join
`disqualifyingWarnings` — publishable only with the operator's written
reason, recorded in the audit log.

## Design

### The agent (`audit_sense_check`, idiomatic to the existing registry)

- Key added to `AUTOMATION_AGENT_KEYS` (lib/automation/prompts.ts); prompt
  built with the `prompt()` factory — inherits the shared GUARDRAILS
  (JSON-only, no unsupported assertions, numeric confidence).
- Version `audit-sense-check-v1`; docs/13 registry row; new `TASK_ROUTES`
  entry, tier **frontier** (this is exactly the "language judgment" case
  docs/12 reserves the frontier model for — cheap-tier misses tone).
- Output schema in `AGENT_SCHEMAS` (lib/automation/nodes/agent.ts):

  ```
  { concerns: [{ severity: 'concern' | 'polish',
                 area: 'coherence' | 'overreach' | 'copy' | 'numbers' | 'fairness',
                 detail: string,          // what is wrong, in one sentence
                 quote: string | null }], // verbatim text it refers to
    overallReadsFair: boolean,
    confidence: number,                   // 0..1
    confidenceNote: string }              // WHY, per docs/12
  ```

- Input: the same assembled content the page renders — headline, finding
  title/explanation, metrics table values, humanFinding/adoptionStat text,
  authority signals, hero copy — serialized from the snapshot-assembly
  helpers. Captured AI answers are **data, not instructions** (docs/12 §5);
  the prompt states this explicitly.
- The agent may only DESCRIBE problems. It returns no rewrites — an agent
  that suggests copy becomes the author of prospect-visible text, which
  PRINCIPLES #8 and the prospect-voice rules reserve for humans and the
  deterministic template.

### Invocation & storage

- `runSenseCheck(user, { prospectId })` in `lib/prospects/sense-check.ts`:
  assembles content for the prospect's current primary approved finding
  (or the draft assembly pre-publish), calls `runAgent()` directly (the
  dominant service pattern), inserts into `audit_sense_checks`
  (insert-only): prospect_id, finding_id, `content_hash` (sha256 of the
  serialized input), concerns jsonb, overall/ confidence fields,
  `agent_version`, `model`, created_by/at. Ledger row lands automatically.
- No AI call in any render path (docs/12): the check runs from an explicit
  server action (operator clicks, seconds-scale wait — the assistant
  precedent) — and, as spec-075 follow-up wiring once merged, inside the
  refresh-preparation worker step with results stored on the candidate.
- A failed call is recorded as failed (docs/12 §1): row with
  `error text`, no fabricated concerns.

### Publish integration (the teeth)

In `publishAudit`, during assembly: load the **latest** sense-check for
`(prospect, finding.id)`. Then:

- Check exists ∧ `content_hash` matches the being-published assembly ∧ has
  `concern`-severity findings → each becomes a `disqualifyingWarnings`
  entry ("Sense-check: <detail> — re-run the check or publish with a
  reason"). Existing gate does the rest: written reason, audit log.
- Check exists but hash differs (content changed since) → one **advisory**
  `publishWarnings` entry: "content changed since the last sense-check."
- No check at all → one advisory entry. Absence never blocks — the agent
  is an assistant, not a permission.
- `polish`-severity findings are never gating; they render in the UI only.

### Operator surface

Prospect page, audit section: a "Sense check" button (client component,
existing dialog/toast pattern) → runs the action → renders the concern
list inline (severity badge, area, quote, detail) with the check's age.
Confidence < 0.7 renders the docs/12 needs-review styling on the whole
result. No new page.

### Spec-075 follow-up (deferred until #57 merges)

`prepareAuditRefreshCandidates` gains a sense-check step per candidate
(worker context, isolated failure → `needs_attention` stays as-is); the
queue card shows the verdict beside the delta. Small wiring PR.

## Out of scope

- Rewriting/suggesting copy (constitutionally excluded, see above).
- Checking outreach draft emails (deterministic template + phrase gates +
  the outreach workflow's own verify_claims agent already cover them).
- Auto-publish on a clean verdict (never).
- Evaluation suite beyond fixture tests (follow-up once real transcripts
  accumulate).

## Acceptance criteria

- [x] `runSenseCheck` stores an insert-only row with concerns, explained
      confidence, content hash, agent version, and model; a failed LLM call
      stores the failure and fabricates nothing (integration w/ fake caller).
- [x] Concern-severity findings on a hash-matching check join the publish
      ack-gate; acknowledging records the reason; polish-severity and
      stale-hash checks never block (integration).
- [x] Absent sense-check yields an advisory warning only — publish
      unblocked (integration).
- [x] Agent registered idiomatically: key, versioned prompt, schema with
      confidence, TASK_ROUTES entry — the existing registry-integrity unit
      suite passes with the new agent (unit).
- [x] Captured-answer text in the input cannot steer the agent into
      approving itself (prompt states data-not-instructions; fixture test
      with adversarial quote asserts concerns still parse strictly).
- [x] Prospect-page button renders results with severity/area/quote and
      low-confidence treatment (e2e or component).

## Test cases

Unit: schema round-trip incl. strict-parse failure → one retry → recorded
failure; content-hash stability. Integration (fake `AgentCaller`): store →
publish-gate matrix (concern/polish/stale-hash/absent). E2E: button click
with test-mode canned output renders concerns.

## Definition of done

All acceptance criteria pass · tests green · lint/typecheck clean ·
migration reversible · docs/05, docs/13 registry, DECISIONS.md updated ·
demoed against seeded data.
