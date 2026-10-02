# Spec 145D — Profile Claim Subject Filtering

> **Status:** implemented (2026-09-23); re-verified 2026-10-02 (full unit suite; `profile-subject-filtering` 2/2 and `discovery` 10/10 on the local test database).
>
> **Scope:** the authority profile correction workflow (`reputation_profile_correction_v1`) proposes only claims whose subject is the client or one of its recorded people. It reuses the existing deterministic subject filter in canonical extraction.

## Problem

Since Specs 145B and 145C, a real `profile.error_detected` run ingests the third-party profile page and runs `extractClaimsFromSource`. `dom.extract_canonical_claims` (`lib/automation/nodes/claim-extraction.ts`) calls it **without** `subjectAllowList`. The extraction schema documents what happens then (`lib/knowledge/extraction/claims.ts:183-194`): with no list, *every* claim on the page is proposed. Profile and directory pages routinely name other agents, brokerages, listings and reviewers. Those claims would enter the client's review queue as `proposed`, and `compare` would test them against the client's approved facts as if they were about the client.

## What already exists (reused, not rebuilt)

- **Deterministic filter.** `extractClaimsFromSource` accepts `subjectAllowList: string[]`. After the verbatim, fact-only and date guards, `subjectIsInScope(draft.subject, allowList)` keeps a claim only if its subject scores `exact` or `probable` against an allowed name (`scoreNameMatch`, `lib/knowledge/normalize.ts`). Any other claim is pushed to `rejected` with the reason *"The subject "…" is not this client or one of its people."* and is **never inserted**: no `claims` row, no `evidence` row, no `claim.proposed` event. This check runs in code after the model returns, not through prompt wording. It is covered by `tests/unit/discovery-filter.test.ts:222-241`.
- **Identity source used by discovery.** `loadIdentity` in `lib/knowledge/discovery/service.ts:387-430` (private) reads:
  - `companies.name` and `companies.aliases` through `projects.subject_company_id`;
  - principals from `knowledge_entities` where `project_id = <client>`, `entity_type = 'person'` and `status = 'active'` ("an entity row is something a human already accepted as a person"). Discovery reads at most 2.

  It then builds `subjectAllowList = [name, ...aliases, ...principals]` (`service.ts:146-150`).
- **What the event carries.** The `profile.error_detected` payload (`lib/events/catalog.ts` `profileError`) is `{ profileType, profileUrl, findingId?, severity }`. It contains no subject identity, and it must not be trusted as one.

## Decisions

