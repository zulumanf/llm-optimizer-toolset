# Spec 022 — Context Packet Builder

> Status: in-progress
> Depends on: specs/020, specs/023 (hot files), specs/018 (agent registry), docs/10, docs/12
> Branch: feat/018-graph-execution-control-plane

## Goal

Replace "hand the agent every approved claim" with "hand the agent exactly what
this task needs, inside a token budget, with instructions separated from facts,
every omission recorded and every inclusion explainable".

## Existing capabilities

`lib/knowledge/packet.ts` already does the hard, correct parts: it reads only
`approved` claims, filters by privacy at retrieval time, records what it
withheld, attaches open contradictions and required disclaimers, flags claims
past their review date, hashes the content, and stores the packet so a past
agent decision stays reproducible. `evidence_packets` is immutable.

**This spec extends that module. It does not fork it.** `buildEvidencePacket()`
survives as a thin wrapper re-implemented on top of the new builder, so there is
one selection implementation in the codebase.

## Gaps

1. One shape for every task — filtering is limited to category and claim key.
2. No token budget, no priority classes, no compaction, no truncation policy.
3. No instructions: brand voice and confidentiality rules cannot enter a packet.
4. No compiled knowledge: hot files and wiki sections cannot be selected.
5. No retrieval — nothing finds *relevant* prior work, markets or competitors.
6. No validation step, no explanation, no expiry, no per-item selection reason.
7. Cost is invisible: nothing counts what a packet actually costs to send.

## Data model (migration `023_context_packets.sql`)

Additive columns on `evidence_packets` (immutability preserved — the trigger
already forbids update/delete, and adding columns is a schema change, not a row
mutation):

```sql
alter table evidence_packets add column
  template_key text, agent_key text, task_objective text,
  token_count integer, token_budget integer,
  freshness_floor text, audience text,
  validation jsonb, missing_context jsonb, expires_at timestamptz;
```

```sql
context_packet_items(
  id, packet_id → evidence_packets, item_type, item_ref,
  priority_class, selection_reason, retrieval_score,
  token_cost, freshness_status, privacy_status,
  included boolean, exclusion_reason, position, created_at)  -- insert-only

context_packet_templates(              -- mirrored from code, like agent_definitions
  id, key, name, description, version,
  required_categories text[], required_instruction_types text[],
  default_token_budget integer, min_freshness text,
  allowed_privacy text[], prohibited_source_types text[],
  created_at, updated_at)
```

`item_type` ∈ `hot_file | wiki_section | claim | evidence | instruction |
contradiction | workflow_state | task_input | methodology`.

**Packet access is written to the existing `audit_log`**, not to a second
access-log table. One audit system.

## Interfaces

```typescript
interface ContextPacketBuilder {
  buildPacket(request: ContextPacketRequest): Promise<ContextPacket>;
  validatePacket(packetId: string): Promise<ContextPacketValidationResult>;
  explainPacket(packetId: string): Promise<ContextPacketExplanation>;
}
```

`ContextPacketRequest`: `projectId`, `templateKey`, `workflowRunId`,
`nodeRunId`, `agentKey`, `taskObjective`, `targetEntityIds`, `targetMarkets`,
`promptClusterIds`, `dateRange`, `requiredCategories`, `evidenceDepth`,
`tokenBudget`, `audience`, `freshnessFloor`, `allowedSourceTypes`,
`prohibitedSourceTypes`.

`ContextPacket`: everything the existing `EvidencePacket` carries, plus
`templateKey`, `hotFiles`, `wikiSections`, `instructions`, `missingContext`,
`items` (with selection reasons and token costs), `tokenCount`, `tokenBudget`,
`expiresAt`, `contentHash`.

## Selection strategy — hybrid, deterministic first

**Deterministic (always, never subject to ranking):**
client identity and aliases · required approved claims for the template's
categories · resolved instructions for the scope · methodology records · the
exact target entities, prompt clusters and date range named in the request ·
open contradictions touching any selected claim · privacy filtering.

**Retrieved (ranked, budget-limited):**
related prior assets · similar transactions · market context · competitor
evidence · historical action outcomes.

Ranking combines Postgres full-text rank, entity-graph proximity, freshness,
evidence quality and recency into one score recorded per item. **There is no
vector-similarity-only path.** Structured filters carry the rules that actually
matter here; similarity search would add a dependency and a failure mode without
changing which claims a drafting agent is *allowed* to use.

## Token budget

Every packet has a budget. Allocation, in `lib/knowledge/constants.ts`:

| Priority class | Reserved share | Truncatable |
|---|---|---|
| 1 task objective | fixed | no |
| 2 safety, privacy and prohibition instructions | 15% floor | **never** |
| 3 approved claims + material qualifiers | 30% floor | qualifiers never |
| 4 required evidence | 15% | excerpts may shorten |
| 5 known contradictions | fixed | high severity **never** |
| 6 workflow state | 10% | yes |
| 7 client strategy / hot files | remainder | yes |
| 8 historical and supporting context | remainder | yes |
| 9 optional material | remainder | dropped first |

