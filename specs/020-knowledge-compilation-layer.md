# Spec 020 — Knowledge Compilation & Context Engineering Layer

> Status: in-progress
> Depends on: specs/008 (claims), specs/018 (graph control plane), specs/llm-evidence-capture-and-audit-trail, docs/02, docs/10, docs/12
> Branch: feat/018-graph-execution-control-plane
> Sub-specs: 021 (ingestion), 022 (context packets), 023 (wiki & hot files), 024 (incremental rebuilds), 025 (maintenance — deferred)

## Goal

Stop agents re-reading raw material. Today a client fact reaches an agent only
if a human typed it into `claims` by hand, and every agent that needs context
gets the same undifferentiated blob: *all approved claims for this project*.
When this spec is done there is a compilation layer between the source material
and the agent:

```
raw artifacts → extraction → entities & proposed claims → evidence links
   → contradiction detection → verification & approval → canonical graph
   → knowledge compiler → wiki pages + hot files
   → task-specific context packet → agent → verification loop
```

Sources are ingested once and stored immutably. Canonical truth stays in
Postgres. Compiled pages are generated *from* canonical data, carry
section-level provenance, and are rebuilt only when something they depend on
changes. Agents receive a packet built for one task, inside a token budget,
with instructions separated from facts and every omission recorded.

## Existing capabilities discovered (2026-07-29 audit)

| Capability | State | Where |
|---|---|---|
| Claims with privacy, wording constraints, versions | ✅ solid | migrations 008/018 — `claims`, `claim_versions` |
| Contradiction *table* | ⚠️ table only | `claim_contradictions` — written by `scripts/seed-graph.ts`, never detected at runtime |
| Task-scoped, privacy-filtered, hashed packet | ✅ but one shape | `lib/knowledge/packet.ts`, `evidence_packets` |
| Immutable content-addressed artifact storage | ✅ | `lib/evidence/storage.ts`, `var/evidence/`, `evidence_artifacts` |
| Workflow state: runs, nodes, signals, approvals, exceptions | ✅ solid | migration 017, `lib/workflow/` |
| Domain event bus with validated catalogue + dedupe | ✅ solid | migration 020, `lib/events/` |
| Agent registry with data scopes, prohibitions, cost caps | ✅ | `lib/agents/registry.ts` |
| Immutability enforcement in Postgres | ✅ | `forbid_mutation()` |
| Audit log | ✅ | `audit_log`, `db/audit.ts` |
| Durable queue + worker | ✅ | `db/jobs.ts`, `workers/index.ts` |
| Connectors (CSV, local file, GA4, Search Console, CRM, CMS) | ✅ 16 adapters | `lib/connectors/` |

## Gaps this spec closes

1. **Nothing feeds the canonical graph.** No file upload, no document parsing,
   no website snapshot, no CRM/analytics import path into `claims`.
2. **No raw source layer.** `evidence_artifacts` is response-bound (it hangs off
   an LLM capture) and has no project scope, source type, effective date,
   privacy/retention class, extraction status, or version chain.
3. **No entity layer.** `companies` covers tracked brands. Markets,
   neighbourhoods, brokerages, people, specialties, publications and awards have
   nowhere to live, so `claims.subject_entity` is free text.
4. **No instructions layer.** Brand voice, confidentiality rules and prohibited
   wording exist only as per-claim arrays. Nothing is scoped, effective-dated or
   independently versioned, and facts and rules arrive fused in one blob.
5. **No compiled layer.** Every packet re-reads and re-renders raw rows. There is
   nothing compiled once, nothing concise, nothing with a freshness state.
6. **No dependency tracking or incremental rebuild.** Nothing knows which
   compiled output a given claim influences.
7. **Packets have no budget, template, retrieval, validation or explanation.**
8. **Contradictions are never detected**, only seeded.

## The five layers

| Layer | Purpose | Storage | Mutability |
|---|---|---|---|
| **Raw** | preserve original material for audit, reprocessing, dispute | `var/knowledge/` content-addressed files + `source_artifacts` | insert-only; a change is a new version |
| **Canonical** | what the platform is allowed to believe | Postgres: `claims`, `claim_versions`, `knowledge_entities`, `entity_relationships`, `claim_contradictions` | claim versions immutable |
| **Wiki** | concise compiled knowledge for humans and agents | `wiki_pages` + immutable `wiki_page_versions` (Markdown + structured JSON) | page versions immutable |
| **Instructions** | how knowledge may be used | `knowledge_instructions` + immutable `knowledge_instruction_versions` | versions immutable |
| **State** | resumable progress | **already built** — `workflow_runs`, `node_runs`, `workflow_signals`, `workflow_approvals` (spec 018) | append-only transitions |

