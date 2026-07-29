# 03 — Database Schema

Postgres (Supabase). Conventions: `id uuid pk default gen_random_uuid()`, `created_at timestamptz default now()` on every table; snake_case; foreign keys always indexed; **no hard deletes on experiment data** (`archived_at` instead). Tables marked **IMMUTABLE** are insert-only, enforced by trigger.

Entity flow:

```
projects ─┬─ prompt_sets ── prompts
          │       └─ prompt_set_versions (frozen)  ◄─┐
          ├─ competitors ── companies                │
          └─ runs ────────────────────────────────────┘
                └─ responses (IMMUTABLE, raw)
                      └─ mentions ── companies
                └─ scores (versioned)
          reports · tasks ── evidence ── sources · users · audit_log · jobs
```

## projects
Groups everything by initiative ("Parva Core", "Feature X Launch").

| field | type | notes |
|---|---|---|
| id | uuid pk | |
| name | text unique | |
| description | text | |
| status | enum: active, archived | |
| created_at / archived_at | timestamptz | |

## prompt_sets
Editable working collection of prompts.

| field | type | notes |
|---|---|---|
| id | uuid pk | |
| project_id | uuid fk → projects | indexed |
| name | text | unique per project |
| description | text | intent of the set |
| created_at / archived_at | timestamptz | |

## prompts
| field | type | notes |
|---|---|---|
| id | uuid pk | |
| prompt_set_id | uuid fk | indexed |
| text | text | the user-facing question asked to the AI |
| category | text | e.g. "recommendation", "comparison", "how-to" |
| language | text default 'en' | |
| position | int | ordering within set |
| created_at / archived_at | timestamptz | |

## prompt_set_versions — **IMMUTABLE**
Frozen snapshot created when a set is frozen. Runs reference versions, never live sets.

| field | type | notes |
|---|---|---|
| id | uuid pk | |
| prompt_set_id | uuid fk | indexed |
| version | int | sequential per set; unique (prompt_set_id, version) |
| frozen_prompts | jsonb | full array of {prompt_id, text, category, position} |
| frozen_by | uuid fk → users | |
| frozen_at | timestamptz | |

## companies
Every brand we track (Parva + competitors + incidental brands found in answers).

| field | type | notes |
|---|---|---|
| id | uuid pk | |
| name | text | canonical |
| aliases | text[] | matching variants ("Parva", "parva.com", "Parva App") |
| domain | text | |
| is_self | boolean | exactly one row true (Parva) |

## competitors
Join: which companies are tracked as competitors in a project.

| field | type | notes |
|---|---|---|
| id | uuid pk | |
| project_id | uuid fk | indexed |
| company_id | uuid fk | unique (project_id, company_id) |
| tier | enum: primary, secondary | |
| added_at / archived_at | timestamptz | |

## runs
One execution of a frozen prompt-set version. Append-only in practice (status fields update, results never do). Re-running = new row.

| field | type | notes |
|---|---|---|
| id | uuid pk | |
| project_id | uuid fk | indexed |
| prompt_set_version_id | uuid fk | indexed — the frozen snapshot used |
| label | text | "Weekly baseline 2026-W31" |
| providers | jsonb | [{provider, model, repetitions}] |
| status | enum: pending, running, partial, completed, failed | |
| trigger | enum: manual, scheduled | |
| started_by | uuid fk → users nullable | null for cron |
| cost_usd | numeric | accumulated |
| started_at / completed_at | timestamptz | |

## responses — **IMMUTABLE**
Raw provider output. Insert-only; UPDATE/DELETE blocked by trigger. Never trimmed, never normalized in place.

| field | type | notes |
|---|---|---|
| id | uuid pk | |
| run_id | uuid fk | indexed |
| prompt_id | uuid | from the frozen snapshot |
| prompt_text | text | denormalized copy — self-contained evidence |
| provider / model | text | |
| repetition | int | 1..N |
| raw_payload | jsonb | full provider response, verbatim |
| response_text | text | extracted answer text (extraction version noted) |
| latency_ms / tokens_in / tokens_out / cost_usd | | |
| error | jsonb nullable | failed calls recorded, never faked |
| requested_at | timestamptz | |

