# Spec 008 — Client Knowledge Base

> Status: done (2026-07-27)
> Depends on: specs/001–007 · docs/15 (multi-client model)
> Branch: feat/008-client-knowledge-base
>
> Implementation notes: subject resolution falls back to the legacy global
> is_self company when a project has no explicit subject (migration path;
> is_self is deprecated and its one-per-registry constraint dropped). Parse
> and scoring scope = subject + registry companies that are not other
> projects' subjects (no cross-client talk, proven by test). Claim keys are
> normalized snake_case; approval supersedes the prior approved claim per
> key. Seeded live: the pilot client (link-in-bio for real estate agents — operator-
> stated 2026-07-27) as subject with one approved positioning claim
> (the domain is a PLACEHOLDER — verify), competitors Linktree/
> Beacons/Stan/Milkshake/Carrd, frozen "Realtor link-in-bio" v1, and
> Baseline #1 executed on gpt-5.4-mini (16/16, $0.036).

## Goal
Turn each project into a **client engagement** with a verified factual
record: a per-project subject company (replacing the global `is_self`), and a
claims register where every fact an agent may use has canonical wording,
evidence links, an as-of date, and human approval. After this spec, "what is
the client" is data the system enforces, and adding a second client (a realtor, a
surgeon) is creating a project — not forking the tool.

## User stories
- As an operator, I create a client project and set its subject company; all
  parsing/scoring for that project measures that subject.
- As an operator, I maintain the client's claims ("$3.5B career sales as of
  2026-07"), each with evidence links and status: proposed → approved /
  rejected / superseded. Only approved claims are agent-usable.
- As an operator, conflicting variants of the same fact are surfaced side by
  side with a recommended canonical wording awaiting my confirmation.
- As the system, downstream features (content drafts, reports) reference
  claims by id — never free-text facts.

## Database changes
Migration `008_client_knowledge.sql`:
- `projects.subject_company_id uuid references companies(id)` — the client.
  Backfill: current `is_self` company becomes the subject of every existing
  project; then drop the `companies_one_self` unique index (keep the column,
  deprecated, for one release).
- Parser/scoring read the project's subject instead of global is_self;
  competitors remain per-project (specs/005 already scoped them).
- `claims`: id, project_id fk, key (slug, e.g. `career_sales_volume`),
  canonical_text, value jsonb (structured value where applicable), as_of date,
  status check (proposed/approved/rejected/superseded), approved_by,
  created_by, created_at. Unique (project_id, key) where status='approved'.
- `claim_evidence`: claim_id fk, evidence_id fk (existing evidence table —
  extend `kind` check with 'url'; add `url text` column for external sources).
- `claim_conflicts` view or query: proposed claims sharing a key with
  different values.

## API (server actions)
| Action | Notes |
|---|---|
| `setSubjectCompany` | project active; company not archived; audit `project.subject` |
| `proposeClaim` | operator or agent (status proposed); evidence required (≥1 link) |
| `approveClaim` / `rejectClaim` | approving supersedes the previously approved claim with the same key (status superseded, never deleted) |
| `listClaims(projectId)` | with evidence + conflict grouping |

## Edge cases
- Changing the subject company mid-history → allowed with a warning banner;
  historical mentions/scores keep their company ids (immutable), charts
  annotate the change like a version boundary.
- Claim approved, later found wrong → supersede with a corrected claim;
  content referencing the old claim id gets a `stale_claim` task (specs/010).
- Two projects sharing a company (client is a competitor of another client) →
  supported; claims are per-project.
- Migration on existing data: exactly-one-is_self exists → becomes subject of
  all current projects; parse refusal message updates from "no is_self" to
  "project has no subject company".

## Acceptance criteria
- [ ] Creating a project + subject + approved claims requires no SQL.
- [ ] Parser mentions and scores target the project's subject (integration
  test: two projects, two subjects, one run each — no cross-talk).
- [ ] A proposed claim cannot be referenced by content/report drafters;
  approving it supersedes the prior approved version, preserving history.
- [ ] Claim approval/rejection is audited with user identity.
- [ ] Existing single-client data migrates cleanly (rollback tested).

## Test cases
Unit: claim key normalization, conflict grouping. Integration: subject
scoping across two projects; supersede chain; evidence requirement; migration
up/down on seeded data.

## Definition of done
Per `specs/_TEMPLATE.md`, plus: the client's real subject company, aliases, and
first approved claims entered through the UI (requires the operator to supply
the actual facts — the system stops guessing what the client is).
