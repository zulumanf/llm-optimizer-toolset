# Spec 023 — Client Wiki & Hot Files

> Status: done (2026-07-30)
> Depends on: specs/020, specs/021, specs/024
> Branch: feat/018-graph-execution-control-plane

## Goal

Compile canonical knowledge into concise pages that a human can read and an
agent can be handed, where every material statement traces back to the claims,
evidence and instructions that produced it — and where editing the page cannot
change what the platform believes.

## Gaps

Nothing compiled exists today. Every consumer re-reads `claims` and re-renders.
There is no concise client summary, no page history, no provenance, no freshness
state, and no way to hand an agent "what you need to know about this client"
without handing it the whole claims table.

## Storage decision

Compiled pages are **database rows carrying a rendered Markdown body plus a
structured JSON body**. Not files on disk.

A `.md` file on disk is editable by anything with filesystem access, and an
editable artefact that reads as authoritative is precisely the failure this
layer exists to prevent. Rows carry version identity, immutability triggers,
dependency joins and provenance foreign keys for free. Export to Markdown is a
read operation, available but never the store.

## Data model (migration `022_knowledge_wiki.sql`)

```sql
wiki_pages(
  id, project_id NULL, slug, page_type, title,
  token_budget, active_version_id → wiki_page_versions,
  freshness_status, privacy_classification,
  stale boolean, stale_since, stale_reason,
  created_at, updated_at)
  unique (coalesce(project_id, …), slug)

wiki_page_versions(                                   -- immutable
  id, page_id, version, title, summary,
  body_markdown, body_structured jsonb,
  content_hash, compiler_version, template_version,
  token_count, generated_at, effective_date,
  build_id → knowledge_builds, supersedes_version_id, created_at)

wiki_sections(
  id, page_version_id, section_key, heading, position,
  body_markdown, token_count, material boolean)       -- insert-only

wiki_section_provenance(
  id, section_id, claim_ids uuid[], claim_version_ids uuid[],
  evidence_ids uuid[], instruction_version_ids uuid[],
  source_artifact_ids uuid[], compiled_at, compiler_version)  -- insert-only

wiki_page_dependencies(
  id, page_id, dependency_type, dependency_id, created_at)
  unique (page_id, dependency_type, dependency_id)
```

`page_type` ∈ `overview | identity | approved_claims | markets | neighborhoods |
specialties | transactions | competitors | reputation_findings |
visibility_performance | authority_strategy | attribution | active_actions |
current_priorities | open_risks | recent_changes | market | methodology |
hot_file`.

**Provenance lives in tables, not in the Markdown body.** A YAML front-matter
block inside the body would be unqueryable, hand-editable and duplicated. The
tables give the UI a direct join and the compiler a place to write without
polluting what a human reads.

## Hot files are pages

A hot file is a `wiki_pages` row with `page_type = 'hot_file'` and a hard
`token_budget`. It is not a parallel system: one compiler, one dependency graph,
one build engine, one provenance model.

| Slug | Budget | Content |
|---|---|---|
| `client-summary` | 1200 | identity, markets, specialties, priorities, approved material claims, current gaps, active actions, restrictions, last-updated |
| `current-strategy` | 800 | approved positioning and priority categories |
| `approved-claims` | 1500 | every approved claim with wording constraints and as-of dates |
| `current-priorities` | 600 | ranked open priorities with their evidence |
| `open-risks` | 600 | open contradictions, expired claims, unresolved exceptions |
| `recent-changes` | 800 | canonical changes in the last 30 days |
| `active-actions` | 600 | open approved actions and their state |
| `attribution-summary` | 600 | attribution outcomes with confidence bounds |
| `integration-health` | 400 | connector health and last sync per provider |

A hot file that exceeds its budget is compacted (spec 022 rules) and, if it still
exceeds, the build **fails loudly** rather than shipping an oversized "concise"
file.

## The compiler

`lib/knowledge/compiler/`. Deterministic in every step that decides *what is
true*; an LLM may only phrase prose that has already been selected.

```
select canonical records (deterministic, privacy- and freshness-filtered)
→ build typed page context
→ render sections from the page template
→ [optional] summarization agent for prose-only sections
→ claim-level output validation: every material sentence maps to a selected claim
→ deterministic provenance attachment
→ render Markdown + structured JSON
→ content hash
→ compare with the active version
     identical → no-op, no new version
     different → insert version, attach provenance, activate in one transaction
→ emit wiki.page_build_completed
```

**An agent never decides which facts are approved.** The summarization step
receives an already-selected, already-filtered set and returns prose; its output
is validated sentence-by-sentence against that set, and any sentence that
introduces an unsupported fact fails the build. Compilation is deterministic
by default — the summarization step is opt-in per template and skipped entirely
when no provider key is configured, so builds work offline.

## Page templates

`lib/knowledge/compiler/templates/`, following the `lib/workflow/templates/`
idiom: each declares `pageType`, `templateVersion`, `dependencies(context)`,
`select(context)` and `render(selection)`. Declaring dependencies in the template
is what makes the dependency graph correct by construction rather than by
remembering to register one.

## Editing policy (Part 30)

Two kinds of content, never confused:

- **Generated sections** — produced by the compiler, replaced on every build,
  never independently true. Not editable through the UI.
- **Human annotations** — explicitly labelled, owned, versioned, stored as their
  own records, rendered *beside* generated content and never merged into it. An
  annotation may be **proposed for canonicalization**, which routes it through
  the normal claim proposal → evidence → approval path. It never overrides an
  approved claim.

There is no code path from editing a page to changing a claim.

## Freshness

A page's `freshness_status` is the worst state among the claims it depends on
(`current > nearing_review > stale > expired`). It is displayed on the page and
carried into any packet that selects from it, so an agent handed a section knows
whether it may state it as current.

## Acceptance criteria

- [ ] Pages are compiled from canonical records, never hand-authored.
- [ ] Page versions are immutable and historical versions stay readable.
- [ ] Every material section records claims, evidence and instructions used.
- [ ] Provenance is queryable without parsing Markdown.
- [ ] An unchanged compilation produces no new version.
- [ ] Hot files stay inside their token budgets or fail the build.
- [ ] Freshness reflects the worst dependency state.
- [ ] A summarization step that introduces an unsupported fact fails the build.
- [ ] Compilation succeeds with no provider key configured.
- [ ] No UI path edits a generated section or mutates canonical truth.

## Test cases

Unit: template dependency declaration, section rendering, content hashing,
no-op detection, budget enforcement, freshness rollup, unsupported-sentence
rejection.
Integration: compile a full client wiki from seeded data; recompile unchanged
(no new version); change one claim and recompile; annotation proposed for
canonicalization; oversized hot file.
Security: cross-client page read, page edit attempting to alter a claim.

## Definition of done

All acceptance criteria pass · tests green · lint and typecheck clean ·
migration applies and rolls back · wiki UI with page history and provenance
demonstrated against seeded data.
