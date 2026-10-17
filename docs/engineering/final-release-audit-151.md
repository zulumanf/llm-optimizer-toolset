# Final release audit — Platform v2 (`feat/151-platform-v2`)

- **Date:** 2026-10-16/17
- **Auditor role:** principal engineer, SRE, security, database, diligence
- **Scope:** the full uncommitted worktree at `/Users/francisco/rf-platform`.

Nothing was committed, deployed or run against production. All results below are **local** unless stated otherwise.

## 1. Verification results

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Typecheck | `npx tsc --noEmit` | PASS |
| 2 | Lint | `npx eslint --max-warnings 0 .` | PASS |
| 3 | Production build | `DATABASE_URL=<local> npm run build` | PASS |
| 4 | Full Vitest | `caffeinate -dimsu npx vitest run` (real Postgres 14, `rf_platform_test`) | **PASS:** 308 files passed, 1 skipped (S3-gated); 3,356 tests passed, 8 skipped |
| 5 | Full Playwright, production build | `npm run build` then `CI=1 npx playwright test` | **PASS:** 80/80 |
| 6 | Migrations up → down 134…126 → up on a fresh database | `scripts/migrate.ts` loop | PASS |
| 7 | Scoring and cutover regressions | `scoring-cutover.test.ts` (5), `measurement-v2.test.ts`, `migration-guards-151.test.ts` | PASS |
| 8 | Tenant isolation and organizations | `tenant-isolation-151.test.ts`, `organizations.test.ts` | PASS |
| 9 | Job locking and idempotency | `job-fencing.test.ts` (10 cases); **12 consecutive full-file passes** after the fixes in §3 | PASS |
| 10 | Backup and restore | `backup.sh` (encrypted, ledger) → `restore.sh` into a scratch database; row counts compared | PASS (local, ~1 s) |
| 10b | Migration 126 down guard | Planted provenance → down refuses; flag proceeds; up re-applies | PASS |
| 11 | Object storage against a **real** S3-compatible server | SeaweedFS S3 gateway in Docker, signature-enforcing: `S3_TEST_ENDPOINT=… npx vitest run tests/integration/object-store-s3.test.ts` | **8/8 PASS** |
| 12 | Artifact sync against the real server | `artifacts-sync.ts` dry run → `--apply` (1,453 files, ~4 s) → `--apply` again (0 uploaded, 1,453 present) | PASS |
| 13 | Sanitizer on adversarial data | Planted email and phone in nested JSON, free text, users; JSON numbers present | PASS (redacted; JSON intact; stamped) |
| 14 | Preflight | `scripts/preflight-151.ts --phase post-migrate` locally | Behaves as designed (BLOCKs on the missing production configuration) |

### 1a. Test-run log

- **Previous "in progress" run** (r6, 20:18): completed, **308/308 files, 3,348/3,348 tests**.
- **Interrupted run** (r5): stopped at 17:09 with no process left. Two unrelated tests logged 595 s and 987 s, and both pass in every other run. Diagnosis: **environmental** (host sleep or kill), not code. Mitigation: final runs use `caffeinate -dimsu`, and Playwright no longer runs concurrently with Vitest.
- **Final run after this audit's fixes:** Vitest 308 files / 3,356 tests passed (310 s, no failures, no interruption); Playwright 80/80; build pass.

### Limitations

- No production data was available. The real-data rehearsal is blocked pending operator action (§8).
- The S3 test target is SeaweedFS, not the eventual provider. Conditional-write (`If-None-Match`) behaviour must be confirmed once on the chosen provider (AWS S3 and Cloudflare R2 document support).
- Multi-worker behaviour was exercised in tests, not under production load.
- `artifacts-sync --audit` was exercised only against a database with 0 recorded artifacts.

## 2. Final diff assessment

**Scale:** 93 tracked files changed (+~1.2k / −~49.8k lines) plus about 75 new files.

**The deletions (~49.8k lines):** 8 files, all intentional.

