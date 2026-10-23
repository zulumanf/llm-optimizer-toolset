# Spec 145E — Cross-Artifact Claim Deduplication

> **Status:** implemented (2026-09-23); re-verified 2026-10-02 (full unit suite; `claim-cross-artifact-dedup` 11/11, `knowledge-layer` 28/28 and `discovery` 10/10 on the local test database).
>
> **Scope:** canonical claim storage (`extractClaimsFromSource`) stops inserting a second claim row for a fact the same client already holds, when it is observed again in a different source artifact. The new observation's provenance is kept. Every canonical caller gets the same invariant.

## Problem

`extractClaimsFromSource` (`lib/knowledge/extraction/claims.ts`) de-duplicates only **within one extraction run** (`claimCandidateFingerprint` / `seenCandidates`). Spec 145B's unchanged-page safe stop covers only byte-identical re-ingestion. When a profile page changes at all (a new review, a timestamp, a reordered list), `ingestSource` stores a new artifact version. Extraction then inserts a fresh `proposed` row, with a fresh evidence row and a `claim.proposed` event, for every fact the client already has. The facts may be proposed, approved, rejected or superseded. Each re-scan adds another copy to the review queue. Discovery re-reads pages over time and has the same defect.

## Current storage (what the key can use)

For each accepted draft, `claims` stores:
- `project_id`
- `key = subject__predicate`, truncated to 60 characters (**not** unique and **not** an identity: it has no object or value)
- `canonical_text` (the model's `normalizedWording`)
- `value` (jsonb)
- `as_of` (`draft.asOf ?? artifact.effective_date`)
- `status`
- `evidence_ids[]`
- `normalized_predicate`
- `subject_entity` (free text)
- `subject_entity_id` (exact entity match only)
- `category`
- `materiality`
- `privacy_status` (the artifact's privacy class)
- `source_artifact_ids[]`

`draft.object` is **not stored** in any column; it survives only inside `canonical_text`. `draft.originalWording` survives only inside `evidence.note`.

Existing patterns this spec relies on:
- `claims` rows are mutable while `proposed` (`setClaimWording`, `setClaimDates`, `rejectClaim` update them).
- `approveClaim` snapshots `evidence_ids` into the immutable `claim_versions`.
- `evidence` rows (`kind 'source'`, `ref_id` = artifact) can exist independently of a claim.
- `pg_advisory_xact_lock(hashtext(…))` serialises a critical section (`lib/parsing/backfill.ts:143`).
- `claims_predicate_idx (project_id, normalized_predicate)` exists.

## Decisions

### 1. Layer
The check lives **inside `extractClaimsFromSource`'s storage transaction**. That is the single canonical claim writer, used by the profile node (Spec 145B), discovery and `scripts/seed-knowledge.ts`. It is not placed in the authority workflow. The check runs **after** all existing guards: verbatim excerpt, fact-only, date, `subjectAllowList`, the within-run fingerprint, materiality and entity resolution. Those guards are unchanged and still decide what may be stored at all.

### 2. Scope
- **Same project only.** Candidates are read with `project_id = artifact.project_id` (the artifact's own project, as today). No lookup crosses clients.
- **Statuses considered:** `proposed`, `approved`, `rejected`, `superseded`. All claim rows are kept forever (nothing is deleted), so every one of them is a fact the client "already holds".
- **Subject scope:** the normalized subject must be equal (see the key). There is no fuzzy matching; `subjectIsInScope` / `scoreNameMatch` are neither used nor changed.

### 3. Duplicate identity
A draft duplicates an existing claim when **all** of these are equal:

| Component | Draft side | Stored side | Normalization |
|---|---|---|---|
| project | `artifact.project_id` | `project_id` | — |
| subject | `draft.subject` | `subject_entity` | `normalizeClaimText` |
| predicate | `normalizePredicate(draft.predicate)` | `normalized_predicate` | existing function |
| category | `normalizeCategory(draft.category)` | `category` | existing function |
| value | `draft.value` | `value` | JSON equality (`null` only equals `null`; `42` ≠ `"42"`) |
| as-of | `draft.asOf ?? artifact.effective_date` | `as_of` (`YYYY-MM-DD`) | null-safe equality |
| statement | `draft.normalizedWording` | `canonical_text` | `normalizeClaimText` |

`normalizeClaimText(s)` is new and pure: lowercase, trim, collapse whitespace, and strip trailing `.`, `,`, `;` and `:`. There is no stemming, no synonym handling and no paraphrase detection.

The statement is part of the key because `object` isn't stored. Without it, *"affiliated with Compass"* and *"affiliated with Douglas Elliman"* would share subject, predicate, category, value and as-of, and would wrongly merge. The key is deliberately conservative. A paraphrase of a known fact counts as new (it is proposed again, which is safe and visible). Two different facts can merge only if their normalized statements are identical.

`claimIdentity(...)` builds the key, and `sameClaimIdentity(a, b)` compares two keys. Both are pure and exported. Candidates are fetched with the indexed `project_id` + `normalized_predicate` pair and compared in code, so SQL and TypeScript normalization can never drift apart.

### 4. How cases are distinguished
- **Identical fact from a newer artifact:** every key component is equal, so it is a duplicate (see §5).
- **Genuinely changed value** (for example 40 homes becoming 42): `value` differs (and the statement usually does too), so it is a **new proposed claim**. The unchanged contradiction scan then runs over it. Under its existing rules, a value divergence is flagged when the statements agree and the values differ; different statement text is treated as a different fact (detector behavior since 2026-07-30, deliberately not changed here).
- **Changed as-of date:** `as_of` differs, so it is a **new proposed claim**. A fact stated for a new period is a new observation.
- **Conflicting claim** (the same subject and predicate with a different object, value or statement): the key differs, so it is a **new proposed claim**, and `scanProjectContradictions` runs exactly as today. Contradictions are never suppressed.
- **Same wording about a different subject:** the subject differs, so it is a **new proposed claim** (when the allow list admits that subject).
- **Different privacy class** (the match is `proposed`, but its `privacy_status` ≠ the new artifact's `privacy_classification`): no linking. It is inserted as a **new proposed claim**, as today. That way evidence from a more restricted source can never attach to a less restricted claim.

### 5. What a duplicate does
The existing claim is chosen deterministically by `selectClaimMatch`. A same-privacy `proposed` match is linked. Otherwise the first `approved` > `superseded` > `rejected` match is already known. If the only matches are proposals of another privacy class, the draft is inserted as a new proposal. Ties break by newest `created_at`, then `id`. Candidate rows are locked `for update`. The new evidence row is **always** inserted (`kind 'source'`, `ref_id` = the new artifact, the same excerpt note as today), so the new source's provenance is never discarded. Then:

| Matched status | Effect |
|---|---|
| `proposed` (same privacy) | **Link.** Append the new evidence id to `evidence_ids` and the artifact id to `source_artifact_ids` (unless already present), and set `updated_at`. Canonical text, value, confidence and materiality are unchanged: the first observation's wording is kept. No new row and no `claim.proposed` event. The reviewer sees one proposal with every source that states it, and approval snapshots them all into `claim_versions`. |
| `approved` | **Already known.** No new row, and the approved claim is **not modified**. Its evidence set is what a human approved and what `claim_versions` recorded, and silently widening it would bypass that approval and risk a privacy mismatch. The standalone evidence row plus the audit entry record the corroboration. |
| `superseded`, `rejected` | **Already known.** No new row, and the human's decision stands, so the claim isn't re-proposed each time the page changes. The evidence row and the audit entry record the observation, and it still reaches `compare` (see §6). |

- **Audit:** the existing `knowledge.claims.extract` audit detail gains a `matched: [{ claimId, status, evidenceId, resolution }]` field.
- **Concurrency:** the storage transaction takes `pg_advisory_xact_lock(hashtext('claims:' || projectId))` before reading candidates, so two concurrent extractions for one client cannot both insert the same fact.

### 6. Result shape (additive)
`ClaimExtractionResult` gains `matched: MatchedClaimObservation[]`. Each entry has:
- the draft fields;
- `claimId` (the existing claim);
- `existingStatus`;
- `resolution: "linked" | "already_known"`;
- `evidenceId`;
- `materiality`;
- `subjectEntityId`;
- `requiresIndependentVerification`;
- `excerptVerified: true`.

`proposed` keeps meaning "rows inserted by this run". `rejected` is unchanged. Discovery's counters (`claimsProposed`) are therefore unchanged in meaning.

**Profile node (`lib/automation/nodes/claim-extraction.ts`).** `compare` must see *everything the page states about the client*, including facts already known. Otherwise a page that restates a previously rejected error would pass as "clean". The node output therefore becomes:
- `claims: [...proposed, ...matched]`;
- `claimCount = claims.length`;
- new `proposedCount` and `matchedCount`.

Each `matched` entry carries its `existingStatus`. No workflow definition change is needed: `compare` still reads `canonical_extract.claims`.

## Preserved
- **Proposed-only:** the only insert is still `'proposed'`. Linking only ever touches `proposed` rows, and code never approves, un-rejects or un-supersedes.
- **Human approval:** approved claims and `claim_versions` are never mutated by extraction.
- **Isolation:** candidates are read and matched only within `artifact.project_id`.
- **Provenance:** every observation gets its evidence row, which references its artifact. Linked proposals list every artifact. Nothing is deleted.
- **The existing checks** (`subjectAllowList`, the verbatim excerpt check, the fact-only check, the date check, code-decided materiality, entity resolution, within-run de-duplication) run unchanged before the identity check.
- **Contradiction handling:** the scan runs unchanged, and changed or conflicting facts are always inserted.
- **Unchanged elsewhere:** Spec 145B's byte-identical safe stop, Spec 145C input wiring, and Spec 145D identity loading.

## Non-Goals
- De-duplication across projects or clients.
- Paraphrase or semantic matching, and any change to subject matching or `normalizePredicate` / `normalizeCategory`.
- Merging, rewriting or cleaning up existing duplicate claims, including historical claims from before Spec 145D that were never subject-filtered.
- New columns, migrations or event types.
- Model routing, the `detect_contradictions` migration, onboarding, measurement providers.

## Tests

**Unit**, new `tests/unit/claim-identity.test.ts` (pure functions, no DB):
- `normalizeClaimText` handles case, surrounding and internal whitespace, and trailing punctuation.
- `sameClaimIdentity`:
  - identical facts are equal, and case or whitespace differences in the subject or statement are equal;
  - changed `value`, changed `asOf`, `null` versus a value, and `42` versus `"42"` are all different;
  - a different subject with the same wording is different, as are a different predicate, a different category, and a different statement with the same subject, predicate and value (the Compass versus Douglas Elliman case).
- The match selector picks by status priority (`proposed` > `approved` > `superseded` > `rejected`), then newest, then id.

**Unit**, extend `tests/unit/profile-canonical-claim-extraction.test.ts`:
- Node output `claims` is `[...proposed, ...matched]` with `proposedCount` and `matchedCount`.
- Matched entries keep `existingStatus`.

**Integration**, new `tests/integration/claim-cross-artifact-dedup.test.ts`. It runs when `TEST_DATABASE_URL` is set and uses a stub agent caller. It sets up artifact v1 and v2 of the same URL with different bytes, both stating the same fact.
1. **Proposed match:** after v2 there is still one claim row, with `evidence_ids` length 2 and `source_artifact_ids = [v1, v2]`, and only one `claim.proposed` event. The result has one `matched` entry (`linked`) and no `proposed` entries.
2. **Approved match:** there is no new row. The approved claim's `evidence_ids`, `source_artifact_ids`, `updated_at` and its `claim_versions` rows are unchanged, a new `evidence` row references v2, and the result is `already_known`.
3. **Rejected and superseded matches:** they are not re-proposed, and the evidence row is recorded.
4. **Changed value:** a new proposed row. **Same statement with a different value:** a new proposed row, and the existing detector records the contradiction. De-duplication never hides a contradiction the detector would flag.
5. **Changed as-of date:** a new proposed row.
6. **Same wording, different subject** (both in the allow list): a new proposed row.
7. **Isolation:** an identical fact in another project is not matched, and the other project's rows are untouched.
8. **Privacy mismatch** (a `client_only` source against a `public` proposal): a new proposed row, and the public proposal is untouched.
9. **Guards still apply:** an out-of-scope subject and a fabricated quote are rejected and never matched or linked.
10. **Concurrency:** two concurrent extractions of the same fact from two artifacts produce one claim row.

Re-run: `profile-canonical-claim-extraction`, `subject-identity`, `knowledge-claim-extraction-guards`, `discovery-filter`, and the integration suites `knowledge-layer`, `discovery` and `profile-subject-filtering`.

## Acceptance Criteria
- [x] A fact already held by the same project is never inserted again from a different artifact.
- [x] New-source provenance is always kept (an evidence row), and it is linked onto the claim when the match is a same-privacy `proposed` claim.
- [x] Approved, rejected and superseded claims, and `claim_versions`, are never mutated by extraction.
- [x] Changed values, changed as-of dates, conflicting statements and different subjects are inserted as new proposed claims, and contradictions are still detected.
- [x] No cross-project matching.
- [x] The profile workflow's `compare` still receives every observed client claim (new and matched).
- [x] The existing guards and `subjectAllowList` behavior are unchanged, and extraction still inserts only `proposed`.
- [x] No migration, event-type, routing or workflow-definition change.
- [x] `npm run typecheck`, `npm run lint`, the unit tests, the integration tests and `git diff --check` pass. (2026-09-23, local `llm_optimizer_test`: `claim-cross-artifact-dedup` 11/11, including concurrency; `profile-subject-filtering` 2/2; `knowledge-layer` 28/28; `discovery` 10/10, after its stale fixture category `"operations"`, which the strict enum from `ca6fa2c` rejects, was corrected to `"market"`.)

## Files Expected To Change
- `lib/knowledge/extraction/claims.ts`: `normalizeClaimText`, `claimIdentity`, `sameClaimIdentity`, the match selector, the advisory lock, the candidate read, link or already-known handling, the `matched` result and the audit detail.
- `lib/automation/nodes/claim-extraction.ts`: `claims = [...proposed, ...matched]`, plus the counts.
- `tests/unit/claim-identity.test.ts` (new), `tests/unit/claim-cross-artifact-storage.test.ts` (new, the storage transaction against an in-memory table stand-in), `tests/unit/profile-canonical-claim-extraction.test.ts`, `tests/integration/claim-cross-artifact-dedup.test.ts` (new).
- `DECISIONS.md`: the identity key, linking only onto proposed claims, and not mutating approved, rejected or superseded claims.

## Risks
- **Paraphrase misses:** a model that rewords an unchanged fact creates a new proposal. That is safe (the same as today) and visible; semantic matching is deliberately out of scope.
- **Evidence rows with no claim** (for already-known matches): they are discoverable through `ref_id` (the artifact) and through the audit `matched` detail. A claim-to-evidence link table would be a later spec.
- **Wider lock:** the advisory lock serialises one client's extraction transactions. They are short, one per artifact.

> **UNRESOLVED QUESTIONS:** none
