# Knowledge Compilation & Context Engineering

> 2026-07-29 · Companion to `specs/020`–`specs/025`. Extends
> `docs/architecture/graph-native-platform-architecture.md`; does not replace it.

## The problem this layer solves

An agent that re-reads raw material every time it works is expensive, slow, and
— worse — unpredictable. Two runs over the same 200-page source can surface
different facts. The fix is not a bigger context window. It is to convert source
material into structured knowledge **once**, compile that knowledge into concise
pages, and hand each task exactly the slice it needs.

```
raw artifacts
  → parsing & normalization
  → entity & claim extraction
  → evidence linking
  → contradiction detection
  → verification & approval
  → canonical knowledge & evidence graph      ← the only authority
  → knowledge compiler
  → client wiki + hot files                   ← concise, generated, traceable
  → task-specific context builder
  → agent harness
  → workflow graph
  → evidence-driven verification loops
  → approved execution
  → action-to-outcome learning
```

## Five layers, four storage models

| Layer | Question it answers | Storage |
|---|---|---|
| Raw | "What did the source actually say?" | content-addressed files in `var/knowledge/` + `source_artifacts` |
| Canonical | "What are we allowed to believe?" | Postgres relations |
| Wiki | "What does an agent need to read?" | `wiki_page_versions` rows (Markdown + structured JSON) |
| Instructions | "How may this knowledge be used?" | `knowledge_instruction_versions` rows |
| State | "Where did the work get to?" | **already built** — `workflow_runs`, `node_runs`, signals, approvals |

These are not five directories. The raw layer needs bytes, so it uses files. The
canonical layer needs joins, constraints and transactions, so it uses relations.
The wiki needs version identity and provenance foreign keys, so it uses rows —
not files, because a file on disk is editable and an editable artefact that
reads as authoritative is the failure mode this whole layer exists to prevent.

## Why the state layer needed nothing

Spec 018 already built it. `workflow_runs` carries the current node, attempt
counts, completed steps, pending approvals, cost and time consumed, retry
history and safe-stop reasons; `node_runs` is keyed by `(run, node, fan_key)`,
which *is* the idempotency guarantee; `workflow_signals` resumes a durable human
wait. Nothing here reinvents that, and no compiled page stores task state.

Conversation history is not memory. Operational memory is the canonical graph,
the compiled wiki, workflow state, action history, outcome history and approved
instructions. A conversation summary may support a task; it never overrides a
canonical record, and an agent never writes to long-term memory directly.

## The dividing line, restated

`graph-native-platform-architecture.md` draws the deterministic/semantic line
once. This layer sits on the same side of it:

**Deterministic:** which claims are approved · privacy filtering · freshness
computation · contradiction rules · dependency resolution · build ordering ·
hashing · token budgeting · packet validation · every database write.

**Semantic:** extracting candidate claims from prose · phrasing a compiled
summary · judging whether a proposed claim is supported · interpreting evidence.

An agent proposes; deterministic code decides. The compiler's optional
summarization step receives an already-selected fact set and returns prose that
is validated sentence-by-sentence against that set. A sentence introducing an
unsupported fact fails the build. Compilation runs fine with no provider key —
summarization is opt-in per template.

## Why compiled pages are not authoritative

Three enforcement points, none of them a convention:

1. `wiki_page_versions` carries a `forbid_mutation()` trigger. Rows cannot be
   edited or deleted.
2. The compiler is the only writer, and it reads canonical records exclusively.
3. There is no code path from the wiki UI to `claims`. A human annotation is a
   separate, labelled record; proposing it as canonical routes it through the
   normal claim → evidence → approval path.

A page is a *rendering*. Deleting every page and rebuilding loses nothing.

## Retrieval: structural, not similarity-only

Selection is deterministic for everything that governs what an agent may say —
identity, approved claims, instructions, methodology, the named entities and
date range, privacy filtering. Retrieval (Postgres full-text + entity traversal
+ freshness + evidence quality) only ranks *supporting* material: prior assets,
similar transactions, market context, competitor evidence.

There is no vector index. `pgvector` is not in this stack, and the rules that
matter here are structural — client scope, category, entity, date, privacy,
freshness — not similarity-shaped. Adding an embedding store would add a
dependency, a sync problem and a staleness failure mode without changing which
claims a drafting agent is permitted to use. Revisit when a measured retrieval
evaluation (spec 025) shows lexical recall is the binding constraint.

## Token reduction is a consequence, not a goal

The reason to compile is determinism and traceability. Fewer tokens is a
by-product. This codebase reports measured numbers only: an offline counter
compares raw-document, full-wiki, hot-file and packet modes over fixtures at
zero cost. Accuracy and human-correction deltas require a live run and are
reported as *not measured* until one happens. No savings figure is asserted that
the counter did not produce.

## Seams with the three graphs

- **Knowledge graph** gains an intake (raw layer) and an output (compiler). Its
  authority is unchanged.
- **Workflow graph** consumes packets through `dom.build_evidence_packet`, which
  now takes a template. Nodes still never query the knowledge graph directly.
- **Action-to-outcome graph** is a dependency type: a completed action marks
  `active-actions` and `recent-changes` stale.