| File | Lines | Disposition |
|---|---|---|
| `data/internal/mention-revision-3/…offline.json` | 49,256 | Moved to `.local-data/internal/` (gitignored). The only doc reference is updated. **It is still tracked on `main`** (not lost). Founder action: archive it durably (backup bucket) |
| `scripts/{chs,jc-batch2,sav,wil}-contacts.json`, `scripts/{jc-followup,wil-t2-ab}-drafts.json` | ~450 | Moved to `.local-data/campaign-inputs/`; the six scripts that read them are repointed. Still in git history (personal data) |
| `tmp-run-followups.mts` | small | Removed (one-off, hardcoded a production id); no references |

No CI workflow, Dockerfile, test or app code references the removed paths. **No dependency changes** (`package.json` / lockfile untouched).

## 3. Findings and fixes (this audit)

**Independent review result: no Critical findings.**

| Sev | Finding | Status |
|---|---|---|
| High | Object-store write-once was check-then-write; two racing writers could overwrite | **Fixed:** conditional PUT (`If-None-Match: *`; 412/409 → compare sha). Unit race test + real-server race test |
| High | A credential without `s3:ListBucket` returns 403 for missing objects, so every write fails | **Fixed:** actionable error text; preflight probe (missing key must return 404) BLOCKs otherwise; tested both ways |
| High (found by audit tests) | A dead lock connection was queried by the heartbeat and in cleanup. postgres.js 3.4.9 then throws an **uncatchable TypeError** from its own `setImmediate`, which would **crash the worker**; returning that connection to the shared pool poisoned the next borrower | **Fixed:** locks moved to dedicated single-connection clients (`createLockClient`), destroyed after use, never returned to the pool; liveness checked from the pool via `pg_locks` by backend pid; the dead socket is never written to |
| High (found by audit tests) | Lock client inherited postgres.js `max_lifetime` (random 30–60 min) and would silently drop a lock mid-run | **Fixed:** `max_lifetime: 0`, `idle_timeout: 0` on lock clients (verified in driver source) |
| High (found by audit tests) | Worker shutdown `sql.end()` hangs forever after a reserved connection died (reproduced) | **Fixed:** bounded `sql.end({ timeout: 10 })` |
| Medium | Deferred claims could burn a job attempt when the executor's heartbeat re-asserted its lease first (1-in-10 flake) | **Fixed:** `releaseClaim` always returns the attempt; 12/12 passes |
| Medium | Per-run lock connection unwatched; a dead one would let a duplicate executor spend | **Fixed:** watched from the pool; abort and no finalize |
| Medium | CMS publication not bound to its own draft/approval | **Fixed:** the gate requires an approved, same-project approval whose run created that CMS draft from the same asset; the node uses the *client* approval. Integration tests |
| Medium | Migration 126's down step dropped `score_estimates` and provenance columns unguarded | **Fixed:** guarded; refuses while populated unless `--allow-destructive-down` |
| Medium | Downloaded objects without integrity metadata were trusted | **Fixed:** refused |
| Medium | Sanitizer: (a) views aborted the run midway, (b) phone regex corrupted JSON numbers, (c) regex re-hit redacted values, colliding on unique keys, (d) FK error on delete, (e) skipped columns were silent | **All fixed** and re-verified on a copy with planted data; skipped columns are now reported and verification fails the run |
| Low | Cutover coverage not re-checked under the lock | **Fixed:** re-check inside the locked transaction |
| Low | Error webhook could forward emails/phones | **Fixed:** redaction plus a test |
| Low | Roster accepted non-benchmark companies server-side | **Fixed** plus a test |
| Low | Evidence download returned 500 for missing/unavailable files | **Fixed:** 404 / 503 |
| Low | Workflow secrets interpolated inline in `run:` | **Fixed:** passed via `env:` |
| Low | `prepareMeasurement` blocked on a lock indefinitely | **Fixed:** try-lock → conflict |
| Low | Reserve failure stranded a claimed job | **Fixed:** claim released |
| Medium (open) | `learningSummary` / `evaluatePredictions` re-evaluate every plan (2,000-draw bootstraps) on each call; plan approval triggers `pastRealEvaluations` | **Documented.** Negligible at current volume (0 plans); cache before ~100 plans |
| Medium (open) | Scoring bootstrap runs on the worker thread; very large rosters block the event loop for seconds | **Documented.** Lease renewal tolerates it (15 min stale threshold); move to a worker thread if roster × instruments grows large |
| Low (open) | Connection budget: web pool 10 + worker pool 10 + up to 2 lock sessions can exceed a 15-client session pooler under burst (pre-existing) | **Operator:** keep the session-mode pooler (advisory locks require session mode) and size it ≥ 25, or lower pool sizes |
| Low (open) | Scripts outside `lib/db/app/components` are not covered by the scores-read-version guard (count-only readers) | Documented |