The wiki is **never** the source of truth. A compiled page is a *rendering* of
canonical records; editing one cannot change what the platform believes. This is
enforced structurally: `wiki_page_versions` rows are immutable, and the only
writer is the compiler.

## Storage decisions

- **Tenant = project.** `CLAUDE.md`: "Not multi-tenant. One team, internal only."
  Every workflow and event table already uses `project_id` as the tenant key.
  Adding `tenant_id` would fabricate a dimension the product does not have.
  Isolation tests are written client-to-client, which is the leakage that can
  actually occur here. Recorded in `DECISIONS.md`.
- **Object storage = local content-addressed filesystem** under `var/knowledge/`,
  mirroring the `var/evidence/` decision in `lib/evidence/storage.ts`. Signed-URL
  / bucket storage is deferred with the Supabase milestone.
- **Canonical stays relational.** No document store, no separate graph database.
- **Compiled pages are database rows** carrying a rendered Markdown body plus a
  structured JSON body. No `.md` files on disk — a file on disk is editable, and
  an editable artefact that looks authoritative is exactly the failure mode this
  spec exists to prevent.
- **Retrieval is Postgres full-text + structured filters + entity traversal.** No
  vector store. `pgvector` is not in this stack, and the selection rules the
  packet templates need are structural (client scope, category, entity, date,
  privacy, freshness), not similarity-shaped.

## Phases

| Phase | Content | Spec |
|---|---|---|
| 1 | raw source layer, ingestion pipeline, extractors, normalization | 021 |
| 2 | entities, aliases, relationships, instructions, claim extraction, contradiction detection, freshness | 020 (here) |
| 3 | wiki page model, section provenance, knowledge compiler | 023 |
| 4 | page dependencies, dirty detection, incremental build engine | 024 |
| 5 | hot files, context-packet builder, templates, token budgets, validation, explanation | 022, 023 |
| 6 | agent integration, offline token measurement | 020 (here) |
| 7–9 | daily/weekly maintenance, retrieval evaluation, live quality experiments, hardening | 025 — **deferred, not built in this branch** |

## Phase 2 data model (entities & instructions)

```sql
knowledge_entities(id, project_id NULL, entity_type, canonical_name, slug,
  company_id NULL → companies, description, status, created_by, …)
entity_aliases(id, entity_id, alias, source_artifact_id NULL, confidence, …)
entity_relationships(id, project_id NULL, from_entity_id, to_entity_id,
  relationship_type, effective_from, effective_until, evidence_ids[], status, …)
knowledge_instructions(id, project_id NULL, instruction_type, scope, scope_ref,
  title, active_version_id, owner, status, …)
knowledge_instruction_versions(id, instruction_id, version, body, priority,
  effective_from, effective_until, requires_approval, approved_by, …)  -- immutable
```

`knowledge_entities.company_id` is nullable and **points at** an existing
`companies` row when the entity is a tracked brand. The company is not copied.
`project_id` is nullable so a market ("Jersey City") or a methodology is shared
rather than duplicated per client.

### Instruction scoping

`resolveInstructions({projectId, workflowKey, agentKey, at})` returns the
effective set, ordered by priority, where:

- scope `global` always applies;
- scope `project` applies when `scope_ref = projectId`;
- scope `workflow` / `agent` apply when `scope_ref` matches;
- `effective_from <= at` and (`effective_until` is null or `> at`);
- an instruction whose active version `requires_approval` and has no
  `approved_by` is **excluded** and reported in the packet's missing-context list.

## Phase 2 — contradiction detection

`lib/knowledge/contradictions/detect.ts`, deterministic, runs on claim approval
and on demand. Rules, each producing a typed contradiction row:

| Rule | Trigger | Severity |
|---|---|---|
| `value_divergence` | same `normalized_predicate` + same subject, different `value`, overlapping effective ranges | high if `category` is material, else medium |
| `affiliation_conflict` | two open claims with predicate `works_for` / `affiliated_with` and different objects, overlapping dates | critical |
| `date_conflict` | `effective_date` after `as_of`, or an effective range contained in a superseded claim's range | medium |
| `expired_ranking` | `category = 'ranking'` and `review_date` passed with no successor | medium |
| `privacy_conflict` | a `public` claim restates a `restricted`/`internal` claim's subject+predicate | high |

Older claims are **never deleted**. Effective dates carry history; a
contradiction is a flag for a human, not a licence to overwrite.

## Phase 2 — freshness

`lib/knowledge/freshness.ts` maps `(category, sourceType, effectiveDate,
reviewDate, lastVerifiedAt)` to one of
`current | nearing_review | stale | expired | superseded | unknown`, using a
named policy table (no magic numbers — `lib/knowledge/constants.ts`):

| Category | Review window | Notes |
|---|---|---|
| `affiliation`, `team` | 90 days | changes without warning |
| `ranking`, `award` | valid for its stated year, then `expired` | never restated as current |
| `transaction` | stable once `verified`; `unknown` while unverified | |
| `market_statistic` | 90 days, requires an explicit period | |
| `inventory` | 7 days | |
| `sales_volume` | 180 days, **must** carry an "as of" date | |
| default | 365 days | |

`stale` and `expired` claims are excluded from high-risk packets, and their
exclusion is disclosed (spec 022) rather than silent.

## Phase 6 — agent integration

`AgentDefinition` (`lib/agents/registry.ts`) gains:
`requiredPacketTemplate`, `maxContextTokens`, `minFreshness`,
`requiredEvidenceClasses`, `allowedPrivacyClasses`.

Migrated in this branch: `content_brief`, `content_draft`,
`content_fact_verifier`, `accuracy_monitor`, `weekly_executive_brief`. The
`claim_extraction` agent is promoted from `declared` to `implemented`. Agents
not migrated keep working through the legacy path, which is re-implemented on
top of the new builder so there is one selection implementation.

## Phase 6 — measurement

`lib/knowledge/context/tokens.ts` counts input tokens across four context modes
— raw documents, full wiki, hot files, task packet — from seeded fixtures. It
runs in CI at zero cost and reports **measured token deltas**. Accuracy,
human-correction time and verifier-rejection rate are **not measured** in this
branch and are reported as such. No token-savings figure is asserted that was
not produced by the counter.

## Acceptance criteria

- [ ] Raw sources are stored content-addressed, hashed, and never overwritten.
- [ ] A changed source produces a new artifact version linked to its predecessor.
- [ ] Extracted text is stored separately from original bytes, with parser version.
- [ ] Canonical truth remains relational; no compiled page is authoritative.
- [ ] Agents may propose claims; a material claim reaches `approved` only via a human.
- [ ] Contradictions are detected at runtime by deterministic rules, not seeded.
- [ ] Freshness returns one of the six states for every claim.
- [ ] Instructions resolve by scope and effective date, separate from facts.
- [ ] Every material compiled section records the claims, evidence and instructions it used.
- [ ] A canonical change marks only dependent pages stale.
- [ ] An unchanged compiled output produces **no** new active version.
- [ ] Historical page versions remain readable and reproducible.
- [ ] Hot files stay inside their declared token budgets.
- [ ] Context packets are built from a named template with a token budget.
- [ ] Packets never include another client's records; attempts are tested.
- [ ] Packets never include `restricted` claims, and record what was withheld.
- [ ] Packets disclose stale, missing and contradicted knowledge.
- [ ] Packet construction is explainable item by item, with selection reasons.
- [ ] Token counts are measured, never estimated or claimed.
- [ ] `npm run typecheck`, `npm run lint`, `npm run test` pass.
- [ ] Migrations apply and roll back.
- [ ] `npm run build` passes.
- [ ] The end-to-end demonstration test passes.

## Known limitations

- Daily/weekly maintenance workflows, the retrieval evaluation suite and live
  agent-quality experiments are specified in 025 and **not built here**.
- Images and scanned PDFs are stored and hashed but not text-extracted; there is
  no OCR path. Extraction status is `unsupported`, stated in the UI.
- Retrieval is lexical + structural. Semantic recall for paraphrased queries is
  weaker than a vector index would give.
- Local filesystem storage means no signed URLs and no multi-host deployment.