1. **Where the authoritative identity comes from.** The client's recorded identity only, scoped by `ctx.projectId`:
   - `companies.name` of `projects.subject_company_id` (the client's own business name);
   - `companies.aliases` of that company;
   - `knowledge_entities.canonical_name` for **all** active `person` entities with `project_id = ctx.projectId`.

   Never from the event payload, the fetched page, upstream node output, `entity_aliases` rows observed from ingested material, or shared entities (`project_id is null`).
2. **Reuse `subjectAllowList`.** It is the deterministic mechanism that exists; no new filter, prompt change or schema change. `lib/knowledge/extraction/claims.ts` is **not modified**.
3. **One identity loader, shared.** Move the identity read out of discovery's private `loadIdentity` into an exported `loadClientSubjectIdentity(projectId)` with a pure `subjectAllowListFor(identity)`, in `lib/knowledge/entities/subject-identity.ts`. The loader returns a lookup result (`client_not_found` | `no_subject_company` | `resolved`). Discovery's `loadIdentity` calls it and keeps its own behavior exactly: it still caps principals at 2 (now a named constant, `DISCOVERY_PRINCIPAL_LIMIT`), still skips the person read when principals are supplied, still throws the same `not_found` / `conflict` errors, and still composes its own allow list as before (`[name, ...aliases, ...principals]`). It does not use `subjectAllowListFor`, because trimming could turn a whitespace-only name into an empty list, which means "unscoped". The profile node uses every active person. A profile page is often about one specific team member, and rejecting that person's claims would hide real errors.
4. **Representing names.** `subjectAllowListFor` returns `[name, ...aliases, ...principals]`:
   - each entry is trimmed;
   - blanks are dropped;
   - entries are de-duplicated case-insensitively, keeping the first spelling;
   - order is name, then aliases, then principals.

   Team or brand names belong in `companies.aliases`. `team` / `organization` entities are not added (the same as discovery).
5. **How extraction receives it.** In `dom.extract_canonical_claims`, after the project-scope and test-mode checks and **before** fetch validation and ingestion:
   1. `const identity = await loadClientSubjectIdentity(ctx.projectId)`, then `const subjectAllowList = subjectAllowListFor(identity)`.
   2. Call `extractClaimsFromSource(user, { sourceArtifactId, subjectAllowList })`.

   The list is built only by these two calls. It is never merged with config, payload or upstream data.
6. **When identity cannot be resolved.** If the project is not found or has no subject company, the loader returns `client_not_found` / `no_subject_company`. The node then returns **`safe_stop`** with the reason *"the client has no subject company, so claims on a third-party page cannot be attributed to it"*: no ingestion, no extraction, no writes. The node must **never** call extraction with an empty or missing list, because `subjectIsInScope` treats an empty list as "no scoping". Code must enforce this: if the list is empty (for example, a whitespace-only company name), return `safe_stop` with *"the client's recorded identity has no usable name…"*.
7. **Unrelated entities are rejected, not stored.** This is existing behavior: out-of-scope drafts go to `rejected` and are never inserted. The node output adds `rejected: { wording, reason }[]` (the list extraction already returns) alongside the existing `rejectedCount`, so the operator can see what was dropped and why. Nothing else in the output changes.
8. **Provenance and proposed-only are unchanged.** All of the following behave as in Spec 145B:
   - the same `ingestSource` call and `sourceArtifactId`;
   - claims are inserted only as `'proposed'`;
   - the verbatim quote check, the fact-only guard, the duplicate-candidate check, code-decided materiality, entity resolution and the contradiction scan;
   - the unchanged-duplicate safe stop and the test-mode safe stop.

   The filter can only **remove** candidates. It never adds, rewrites or approves one.

## Tenant / Project Isolation
- Identity reads are keyed by `ctx.projectId` alone: `projects.id = $projectId`, then `knowledge_entities.project_id = $projectId`. Shared entities (`project_id is null`) and other clients' entities are excluded.
- `companies` is a global table, but it is reached only through the client's own `projects.subject_company_id`.
- Nothing supplied by the payload, the page or upstream data can widen the list or change which project it is read for.

## Non-Goals
- Changing `subjectIsInScope` / `scoreNameMatch` semantics. Known limitation: `probable` includes substring containment, so if the client is "Compass Realty Group", a claim whose subject is "Compass" is kept. Changing that would also change discovery.
- Pronoun or unnamed subjects (for example "She has 20 years…"). They are rejected by the existing filter; resolving them is out of scope.
- Using `entity_aliases`, `team` / `organization` entities, or the page's own text to widen identity.
- Cross-artifact claim de-duplication, the `detect_contradictions` migration, onboarding, the scheduled scan's profile source, model routing, measurement providers.

## Tests

**Unit**, new `tests/unit/subject-identity.test.ts`, with `@/db/client` mocked:
- `loadClientSubjectIdentity` returns the company name, the aliases and **all** active person names, and both queries receive exactly `ctx.projectId`.
- It returns `client_not_found` or `no_subject_company` and does not run the person read; `subjectAllowListFor` returns `[]` for a whitespace-only identity.
- `subjectAllowListFor` orders name, then aliases, then principals; trims; drops blanks; de-duplicates case-insensitively; and always contains the name.

**Unit**, extend `tests/unit/profile-canonical-claim-extraction.test.ts`, with the loader mocked:
- `extractClaimsFromSource` receives `{ sourceArtifactId, subjectAllowList }`, and the list equals `subjectAllowListFor(identity)`.
- Unresolved identity returns `safe_stop`, and `ingestSource` and `extractClaimsFromSource` are not called.
- An empty list (a defensive case, forced through the mock) returns `safe_stop`, and extraction is not called with `[]` or `undefined`.
- Identity-looking fields in the payload or upstream data (for example `payload.subjectName` or `fetch_profile.data.title`) do not appear in the list.
- The loader is called with `ctx.projectId`, not a project id from the payload.
- The output includes `rejected` passed through from extraction.
- All existing 145B cases keep passing (test mode, fetch validation, duplicate, failures).

**Regression**, discovery:
- `tests/unit/discovery-filter.test.ts` passes unchanged.
- Add unit cases: `DISCOVERY_PRINCIPAL_LIMIT` = 2, and the loader passes the cap to the person query and skips that query when principals are supplied.
- `tests/integration/discovery.test.ts` passes unchanged.

**Integration**, new `tests/integration/profile-subject-filtering.test.ts`. It runs only when `TEST_DATABASE_URL` is set, and uses a stub agent caller with no model:
- Seed client A with a subject company, an alias and a person entity. Seed client B with a person "Other Agent". Ingest a page for A that names A's person and "Other Agent" / "Greystar".
- Call `extractClaimsFromSource` with `subjectAllowListFor(await loadClientSubjectIdentity(A))`.
- Assert:
  - only the claims about A's subject are stored, with `status = 'proposed'` and `source_artifact_ids` equal to that artifact;
  - no `claims` or `evidence` rows exist for the other subjects, and `rejected` names them with the out-of-scope reason;
  - B's person is not in A's list;
  - a fabricated (non-verbatim) quote about A is still rejected, so the existing guards still apply alongside scoping.

## Acceptance Criteria
- [x] `dom.extract_canonical_claims` always passes a non-empty `subjectAllowList` built only from the client's recorded identity.
- [x] A client with no resolvable identity safe-stops before ingestion and extraction.
- [x] Claims about other people or businesses are rejected and never stored. (Proven against the database by `tests/integration/profile-subject-filtering.test.ts`.)
- [x] `lib/knowledge/extraction/claims.ts` and `lib/knowledge/sources/ingest.ts` are unchanged. Proposed-only, verbatim, materiality and provenance behavior is unchanged.
- [x] Discovery behavior is unchanged: the same identity errors, a principal cap of 2 and the same allow list.
- [x] Identity is read only for `ctx.projectId`, with no cross-client or shared entities.
- [x] No workflow definition, event schema, prompt, model routing or measurement-provider change.
- [x] `npm run typecheck`, `npm run lint`, the relevant unit tests, the integration tests and `git diff --check` pass. (2026-09-23, local `llm_optimizer_test`: `profile-subject-filtering` 2/2; `discovery` 10/10, after its stale fixture category `"operations"` was corrected to `"market"`.)

## Files Expected To Change
- `lib/knowledge/entities/subject-identity.ts` (new): `loadClientSubjectIdentity`, `subjectAllowListFor`.
- `lib/knowledge/discovery/service.ts`: `loadIdentity` delegates to the shared loader. `DISCOVERY_PRINCIPAL_LIMIT = 2` is declared beside the module's existing constants (`DEFAULT_MAX_PAGES`, `FETCH_DELAY_MS`). Discovery's search provider, model and queries are untouched.
- `lib/automation/nodes/claim-extraction.ts`: resolve identity, pass `subjectAllowList`, safe-stop when identity is unresolved or the list is empty, output `rejected`.
- `tests/unit/subject-identity.test.ts` (new, includes the discovery cases), `tests/unit/profile-canonical-claim-extraction.test.ts`, `tests/integration/profile-subject-filtering.test.ts` (new).
- `DECISIONS.md`: the identity source, all principals for profiles versus 2 for discovery, and the safe stop on unresolved identity.

## Risks
- **False negatives.** A claim about the client written under an unrecorded name or a pronoun is rejected. That is safer than proposing claims about other businesses, it is visible in `rejected`, and it is fixed by recording the alias or person.
- **Containment matches.** These are described under Non-Goals and are unchanged from discovery.

> **UNRESOLVED QUESTIONS:** none