## 4. Security assessment

**Verified in code and tests:**
- Every new server action resolves the user and calls `assertCanWrite`.
- Every new internal page is `requireStaffPage`.
- The only new client surface (`/portal/organizations/[id]`) is deny-by-default and hides existence.
- Tenant isolation is tested across 2 clients and 2 brokerages.
- No string-interpolated SQL from user input (the sanitizer quotes catalog identifiers and runs only on local `rf_rehearsal*` databases).
- Credentials are read from env only and never logged.
- A remote Ollama host requires https plus a bearer key.
- S3 requires https except localhost.
- The publish gate sits at the connector boundary.
- Human approval gates are unchanged.

**Open (not code):**
- Personal data in git history.
- RLS still covers only 3 tables (isolation is application-layer).
- CSP/HSTS absent.
- One-click List-Unsubscribe absent.

## 5. Database migration safety

| Property | Status |
|---|---|
| Additive | 9 migrations (126–134): new tables plus nullable columns; no backfill; no rewrite of existing rows |
| Locking | The `ALTER TABLE responses/mentions ADD COLUMN` steps are metadata-only but take a brief exclusive lock. Run when idle (preflight checks in-flight work) |
| Concurrency | The runner takes an advisory lock (two booting workers serialize; tested) |
| Reversible | Down sections tested on a fresh database |
| Data-loss protection | Every spec-151 down refuses while it would destroy rows, unless run with `--allow-destructive-down`. 132 refuses while the switch is past baseline |
| Provenance | Untouched; no UPDATE/DELETE on insert-only tables in new code |

## 6. Scoring cutover safety

| Requirement | Evidence |
|---|---|
| Old dashboards work before cutover | Readers follow `scoring_state` (v1.1); `scores` holds v1.1 only pre-cutover |
| Old app redeployable before cutover | No v1.2 rows in `scores` until the flip; preflight reports compatibility |
| New scores staged | `scores_staging`, insert-only |
| Interrupted rescore resumes | Tested twice, no duplicates |
| Historical versions immutable | Triggers; v1.1 byte-identity test |
| Failed/partial runs | Tested (error-only runs are not "missing") |
| Archived/merged companies | Tested (coverage per run; parity per joined row) |
| No race with scoring | Shared/exclusive advisory lock; the flip waits for an in-flight writer (tested); coverage re-checked under the lock |
| Atomic | One transaction: copy plus flip plus history |
| Rollback | Flip back (tested); refused after legacy retirement |
| Incompatible rollback | **After the cutover, only post-151 images may be deployed** (documented; preflight reports it) |

**Public numbers:** `approved-claims.json` and `marketing-claims-verify` recount from raw rows and never read `scores`. Published audit pages are frozen snapshots (trigger). Neither changes because of the migration or the cutover.

## 7. Storage readiness