Indexes: (run_id), (provider, model), (requested_at).

## mentions
Parsed classification of a brand appearance in a response. Corrections create a new row with `revision + 1`; the original stays.

| field | type | notes |
|---|---|---|
| id | uuid pk | |
| response_id | uuid fk | indexed |
| company_id | uuid fk | indexed |
| revision | int default 1 | highest revision = current |
| mentioned | boolean | |
| recommended | boolean | explicitly recommended? |
| list_position | int nullable | rank if answer lists options |
| sentiment | enum: positive, neutral, negative, mixed | |
| excerpt | text | supporting quote from response_text |
| cited_urls | text[] | URLs attributed to this brand |
| parser_version | text | |
| confidence | numeric 0–1 | per `docs/06` |
| needs_review | boolean | confidence < threshold |
| reviewed_by / reviewed_at | fk users / timestamptz | null until human-reviewed |

## scores
Computed metrics. Never overwritten — new scoring version = new rows.

| field | type | notes |
|---|---|---|
| id | uuid pk | |
| run_id | uuid fk | indexed |
| company_id | uuid fk | |
| metric | text | 'mention_rate', 'recommendation_rate', … per `docs/06` |
| provider | text | per-provider rows plus an 'all' aggregate (docs/06 computes per provider first) |
| value | numeric | |
| sample_size | int | |
| scoring_version | text | e.g. 'v1.0' |
| computed_at | timestamptz | |

Unique: (run_id, company_id, metric, provider, scoring_version).

## sources
External URLs cited in AI answers.

| field | type | notes |
|---|---|---|
| id | uuid pk | |
| url | text unique | |
| domain | text | indexed |
| company_id | uuid fk nullable | owner if known |
| first_seen_at / last_seen_at | timestamptz | |
| citation_count | int | maintained by parser |

## evidence
Links a claim (task/report finding) to its proof.

| field | type | notes |
|---|---|---|
| id | uuid pk | |
| kind | enum: response, mention, score, source | |
| ref_id | uuid | id in the referenced table |
| note | text | why this supports the claim |
| created_by | uuid fk → users | |

