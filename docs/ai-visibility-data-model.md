# AI Visibility Intelligence — Data Model

> Canonical schema doc: `docs/03-database-schema.md`. This file maps the visibility-intelligence entity list onto the existing schema so nobody re-creates a table that already exists, and documents the one addition (migration 039).

## Entity mapping (target entity → existing table(s))

| Target entity | Exists as | Notes |
|---|---|---|
| organizations / projects | `projects` | single-team internal; no org table needed |
| brands / brand_aliases | `companies` (+ `aliases text[]`, `is_self`) | alias provenance not modeled — acceptable |
| competitors | `competitors` (tiered) + `brand_candidates` (discovery) | |
| domains | `companies.domain`, `sources.domain`, `response_citations.domain` | |
| prompt_sets / versions / prompts | `prompt_sets`, `prompt_set_versions` (immutable, frozen jsonb), `prompts` | runs FK the frozen version — reproducibility is structural |
| prompt_runs / provider_runs / responses | `runs`, `responses` (immutable, hashed in-DB) | one row per cell incl. failures |
| response_spans / mentions / rankings | `mentions` (revision model; `list_position`, `sentiment`, `excerpt`) | |
| citations / citation_pages / citation_domains | `response_citations` (per-response ledger, immutable) + `sources` (aggregate, typed) | relational, deliberately no graph DB |
| metrics / metric_snapshots | `scores` (versioned, insert-only per version) read as time series; report snapshots in `reports.body` | no separate snapshot table needed |
| gap_findings | `gap_findings` (detector-versioned, dedup index) | |
| recommendations / action_plans | `tasks` (evidence-required), `program_plans` + `plan_items`, `campaigns` | unified impact/effort/confidence triple: roadmap |
| execution_requests / approvals | `workflow_approvals`, autonomy policies, `workflow_runs` | |
| experiments / experiment_observations | `interventions`, `intervention_runs`; verdicts computed on read | hypothesis field: roadmap |
| learnings | `action_outcomes` (+ knowledge layer per client) | cross-project store: roadmap |
| model_registry | `lib/ai/registry.ts` + `lib/ai/pricing.ts` (pinned in code, versioned in git) | deliberate: code review gates model additions |
| parser_versions | stamped on `mentions` / `response_parses` rows | |
| audit_events | `audit_log` (append-only) + `mcp_invocations` (new) + `artifact_access_log` | |

## Added by spec 033: `mcp_invocations` (migration 039)

Append-only ledger of executed MCP mutations. Columns: `tool`, `actor_id → users`, `args_hash` (sha-256 of canonical JSON), `idempotency_key`, `outcome ('ok'|'error')`, `entity_kind`, `entity_id`, `error`, `created_at`. `forbid_mutation()` trigger; partial unique `(tool, idempotency_key) where outcome='ok'` gives keyed replay semantics. Reversible (`drop table`).

## Invariants that protect this system (pre-existing, unchanged)

- Raw responses, prompt-set versions, mentions revisions, citations, and the ledgers are insert-only at the database level (`forbid_mutation` triggers).
- Scores are never recomputed in place; scoring versions coexist; cross-version comparison is forbidden in readers.
- Failures are captured as evidence (`responses.error`), never fabricated (mock provider is test-gated).