The **never-truncate set** — privacy restrictions, material claim qualifiers,
high-severity contradictions, required attribution disclosures and approval
requirements — is enforced in code. If the budget cannot hold it, the builder
raises a classified error rather than returning a packet missing a restriction.
A degraded packet is worse than no packet: it looks complete.

Everything dropped is recorded as a `context_packet_items` row with
`included = false` and an `exclusion_reason`. Nothing disappears silently.

Token counting is deterministic and local (`lib/knowledge/context/tokens.ts`),
so it runs in CI without a provider call.

## Compaction

When a section exceeds its allocation, compaction removes repetition, obsolete
summaries, duplicated background and low-value examples. It must preserve
approved facts, dates, quantitative values, qualifiers, evidence links,
contradictions, privacy rules and required instructions. Compacted output is
verified against its source records before it enters a packet — a compaction
that drops a qualifier is a failed compaction, not a smaller one.

## Templates (Part 16 A–G)

| Key | Includes | Excludes |
|---|---|---|
| `response_classification` | canonical identity, aliases, team, brokerage, markets, specialties, competitors, rubric, the raw response, prompt metadata | transactions, content strategy, CRM data, private claims |
| `content_drafting` | client overview hot file, audience, prompt cluster, markets, approved claims + wording, supporting evidence, brand voice, prohibited wording, methodology, brief, prior assets | unrelated transactions, internal-only claims, other clients |
| `claim_verification` | the proposed claim, approved canonical claims for the same predicate, original evidence, contradictions, freshness rules, verification rubric, required qualifiers | strategy, marketing context |
| `executive_report` | current + prior metrics, baseline, completed actions, attribution outcomes, material exceptions, methodology, goals, recommendations | raw client PII, unverified claims |
| `outreach` | prospect identity, verified public authority, mini-audit findings, competitor comparison, allowed statements, restrictions, case study, CTA | anything `client_only` or above for other clients |
| `meeting_preparation` | status, recent performance, open approvals, risks, opportunities, permitted communications, prior decisions, objective | restricted claims |
| `action_prioritization` | visibility gaps, evidence gaps, commercial value, competitor intensity, existing authority, historical outcomes, cost constraints, dependencies | drafting material |

Templates are declared in code and mirrored to `context_packet_templates` by a
`syncPacketTemplates()` function following the exact pattern of
`syncAgentRegistry()`.

## Validation (Part 26)

`validatePacket` runs **before** the packet is handed to an agent and checks:
correct project · required instructions present · required claims present ·
stale claims excluded or explicitly disclosed · privacy restrictions enforced ·
`restricted` claims absent · open contradictions included · evidence
requirements met · token budget respected · **no row belonging to another
client** · content hash reproducible.

A failure returns a `ClassifiedError`. The builder never returns a packet that
failed validation with a warning attached.

## Explanation

`explainPacket` returns, per item: what it is, why it was selected (deterministic
rule name or retrieval score), its token cost, its freshness state, its privacy
class, its evidence quality — and the same for everything excluded, with the
reason. This is the data behind the packet-inspector UI.

## Edge cases

| Case | Behaviour |
|---|---|
| No approved claims for the template's required categories | packet is built, `missingContext` names them, and templates flagged `requiresClaims` return a safe-stop to the caller |
| Budget too small for the never-truncate set | classified error, no packet |
| A required instruction is unapproved | excluded, listed in `missingContext` |
| A high-severity contradiction touches a required claim | claim included **with** the contradiction; never silently dropped |
| Requested entity belongs to another client | classified error; the attempt is audited |
| Packet requested after expiry | expired packets are readable for audit but refused for execution |

## Acceptance criteria

- [ ] Every packet is built from a named template with a token budget.
- [ ] Token counts are measured by the counter, not estimated.
- [ ] The never-truncate set is provably never truncated (test squeezes the budget).
- [ ] Every included and excluded item has a recorded reason.
- [ ] Instructions are carried separately from facts and labelled as instructions.
- [ ] Stale and missing knowledge is disclosed inside the packet.
- [ ] Cross-client selection is impossible and the attempt is audited.
- [ ] `restricted` claims never appear in any packet.
- [ ] Packets are reproducible from their stored content hash.
- [ ] `buildEvidencePacket()` still works and now delegates to the new builder.

## Test cases

Unit: budget allocation, priority ordering, never-truncate enforcement,
compaction preservation, token counting, selection-reason recording, template
resolution, freshness filtering, privacy filtering.
Integration: build each of the seven templates against seeded data; validate;
explain; agent retrieval through a workflow node.
Security: cross-client entity request, restricted claim inclusion attempt,
unapproved instruction inclusion, packet read by another client.

## Definition of done

All acceptance criteria pass · tests green · lint and typecheck clean ·
migration applies and rolls back · packet inspector UI demonstrates explanation
against seeded data.