**Implemented and verified against a real S3-compatible server:**
- **Content-addressed, write-once objects:** conditional PUT; sha256 in object metadata; download integrity required.
- **Fail-closed behaviour:** a store outage blocks writes before any local write; the retry is idempotent.
- **Cross-service reads:** the web service reads what the worker wrote; a cold cache refetches.
- **Tooling:** sync and audit.
- **Encryption at rest** is provider-side (R2 and S3 encrypt by default). No public or signed URLs are generated: artifacts are served only through authenticated app routes (evidence download, report session gate).
- **Retention:** evidence is immutable and never deleted by code; cost at current size (< 1 GB) is negligible.

**Recommended provider:** Cloudflare R2 (S3-compatible, no egress fees, free tier currently 10 GB; verify current terms). Use a private bucket per environment (`rf-artifacts-prod`, `rf-artifacts-staging`). Create an API token scoped to that bucket with Object Read & Write; R2 tokens include list for the scoped bucket. Use a **separate** bucket for database backups (`rf-backups-prod`) with object lock or versioning.

## 8. Backup and restore readiness

**Local evidence:**
- An encrypted backup was created, recorded and restored.
- A failure is recorded by the ERR trap.
- `backup_stale` raises a high-severity exception after 26 h, or after a failure; tested.
- The preflight BLOCKs on a stale backup.

**Workflows:**
- `backup.yml`: nightly; separate bucket.
- `restore-drill.yml`: monthly; throwaway Postgres; integrity, row counts, cutover status, RTO timing.
- Both are inert until `BACKUPS_ENABLED=true`.

**Not done (operator):** production secrets, a first production backup, a production restore drill.

## 9. Background job reliability

| Scenario | Evidence |
|---|---|
| Same job twice | Impossible: a session advisory lock per job on a dedicated connection; a second claimant defers without burning an attempt (tested, 12/12) |
| Worker crash / database disconnect | Killing the executor's session (`pg_terminate_backend`) releases the job; the dead executor aborts and stands down; another worker completes it (tested). No uncatchable driver error (fixed) |
| Lost lease | The lease is a liveness hint only; exclusivity is the lock |
| Retries | Unchanged backoff; attempts preserved |
| Concurrent acquisition | `SKIP LOCKED` plus lock (tested) |
| Scheduler overlap | `withTickLock` (tested, including release on error) |
| Long benchmark | Per-run lock on its own session, watched; no `max_lifetime` recycling |
| Restart mid-task | The session ends and the lock is released; the stale sweep requeues; handlers are idempotent |
| External side effects | **A database lock cannot cancel an in-flight HTTP call.** Exactly-once effects rely on durable keys: outreach sends (`send_intent_key` unique + RFC Message-ID reconciliation), profile-correction drafts (`run_idempotency_key` unique), video artifacts (`generation_key` unique), the TTS cache (content-keyed, object store checked before paying). Provider calls in an aborted benchmark may finish (bounded spend); captures are deduplicated by a unique index |

**Recommendation:** launch with **one** worker; scale to two after a week of `worker.lock_lost` = 0.

## 10. Client activation readiness

The synthetic lifecycle (`client-lifecycle-rehearsal.test.ts`) runs the steps below with no manual database manipulation. The only exceptions are the simulated passage of time and the recorded intervention, which uses the existing interventions table.

1. Project.
2. Subject and competitors.
3. Prompts frozen.
4. Instrument pinned.
5. Prepare-measurement: two waves, cohort frozen, worker-driven.
6. Analysis and plan.
7. Pre-registered plan, approval, intervention link and post wave (`start_scheduled_run`).
8. Evaluation.
9. Outcome capture and labor ledger.
10. Economics.
11. Report draft with intervals.

Signing, quotes and agreements are covered by `client-engagement-dry-run`.

