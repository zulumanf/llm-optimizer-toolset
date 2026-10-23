# Spec 145B — Canonical Profile Claim Extraction

> **Status:** implemented (2026-09-23); re-verified 2026-10-02 (full unit suite; `knowledge-layer` 28/28 and the automation and workflow integration suites on the local test database).
>
> **Scope:** Authority profile correction workflow – replace weak automation `extract_claims` with the canonical `extractClaimsFromSource` path.

## Status
implemented (2026-09-23). Planned 2026-09-21. Live-input wiring, subject filtering and cross-artifact de-duplication followed in Specs 145C, 145D and 145E.

## Problem
The current authority profile correction workflow (triggered by the `profile.error_detected` domain event) invokes the **weak automation** agent `extract_claims`. That agent fetches a public profile via `cms.fetch_public_page`, then calls an LLM to produce **proposed** claims from the fetched content. The LLM pipeline for profile claims is **not** the canonical extraction path used elsewhere in the system, leading to:

* Duplicate claim‑extraction logic (maintainability).
* Inconsistent provenance – the LLM may generate claims from memory rather than the exact observed page.
* Difficulty aligning with the existing evidence graph expectations.

## Current Architecture
* **Trigger** `profile.error_detected` (weekly or event‑based) → **Node** `fetch_profile` (`cms.fetch_public_page`).
* **Node** `extract` uses `agent('extract_claims')`, which internally
  * obtains the page content
  * feeds it to an LLM extraction agent.
* **Node** `approved_facts` builds an evidence packet of currently approved facts.
* **Node** `compare` runs `detect_contradictions` with the LLM‑generated claims vs approved facts.
* Subsequent nodes draft, verify, approve, and submit corrections.

## Scope
* Replace the **extract** node so that it performs **canonical source ingestion** followed by **canonical claim extraction**:
  1. `cms.fetch_public_page` (unchanged) observes the public profile and reports its URL and reachability.
  2. The new `canonical_extract` node calls the canonical `ingestSource` on that URL, producing a `source_artifact` with full provenance.
  3. It then runs the **canonical extraction** function `extractClaimsFromSource` against that artifact to generate **proposed** claims.
* `compare` changes only its context configuration (it receives observed claims and approved facts as separate named contexts via the existing `contextPaths` mechanism). All other downstream nodes remain unchanged.
* No changes to the `detect_contradictions` implementation (prompt, schema, routing) or its model.
* The generic `extract_claims` weak automation remains available for other contexts.

## Non-Goals
* Moving `detect_contradictions` to an open‑weight inference path.
* Modifying the client‑onboarding workflow or any other automation outside authority profile correction.
* Adding or removing any proprietary AI model beyond existing allowed internal models.
* Renaming events or changing the user‑facing graph schema.

## Slice 1 — Authority Profile Correction
### Required Data Flow
1. **Trigger**: `profile.error_detected` (with payload `{profileUrl}`)
2. **Action**: `fetch_profile` – `cms.fetch_public_page` (unchanged)
   * Returns `{ ok, provider, data: { url, status, reachable, excerpt } }`. It does **not** create a source artifact; its `excerpt` is bounded to 2,000 characters of raw HTML and is not used for extraction.
3. **Action**: `canonical_extract` – handler `dom.extract_canonical_claims`
   * Calls `ingestSource` with `projectId = ctx.projectId`, the observed `url`, `origin: "url_fetch"`, `sourceType: "website"`, `privacy: "public"`, the fetch `provider`, and `workflowRunId`. This writes the `source_artifacts` row (bytes stored, `sha256`, `storage_key`, `byte_size`, version/supersession) and its `extracted_documents` row (parsed text).
   * Calls `extractClaimsFromSource` with the returned `sourceArtifactId`. This writes `claims` rows with `status = 'proposed'` plus their `evidence` rows, and guarantees each claim's `originalWording` is a verbatim span of the extracted text.
   * Outputs `{ sourceArtifactId, sha256, duplicate, claims, claimCount, rejectedCount }` and reports `costMicroUsd`.
   * Safe-stops (no ingestion, no extraction) when the run is in test mode, when the fetch failed/was skipped/was unreachable/reported no URL, when a new artifact has no usable text, or when the page is unchanged and its artifact already has claims proposed. Fails terminally without a client scope or when ingestion/extraction fails.
4. **Action**: `approved_facts` – load approved facts from the knowledge graph.
5. **Action**: `compare` – `detect_contradictions`
   * Receives **observed** claims from step 3 and **approved** facts from step 4 separately.
   * Returns `contradictions` and `confidence`.
6. **Branches** proceed as in the existing workflow (severity, draft, verify, approve, submit, archive, etc.).

### Source Artifact / Provenance Requirements
* Provenance is produced by the canonical `ingestSource`, not by `cms.fetch_public_page`:
  * `byte_size`, `sha256`, `storage_key`, `created_at` (retrieval time), `original_url`, `provider`, `workflow_run_id`.
  * `privacy_classification = public`, `source_type = website`, `origin = url_fetch`.