## tasks
Actions derived from findings. Software suggests, humans approve (`PRINCIPLES.md` #8).

| field | type | notes |
|---|---|---|
| id | uuid pk | |
| project_id | uuid fk | |
| title / description | text | |
| status | enum: suggested, approved, in_progress, done, rejected | |
| priority | enum: p1, p2, p3 | |
| evidence_ids | uuid[] | must be non-empty for suggested tasks |
| approved_by | uuid fk nullable | required before in_progress |
| created_at / updated_at | timestamptz | |

## reports — **IMMUTABLE once published**
| field | type | notes |
|---|---|---|
| id | uuid pk | |
| project_id | uuid fk | |
| title | text | |
| period_start / period_end | date | |
| body | jsonb | snapshot: scores, deltas, excerpts, task suggestions |
| status | enum: draft, published | drafts editable; published rows locked by trigger |
| published_by / published_at | | |

## users
| field | type | notes |
|---|---|---|
| id | uuid pk | = Supabase auth uid |
| email | text unique | allowlisted |
| name | text | |
| role | enum: admin, operator | |

## jobs
Postgres-backed queue for `workers/`.

| field | type | notes |
|---|---|---|
| id | uuid pk | |
| type | text | execute_run, parse_response, compute_scores, generate_report |
| payload | jsonb | |
| status | enum: queued, running, done, failed | |
| attempts | int | max retries then failed, alert |
| run_after | timestamptz | for backoff |
| locked_by / locked_at | | worker lease |

## audit_log — **IMMUTABLE**
| field | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid fk nullable | |
| action | text | 'freeze_prompt_set', 'approve_task', … |
| entity / entity_id | text / uuid | |
| detail | jsonb | |
| at | timestamptz | |

## Versioning summary

| What | How |
|---|---|
| Prompts | frozen into `prompt_set_versions`; runs reference the version |
| Raw responses | immutable, insert-only |
| Classifications | `parser_version` + `revision` chain, originals kept |
| Scores | `scoring_version`, new rows per version |
| Reports | immutable once published |
| Methodology | versioned in `docs/06-scoring-methodology.md` changelog |

---

# Graph platform tables (specs/018, specs/019)

Added 2026-07-29. Full rationale in
`docs/architecture/graph-native-platform-architecture.md`.

## Workflow graph — migration 017

| Table | Purpose | Mutability |
|---|---|---|
| `workflow_definitions` | logical process (`key`, autonomy level, action type) | mutable metadata |
| `workflow_versions` | immutable snapshot of one graph (`graph_hash`, `spec`) | **IMMUTABLE** |
| `workflow_nodes` | one row per node in a version | **IMMUTABLE** |
| `workflow_edges` | `(from, to, condition, required, on_failure, loop_max_iterations)` | **IMMUTABLE** |
| `workflow_runs` | one execution; `idempotency_key` unique, cost cap, state | mutable state |
| `node_runs` | one row per node **instance**; `(run, node, fan_key)` unique | mutable state |
| `workflow_transitions` | previous → new state, actor, reason, versions | **IMMUTABLE** |
| `workflow_signals` | external inputs (approval decisions, callbacks) | append + consume marker |
| `workflow_approvals` | durable approval requests and their decisions | decision written once |
| `workflow_exceptions` | the unified exception queue | mutable status |
| `quality_gate_results` | gate evaluations with per-check detail | **IMMUTABLE** |
| `agent_definitions` / `agent_versions` | the versioned agent registry | versions **IMMUTABLE** |
| `agent_evaluations` | fixture-suite results per agent version | append-only |
| `autonomy_policies` | per (project, workflow, action type, risk) override | mutable |

The `(workflow_run_id, node_key, fan_key)` unique index on `node_runs` is the
idempotency guarantee for both fan-out and retries — a retry cannot create a
second instance of work that already settled.

## Knowledge & evidence graph — migration 018

`claims` gains graph-shaped columns (`normalized_predicate`, `subject_entity`,
`object_entity_id`, `category`, `effective_date`, `review_date`,
`verification_status`, `confidence`, `privacy_status`, `allowed_wording`,
`prohibited_wording`, `version`).

| Table | Purpose | Mutability |
|---|---|---|
| `claim_versions` | history; a correction creates a version, never an edit | **IMMUTABLE** |
| `claim_contradictions` | claim vs claim, or claim vs external observation | mutable status |
| `evidence_packets` | exactly what an agent was shown, hashed | **IMMUTABLE** |

## Control tower — migration 019

| Table | Purpose | Mutability |
|---|---|---|
| `client_health_snapshots` | components, weights version, period, missing, confidence | **IMMUTABLE** |
| `action_outcomes` | before/after envelope + fixed-vocabulary effectiveness label | measured once |
| `outcome_relationships` | typed edges with a confidence label | **IMMUTABLE** |
| `operator_capacity_snapshots` | observed human minutes, automation rate, capacity | **IMMUTABLE** |
| `executive_briefs` | evidence-linked statements with per-statement `kind` | one draft per period |

## Versioning summary (additions)

| What | How |
|---|---|
| Workflow graphs | `workflow_versions.graph_hash`; a changed graph is a new version, and a run points at the version it executed |
| Agents | `agent_versions`, immutable; the version used is recorded in produced data |
| Claims | `claim_versions`, immutable; corrections create versions |
| Health / capacity | append-only snapshots; recomputing writes a new row |
| Gate results | immutable, with per-check detail |