| Capability | Classification |
|---|---|
| Measurement (API instrument), per-model estimates with intervals, cohorts, pinned instruments | **Ready for actual clients** after migration + rescore + cutover |
| Optimization plan, approvals, tasks, source presence | **Ready for actual clients** (recommendations; human-executed work) |
| Pre-registered experiments and evaluation | **Ready for controlled production validation** (no real intervention evaluated yet) |
| Monthly report v2 data | **Ready for controlled validation** (internal page; portal rendering not done) |
| Outcomes and labor ledgers, economics view | **Ready for actual clients** (manual entry) |
| Brokerage roster | **Implemented, not verified with live data** |
| Classifier precision/recall | **Implemented, no human labels yet.** Do not quote accuracy |
| Prediction scoreboard | **Implemented, no data.** Never advertise adaptive recommendations |
| Automatic claim extraction, profile corrections | **Disabled pending infrastructure** (inference host) |
| Automated CMS publishing | **Disabled pending a client CMS connection**; gated |
| Durable artifacts (video, evidence exports) | **Disabled pending a bucket** (preflight BLOCK) |
| Client agreements | **Pending legal review** (`NOT_REVIEWED` stamp) |

## 11. Operating without the founder (acquisition view)

**Present:**
- Deploy and rollback documentation (`deployment-checklist-151.md`).
- Every env var in `.env.example` and `lib/env.ts`.
- Preflight script; backup and restore workflows; exception queue; error webhook.
- Migration guards; no laptop-only runtime once G3, G4 and G11 are done.

**Still founder-bound:**
- Railway, Supabase, Google Workspace (Gmail sender) and RealTrends accounts.
- Repository on a personal GitHub account.
- Outreach scripts run from a workstation (`scripts/*` with a direct database URL).
- No incident runbook beyond the checklist's rollback table.

## 12. Legal questions for counsel (no conclusions here)

1. **IP assignment.** Founder → company assignment covering code, docs, data, domains. Effect of AI-assisted authorship (nearly all commits co-authored by an AI tool) on ownership and warranties.
2. **RealTrends.** May licensed records be used internally to score prospects, appear (even derived) in client or prospect reports, be retained after the term, and transfer on change of control?
3. **AI provider terms** (OpenAI, Perplexity; Google/Anthropic if enabled). Storage and retention of outputs; aggregation into benchmarks; publication of aggregate statistics; use to compare named businesses; transfer to an acquirer.
4. **Client agreements.** Ownership of measurement data; permission to use anonymized client data for cross-client learning and benchmarks; retention and deletion; change of control; outcome-data handling (client-reported leads).
5. **Prospect data and outreach.** Lawful basis for storing scraped contact details; CAN-SPAM compliance (one-click unsubscribe missing); Gmail API scope verification.
6. **Repository history containing personal data.** Disclosure obligations, and whether to rewrite history before sharing in diligence.

## 13. Recommended deployment sequence

See `deployment-checklist-151.md` §3–4 for exact commands:

1. Preflight.
2. Production backup and restore drill.
3. Bucket and artifact sync.
4. Worker deploy (applies 126–134).
5. Post-migrate preflight.
6. Web deploy.
7. 24 h observation.
8. Enable nightly backups.
9. Rescore history.
10. Sanitized real-data rehearsal.
11. Cutover.
12. 14-day observation.
13. Retire the legacy writer.
14. Scale workers.

## 14. Rollback

See `deployment-checklist-151.md` §5.

| When | Action |
|---|---|
| Before cutover | Previous image (safe) |
| After cutover | `scoring-cutover rollback` plus post-151 images only |
| Storage problem | Unset `ARTIFACT_STORE` |
| Schema | Code first, then guarded downs |
| Disaster | Restore the Gate A backup |

## 15. Monitoring plan

`deployment-checklist-151.md` §6, plus:
- `worker.job.already_executing`, `worker.lock_lost`, `run.execute.lock_connection_lost`;
- `backup_stale`;
- preflight daily during the observation window.

## 16. Go / no-go

**CONDITIONAL GO.** Engineering is ready. No Critical or unmitigated High finding remains in code, and verification is green (final numbers in the release log). Deployment is conditional on the operator gates:
- G1 merge;
- G3 production backup and restore drill;
- G4 bucket plus `ARTIFACT_STORE=s3`;
- G5 preflight;
- G6 one worker.

The cutover is additionally conditional on G7–G8 (rescore plus sanitized real-data rehearsal).