* The artifact is **immutable** and stored in `source_artifacts`; a changed page creates a new version that supersedes the old one, and identical bytes return the existing artifact (`duplicate`).
* The tenant scope is `ctx.projectId` only (the run's client); it is never read from the payload or upstream data.
* Extraction references the artifact (`sourceArtifactId` returned by ingestion — never constructed) and reads the source via the artifact id, not via a URL.
* Background writes are attributed to the platform principal (`systemUser()`, migration 037).

### Claim State / Human Approval Requirements
* All claims produced by `extractClaimsFromSource` are **proposed** (`status = 'proposed'`).
* No claim is automatically approved; approval is still gated via the `approve_profile_correction` step.
* `detect_contradictions` receives two contexts via `contextPaths`:
  * `observedClaims` → `canonical_extract.claims`
  * `approvedFacts` → `approved_facts` (from `dom.build_evidence_packet`, approved claims only).
* The comparison logic remains unchanged; model output is not promoted.

## Workflow Changes
* Replace the **agent** node `extract` with `step("canonical_extract", "dom.extract_canonical_claims", …, { contextPath: "fetch_profile" })`.
* The handler lives in `lib/automation/nodes/claim-extraction.ts` and is registered through `domainNodes` in `lib/automation/nodes/domain.ts`.
* The node outputs `canonical_extract.claims`, which `compare` reads via `contextPaths.observedClaims`; `compare`'s old `contextPath` is removed.

## Test Plan
* **Unit tests** — `tests/unit/profile-canonical-claim-extraction.test.ts` (handler, canonical functions mocked):
  * Client scope required; test mode safe-stops; failed/skipped/unreachable/URL-less fetches safe-stop — none ingest.
  * `ingestSource` receives the system user, `ctx.projectId` (payload project ids ignored), the observed URL and the canonical provenance fields.
  * `extractClaimsFromSource` receives exactly the ingested `sourceArtifactId`; proposed claims and cost are returned.
  * Ingestion/extraction failures fail terminally; empty text and unchanged already-extracted pages safe-stop; the duplicate status read is project-scoped.
* **Workflow tests** — `tests/unit/profile-correction-workflow.test.ts`:
  * No `agt.extract_claims` node; `canonical_extract` uses `dom.extract_canonical_claims`; `compare` has the two named contexts and no `contextPath`; they resolve independently; the definition validates.
  * Regression: `agt.extract_claims` stays registered and client onboarding still uses it.
* **Existing coverage relied on**: `tests/integration/knowledge-layer.test.ts` (proposed-only claims, verbatim quote verification, cross-client source isolation) and `tests/unit/automation-workflows.test.ts` (handler namespacing, every graph validates).

## Acceptance Criteria
* [x] The `profile.error_detected` workflow no longer invokes the weak automation node `extract_claims`.
* [x] The workflow uses the URL observed by `cms.fetch_public_page` to create, via `ingestSource`, a `source_artifact` representing the observed profile page.
* [x] The canonical extraction function `extractClaimsFromSource` is called with the ingested artifact id and returns claims with `status = 'proposed'`.
* [x] The `detect_contradictions` node receives **observed** claims and **approved** facts separately.
* [x] No new proprietary internal‑model dependency is introduced.
* [x] The generic `extract_claims` weak automation remains available and unchanged.
* [x] The system’s workflow path validation passes (no missing edges or context errors).
* [x] Running `npm run typecheck` succeeds.
* [x] Running `npm run lint` succeeds.
* [x] All relevant unit/integration tests pass. (2026-09-23: unit pass; `knowledge-layer` 28/28 on the local test database, covering proposed-only claims, verbatim quote verification and cross-client isolation.)
* [x] `git diff --check` passes.

## Deferred Slice — Client Onboarding
The client onboarding process (`client.created` event) remains unchanged during this slice.
We defer handling the absence of sufficient source evidence for onboarding until a later spec that defines when and how the onboarding workflow should source profile data and perform claim extraction.

## Future Spec — detect_contradictions Open-Weight Migration
When/if the `detect_contradictions` function is promoted to an open‑weight inference agent, a new spec (e.g., **Spec 146**) will outline that migration, ensuring that the authority workflow continues to use the canonical extraction path while upgrading the contradiction detection model.

## Files Expected To Change During Implementation
* `lib/automation/nodes/claim-extraction.ts` – the `dom.extract_canonical_claims` handler.
* `lib/automation/nodes/domain.ts` – register it in `domainNodes`.
* `lib/automation/workflows/authority.ts` – replace the `extract` node; set `compare`'s `contextPaths`.
* `DECISIONS.md` – URL ingestion, test-mode safe stop, unchanged-page safe stop.
* `tests/unit/profile-canonical-claim-extraction.test.ts`, `tests/unit/profile-correction-workflow.test.ts`.

## Risks / Failure Modes
* **Proposed claims incorrectly marked as approved:** Must enforce that the extraction function never writes `approved` status.
* **Missing provenance:** Provenance comes from `ingestSource`; the node never extracts from a fetch that did not succeed, and never constructs an artifact id.
* **Resolved by Spec 145C:** the `profile.error_detected` payload carries `profileUrl` while `cms.fetch_public_page` requires `url`. `fetch_profile` now maps `{ url: "payload.profileUrl" }` through node-level `inputFields`, and the entry node is `domain_event`.
* **Resolved by Spec 145E:** a page whose bytes change creates a new artifact each scan. Canonical storage now de-duplicates claims across artifacts, so a restated fact is not proposed again; its evidence is still recorded.
* **Determinism loss:** Ensure the extraction process remains deterministic; the same page should yield the same claims under identical conditions.
* **Workflow validation errors:** Adding a new node can inadvertently break the existing edge graph; thorough validation is required.
* **Performance regression:** Canonical extraction may have different runtime characteristics; monitor for increased queue latency.

## Definition of Done
* The workflow definition compiles and the graph validates.
* No unit or integration tests related to authority profiling fail.
* Code changes are left uncommitted for the human operator to review and commit (coding agents do not commit).
* Relevant documentation files (this spec) are present and up‑to‑date.
* All acceptance criteria are marked as satisfied in the spec body.

---

> **UNRESOLVED QUESTIONS:** <none>

---

> **FILES CHANGED:** see "Files Expected To Change During Implementation".

---

> **SPEC CREATED:** specs/145b-canonical-profile-claim-extraction.md
