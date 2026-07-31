# Spec 024 — Incremental Knowledge Rebuilds

> Status: done (2026-07-30)
> Depends on: specs/020, specs/023, specs/018 (queue + events)
> Branch: feat/018-graph-execution-control-plane

## Goal

Make knowledge compilation behave like an incremental software build: a changed
claim rebuilds the pages that depend on it and nothing else, an unchanged output
produces no new version, and a crash mid-build cannot leave two active versions
of a page.

## Gaps

Nothing compiled exists, so nothing tracks what a compiled artefact depends on.
Without dependency tracking the only options are "rebuild everything on every
change" (expensive, and it churns version history with no-ops) or "rebuild
nothing" (stale knowledge entering packets silently).

## Data model (migration `022_knowledge_wiki.sql`, with the wiki tables)

```sql
knowledge_builds(
  id, project_id NULL, trigger, trigger_ref,
  status, requested_pages integer, compiled integer, no_op integer,
  failed integer, duration_ms, cost_micro_usd,
  started_at, finished_at, error, created_by)

knowledge_build_items(
  id, build_id, page_id, status, reason,
  previous_version_id, new_version_id,
  content_hash, token_count, duration_ms, error)     -- insert-only

knowledge_build_manifests(                            -- immutable
  id, build_id, manifest jsonb, manifest_hash, created_at)
```

`trigger` ∈ `event | manual | maintenance | initial`.
Build item `status` ∈ `compiled | no_op | failed | skipped`.

## Dependency graph

`wiki_page_dependencies` (spec 023) is written by the compiler from each page
template's declared `dependencies(context)`. Dependency types:

`entity · claim · claim_version · evidence · source_artifact · transaction ·
prompt_cluster · visibility_measurement · action · outcome · methodology ·
instruction · competitor · market · neighborhood`

Declaring dependencies inside the template — the same function that selects the
data — is what keeps the graph correct. A template that reads a claim it did not
declare fails a unit test that diffs declared dependencies against the records
the selection actually touched.

## Dirty detection

A canonical change marks pages stale rather than rebuilding inline:

```
domain event arrives
→ map event → (dependency_type, dependency_id)
→ select page_ids from wiki_page_dependencies matching
→ mark those pages stale with a reason
→ enqueue a knowledge build job for the affected set
```

Event → dependency mapping:

| Event | Marks stale |
|---|---|
| `claim.approved`, `claim.superseded`, `claim.expired` | pages depending on that claim or its entity |
| `claim.conflict_detected`, `claim.conflict_resolved` | those pages plus `open-risks` |
| `source.ingested` | pages depending on that source's entities |
| `instruction.updated`, `instruction.expired` | pages depending on that instruction |
| `transaction.verified` | the transactions page and dependent hot files |
| `content.published`, `action.completed` | `active-actions`, `recent-changes` |
| `visibility.materially_*` | `visibility-performance`, `current-priorities` |

Marking is set-based SQL, not a per-page loop. **The whole wiki is never rebuilt
for one source change.**

## Build planner

`lib/knowledge/build/planner.ts`:

1. **Collect** the stale set, plus any page explicitly requested.
2. **Expand** transitively — a hot file that summarises a page depends on that
   page, so a stale page makes its dependent hot files stale.
3. **Order** topologically. A cycle is a template bug: the planner refuses the
   build and raises a knowledge exception naming the cycle, rather than picking
   an arbitrary order.
4. **Compile** with bounded concurrency (`lib/knowledge/constants.ts`), each page
   independent.
5. **Hash-compare.** An identical `content_hash` records a `no_op` item and
   leaves the active version untouched. This is what keeps version history
   meaningful.
6. **Activate** each changed page: insert the version, insert sections and
   provenance, repoint `active_version_id`, clear `stale` — **in one
   transaction**. An app restart mid-build therefore cannot produce two active
   versions or a version without provenance.
7. **Manifest.** Record every page, its previous and new version, its hash and
   its status. Immutable.

## Failure handling

- A page that fails to compile records `failed` with its error, stays stale, and
  **does not block** the other pages in the build.
- The build's own status is `partial` when some items failed — never `completed`.
  An undisclosed partial result is the failure mode this codebase repeatedly
  refuses (see `fanIn` in `lib/workflow/handlers.ts`).
- Retries go through the existing queue's attempt/backoff machinery. A page that
  fails its final attempt raises a knowledge exception for a human.
- Builds are idempotent: re-running a build over an already-current page is a
  no-op, so a duplicate job is harmless.

## Cost and observability

Each build records duration, page counts by status, and agent cost (zero when
summarization is disabled). `no_op` percentage is the headline health metric: a
build system whose rebuilds are mostly no-ops is marking too much stale.

## Acceptance criteria

- [ ] Dependencies are recorded for every compiled page.
- [ ] A canonical change marks only dependent pages stale, verified by count.
- [ ] Builds compile only stale or explicitly requested pages.
- [ ] An unchanged page yields a `no_op` item and no new active version.
- [ ] Build order is topological; a cycle refuses the build with a named error.
- [ ] Activation is transactional; no page ever has two active versions.
- [ ] One page's failure does not prevent the rest of the build.
- [ ] A partially failed build reports `partial`, never `completed`.
- [ ] Manifests are immutable and record every item's before/after version.
- [ ] Re-running a build is a no-op.

## Test cases

Unit: dependency expansion, transitive staleness, topological order, cycle
detection, hash no-op, planner bounds.
Integration: approve a claim → exactly the expected pages go stale → build
compiles exactly those → second build is all no-ops; force one template to throw
and assert `partial` plus the other pages compiled; simulate a crash between
version insert and activation and assert a single active version.

## Definition of done

All acceptance criteria pass · tests green · lint and typecheck clean ·
migration applies and rolls back · build history UI shows manifests and no-op
rates against seeded data.
