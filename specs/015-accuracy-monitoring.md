# Spec 015 — Factual Accuracy Monitoring

> Status: done (2026-07-29)
>
> **Live result on the real pilot-client captures: 33 findings from 6 audited
> answers, 0 quotes rejected by the gate.** Five are high-severity
> `entity_confusion` — ChatGPT answers a "What is [the client]?" prompt by
> describing several unrelated same-name companies (a management
> consultancy, a cognitive-health wearable, a healthcare-claims platform)
> and an unrelated dictionary term. The rest are `unverifiable`: the model is
> *inventing* product capabilities ("stronger branding", "better mobile-first
> presentation", "you care about conversions more than just clicks",
> "I'd lean [the client]" for premium lead-gen) that no approved claim supports.
>
> Two honest observations from that run:
> 1. `unverifiable` is high-volume by nature on comparison answers (one
>    answer yielded ~8). Severity ordering and the status filter carry the
>    UI; the per-response cap is 12. If it proves noisy in practice, the
>    tuning lever is requiring a *specific* factual assertion (numbers,
>    features, affiliations) rather than any unsupported characterisation.
> 2. For a just-launched product these fabrications are strategically
>    interesting, not only risk: they show what the model *assumes* the client
>    is, which is a menu of positioning the client can choose to make true
>    and then evidence.
> Depends on: specs/008 (claims) · specs/013 (classifier v2) ·
> specs/010 (agent runner + gate pattern) · docs/06 · docs/15
> Branch: feat/015-accuracy-monitoring
> Priority: **P1** — Reputation Accuracy scored 40/100 in the audit and
> "factual-accuracy monitoring" was its largest MISSING capability.

## Goal
Answer the question clients feel most viscerally: **"what are AI assistants
getting wrong about us?"** — by comparing what captured answers actually
assert about the client against the client's *approved* claims, and turning
every discrepancy into an inspectable, evidence-backed finding.

## Why this and why now
The platform already stores the two halves and has never joined them:
immutable captured answers (spec 003) and an approved fact register
(spec 008). The live pilot captures contain textbook cases — answers that
describe an unrelated healthcare company, a consultancy, and a Sanskrit
term as the client — which is *reputation damage happening in the answer
layer*, invisible to visibility metrics because after spec 013 those
responses correctly produce no mention at all.

## Finding kinds (typed, deterministic severity)

| Kind | Meaning | Severity |
|---|---|---|
| `entity_confusion` | The answer presents a *different* entity as the client (same/similar name) | high |
| `contradicted` | An assertion conflicts with an approved claim | high |
| `outdated` | An assertion matches a *superseded* claim rather than the approved one | medium |
| `unverifiable` | A factual assertion about the client that no approved claim covers (may be true — we cannot confirm it) | medium |
| `missing_context` | The answer omits an approved fact that materially changes the picture (e.g. the client's category) | low |

Severity is assigned in code from the kind — never by the model — so the
correction queue's ordering is reproducible (same discipline as the gap
engine's opportunity scoring).

## Agent + gates
- One agent, `accuracy-monitor-v1` (`gpt-5.4-2026-03-05` — this reasons over
  claim/assertion consistency, where the flagship is worth the cost;
  registered in docs/13).
- Input: the response text, the prompt, subject identity (name, aliases,
  domain), **approved claims**, and superseded claim texts (for `outdated`).
- Output (Zod-validated): findings with a **verbatim quote** from the
  response, the kind, the claim it relates to (if any), and a rationale.
- **Deterministic quote gate** (the load-bearing safeguard, mirroring the
  content citation gate): every finding's quote must appear verbatim in the
  stored response text, else the finding is dropped and counted. A model
  cannot invent a problem that isn't in the evidence.
- Claim references must resolve to real approved/superseded claim ids;
  unresolvable references are stripped.

## Scope of what gets monitored
Per run, monitor responses that either (a) have a current mention of the
subject, or (b) came from a **branded** prompt (where the client is the
subject of the question, so a wrong answer matters even when the client is
never correctly mentioned). Errored captures are skipped. This keeps cost
proportional and targets the two places misinformation actually lands.

## Data model
Migration `012_accuracy_findings.sql`:
`accuracy_findings` — project_id, run_id, response_id, kind (check
constraint), quote, claim_id (nullable fk), rationale, severity, confidence,
agent_version, status (`open | acknowledged | dismissed | corrected`),
task_id (nullable — set when a correction task is created), created_at.
Unique on (response_id, kind, md5(quote)) so re-analysis is idempotent.

## Workflow
1. Operator runs "Analyze accuracy" on a scored run (same pattern as gap
   analysis).
2. Findings appear on `/projects/[id]/accuracy`, grouped by severity, each
   linking to the raw response (RAW EVIDENCE view) and the claim it
   contradicts.
3. Operator acknowledges, dismisses, or **creates a correction task** —
   which uses the existing evidence-backed task machinery, so the work is
   tracked and can be completed as a measured intervention.

## Acceptance criteria
- [ ] Analysis of the real pilot runs produces `entity_confusion` findings
      for the answers that describe the unrelated same-name entities, each quoting the actual
      sentence.
- [ ] A fabricated quote (not present in the response) is dropped by the
      gate; the drop is logged and counted, not silently ignored.
- [ ] Re-analysis is idempotent (no duplicate findings).
- [ ] Severity is derived in code; the same finding always sorts the same.
- [ ] A finding converts to a suggested task carrying response evidence.
- [ ] Findings never mutate the response or the claims (both immutable).
- [ ] Tests inject a caller (no network); lint, typecheck, tests green.

## Out of scope (named, not silently skipped)
Crawling third-party profiles (Zillow/LinkedIn/GBP) — that is the "public
profile audit" capability and needs spec 012 vertical packs; automated
re-checking after a correction ships (interventions already measure
visibility effects; accuracy re-check is a follow-up spec); and alerting —
there is no notification primitive yet (audit: shared gap).
