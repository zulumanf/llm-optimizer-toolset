# Release 151 — hardening log

Scope: make `feat/151-platform-v2` safe to deploy. No feature expansion. Nothing deployed, committed, emailed or published; production was not touched.

Entries are appended in order. Each says what was found, what changed, and how it was verified.

## 0. Starting facts (2026-10-16)

- **Worker boot runs migrations** (`Dockerfile.worker` CMD: `scripts/migrate.ts up && workers/index.ts`). Deploying the worker IS applying migrations. The migration runner had no lock (§2).
- **No other local branch uses migration numbers ≥126.** The highest elsewhere is `125` (`feat/147`). Numbering is free unless an unpushed branch elsewhere claims 126+, so check at merge time.
- **No real captured answers exist outside production.**
  - The local dev database is empty (0 responses).
  - `.local-data/internal/…offline.json` holds labels and ids, not answer text.
  - The production-like rehearsal (§5) therefore runs on local data, with a script that refuses any non-local database. A real rehearsal needs an operator-made local snapshot: **blocker R1**.

## 1. Historical-score gap → backward-compatible cutover

**Found:** bumping `SCORING_VERSION` to v1.2 emptied every current-version view until a rescore. Separately, about 15 `scores` readers had no version filter at all, and would double-count once two versions coexist for a run.

**Changed:**
- Migration `132_scoring_cutover`: a single-row `scoring_state` (`read_version` v1.1, `write_legacy` true) plus insert-only history. A check constraint forbids retiring v1.1 while it is still read.
- `READ_SCORING_VERSION` (`db/scores.ts`): one SQL fragment, falling back to v1.1 if the row is missing. It is used by **every** `scores` value reader:
  - `db/{dashboard,competitors,projects}`;
  - `lib/{gaps,portal,campaigns,attribution,competitors/movement,competitors/groups,drift,control-tower/health,knowledge/compiler/context,prospects/{benchmark,audits,detail},outcomes/sweep,reports/{snapshot,executive},evidence/export,engagements/measurement}`;
  - the project and evidence pages.
- **Static guard** `tests/unit/scores-read-version.test.ts` fails any future unpinned read. It found one more (`linkableRuns`).
- **Dual write:** `lib/scoring/legacy-v11.ts` is the pre-151 algorithm moved out unchanged. `computeScores` writes v1.1 plus v1.2 plus estimates.
- **Rescore** writes v1.2 only (`writeLegacy: false`), so history's v1.1 view never changes.
- `lib/scoring/cutover.ts` + `scripts/scoring-cutover.ts`: `verify` (coverage and v1.1/v1.2 parity on unchanged formulas), `apply` (refuses gaps unless accepted), `rollback`, `retire-legacy`.

**Verified:** `tests/integration/scoring-cutover.test.ts`:
- dual write;
- readers stay on v1.1 for old and new runs;
- verify refuses a missing run;
- rescore adds no v1.1 rows;
- apply flips, rollback restores;
- history is insert-only;
- the parity invariant holds;
- retire and rollback are guarded, and the database refuses the unsafe state.

## 2. Migrations

**Found:**
- Rolling back 126–131 silently dropped operator-entered data.
- The migration runner had no lock, while worker boot migrates.

**Changed:**
- `rf_refuse_destructive_down(tables[])` is called by every spec-151 down section; `scripts/migrate.ts down --allow-destructive-down` overrides it transaction-locally.
- 132's down refuses while the switch is past its baseline.
- The runner takes a session advisory lock.
- Columns added to `responses` / `mentions` are nullable with no default (metadata-only in PG ≥ 11), with no backfill.

**Verified:** `tests/integration/migration-guards-151.test.ts`:
- refusal with rows, and the explicit override;
- the 132 refusal;
- concurrent runners serialize;
- full re-apply.

**Found while testing:** the first version of this test left the schema at 130 when it failed, and 14 later files timed out (hook timeouts). The test now restores in `finally`.

## 3. Worker lost-lease execution

**Changed:**
- Handlers receive `ctx.signal`, which aborts when lease renewal fails.
- `executeRun` stops launching cells and does **not** finalize once aborted; the new owner resumes from captured cells.
- `dispatchOnce` never completes or fails a job whose lease it lost.

**Verified:** `job-fencing.test.ts`:
- a stolen lease aborts the handler, and the stale worker leaves the job to its new owner;
- an aborted `executeRun` launches 0 cells and leaves the run unfinalized.

**Remaining:** other long handlers (video render, backfills, discovery) ignore the signal. The release stays at **one worker**.

## 6. Tenant isolation

`tests/integration/tenant-isolation-151.test.ts` uses two client accounts and two brokerages. It covers:
- every spec-151 read, which is not-found across clients;
- every staff aggregate, refused for both client roles;
- 16 mutations refused for client roles, with a database-level check that nothing was written;
- organization grants: own only, revocation is immediate.

## 7. Statistics and estimators

`tests/unit/stats-adversarial.test.ts` adds:
- Wilson symmetry and bounds;
- degenerate panels; empty and unequal clusters;
- a dominant prompt widening the interval;
- **coverage simulation:** the prompt-clustered 95% interval covers the population rate in more than 88% of 200 trials under heavy clustering, while Wilson under-covers;
- **null false-positive rate** below 11% for paired differences;
- **DiD removes a shared shift** that naive before/after reports as an effect;
- MDE monotonicity;
- evaluator adversarial cases: `decrease` direction, served-model swap either way, a post wave before shipping, a disjoint panel.

**Fixed:** Wilson now returns exact 0/1 bounds at k = 0 / k = n (it previously returned 2e-19).

## 8. Publishing routes

**Found:** the automation `content_production_v2` workflow could reach `cms.create_draft` → `cms.publish_approved_asset` (WordPress) with agent-drafted text that never ran `lib/content/validate.ts`. It was bounded only by its two human approvals.

**Changed:** `lib/content/publish-gate.ts` is enforced at the **connector boundary** (`executeCapability`, before provider resolution, fixtures or test mode) for every `cms.*` write. It requires:
- an approved `content_assets` row of the same tenant;
- a latest version that passed the validator and fact verification (`passed` and `gate.ok`);
- sent text identical to its publishable rendering.

v2 therefore cannot publish until it is rebuilt on `lib/content`.

Other public routes, reviewed and unchanged:

| Route | Gates |
|---|---|
| Content `markPublished` | Human records an approved asset |
| Report publish | Evidence gate + human |
| Audit publish | Dead-link, sense-check and evidence gates |
| Outreach | Send gates |
| Profile corrections | Gmail draft only, hash-bound approval |

**Verified:** `tests/unit/publish-gate.test.ts` (7 cases) and `tests/integration/publish-gate.test.ts`:
- the v2-style payload is refused in live and test mode and raises an exception;
- a valid approved asset passes the gate.

## Adaptive intervention engine — offline evaluation

- Migration `133_intervention_predictions`.
- `lib/experiments/prediction-scoring.ts` (pure) and `lib/experiments/predictions.ts`.
- Design: `adaptive-intervention-evaluation.md`.
- Approval of a plan records the no-change benchmark automatically.
- Tests: `prediction-scoring.test.ts`, plus `intervention-plans.test.ts`.

## 4. Playwright

- `CI=1 npx playwright test` against a production build: **77/77 passed** before any change to the specs.
- I then added `/operations`, `/evaluation` and `/organizations` to `smoke-portfolio.spec.ts`. The section loop already covers the new "Optimize" tab. **40/40 passed** on the touched specs.
- No regressions were found.
- Environment note: the global setup's `createdb` swallows errors; a racing first create produced "database does not exist" once. A re-run passed.

## 5. Production-like rehearsal

- `scripts/rehearsal-151.ts`:
  - refuses non-local hosts;
  - strips provider, email and billing credentials;
  - points Ollama at a dead port;
  - runs migrate → rescore → cutover verify/apply/rollback → cohort → gap analysis → plan → approve → retrospective experiment → roster → report draft → economics, and writes a JSON log.
- **Run on the seeded local e2e database (mock answers only):** every step OK.
  - Cutover drill: 3 runs, 0 missing, 0/40 parity differences, applied and rolled back.
  - The plan created 3 opportunities; approval created the task through the gap engine.
  - The retrospective experiment was correctly `not_comparable` (baseline on the ship date).
  - Report v2 section present.
  - The roster was empty: the seed has no market-bound benchmark project.
- **Blocker R1:** no real captured answers exist outside production.
  - Unblock: the founder restores the Gate 0.6 production backup locally (`scripts/restore.sh` into a local database), then runs `scripts/rehearsal-151.ts` against it.
  - The script cannot run against production.

## 9. Backup, restore, artifacts, model hosting

- **Backup/restore drill** on the e2e database including migrations 132–133:
  - encrypted backup → restore in about 1 s;
  - the restored copy has the switch at v1.1, scores and estimates, and the guard function;
  - `scoring-cutover verify` passes on the copy.
- `scripts/preflight-151.ts` (read-only) makes these BLOCK until set:
  - `BACKUP_ENCRYPTION_KEY`;
  - `ARTIFACT_ROOT` on storage shared by web and worker;
  - a worker heartbeat carrying the new handler.

  `ALLOW_MOCK_*` and `MEASUREMENT_DEFAULT_INSTRUMENT` also BLOCK if set. The inference host is reported as WARN (the four Ollama-routed tasks fail closed).

## 10. Deployment checklist

`docs/engineering/deployment-checklist-151.md`: gates 0–5, verification per gate, multi-worker conditions, a rollback table with data impact, and 14-day monitoring.

## Final verification (local)

| Check | Result |
|---|---|
| `tsc --noEmit` | pass |
| `eslint --max-warnings 0 .` | pass |
| `vitest run` | **306 files / 3,333 tests passed** |
| Playwright (production build) | **77/77**, plus 40/40 on the extended specs |
| `next build` | pass |
| Fresh-database migration loop: up all → down 133…126 → up | pass |
| Data-holding rollback refusal and override | pass (`migration-guards-151`) |

## Remaining blockers

| ID | Blocker | Owner | Release impact |
|---|---|---|---|
| R1 | Rehearsal on real answers needs a local restore of a production backup | Founder | Do before Gate 4 (cutover) |
| B3 | `ARTIFACT_ROOT` on storage shared by web and worker; object storage not built | Engineering decision | Preflight BLOCK |
| B4 | Inference host for the four Ollama-routed tasks | Founder | Those tasks fail closed; release otherwise unaffected |
| B5 | Production backup env (`BACKUP_ENCRYPTION_KEY`, `BACKUP_UPLOAD_CMD`, `BACKUP_DATABASE_URL`), schedule, and a production restore drill | Operator | Preflight BLOCK |
| B6 | `ERROR_WEBHOOK_URL` | Operator | WARN |
| W1 | Only `execute_run` honours lease loss; other long handlers do not | Engineering | Stay at one worker |
| C1 | `content_production_v2` must be rebuilt on `lib/content` before it can publish (now refused at the connector boundary) | Engineering | None: publishing is blocked, not unsafe |
| P1 | Personal data remains in git history | Founder (rewrite needs explicit authorization) | Diligence, not runtime |
| L1 | Legal checklist (`production-readiness.md` §6) | Counsel | Not a deploy gate |
| M1 | Merge and migration-number check at merge time | Founder | Gate 0 |

---

# Final release preparation (2026-10-16, second pass)

## F1. Scoring cutover: hardened

**New finding (blocking, fixed):** the first design dual-wrote v1.2 rows straight into `scores`. A **pre-151 application image** has version-unfiltered readers, so redeploying it would double-count every run scored after deploy. The checklist claimed "redeploy previous image: no data impact". That was false.

**Fix:** migration `134` adds `scores_staging` (same key, insert-only).
- Before the cutover, v1.2 compatibility rows go **only** to staging. `scores` holds exactly what pre-151 code writes (v1.1, same algorithm), so a pre-151 image stays compatible.
- `scoring-cutover apply` copies staging → `scores` and flips the switch **in one transaction under an exclusive advisory lock**. Every scoring transaction holds the same lock *shared* and reads the switch inside the transaction. No write can straddle the flip.
- After the flip, new runs write v1.2 to both tables.
- Preflight reports which application images are rollback-compatible: no v1.2 rows in `scores` means a pre-151 image is safe.

**Verified** (`tests/integration/scoring-cutover.test.ts`, 5 scenarios):

| Scenario | Result |
|---|---|
| Pre-cutover v1.1-only `scores` | Holds |
| Staging → scores copy | Works |
| Readers switch, then roll back | Readers switch atomically; rollback restores v1.1 including runs scored after the flip |
| Interrupted rescore resumed twice | Idempotent: no duplicates, coverage complete |
| Partial and error-only runs | Correctly not "missing" |
| Archived entity | Coverage is per run, so it does not block |
| Stale historical v1.1 row | Reported as a parity difference; the cutover refuses without `--accept-differences` |
| Flip vs. in-flight scoring transaction | The flip waits for the in-flight writer |
| Retire/rollback guards | Hold |

**Concurrent readers:** each statement reads the switch atomically. A page issuing several queries could straddle the flip *instant* and show one panel in each version once. Every comparison path pins the version per computation (movement, drift, attribution verdicts), so no computed delta mixes versions. Mitigation: flip in a quiet window. Severity low.

## F2. Durable artifacts

**Options assessed for Railway (separate web and worker services):**

| Option | Shared by web and worker | Multi-instance | Access control | Backups | Cost (RF scale: < 1 GB today) | Verdict |
|---|---|---|---|---|---|---|
| Railway volume | **No.** A volume attaches to one service, so the web service cannot read worker-written files (verify against current Railway docs) | No: a service with a volume runs one instance (verify) | Container filesystem | Volume snapshots via Railway (verify) | Low | **Rejected:** does not solve the cross-service problem |
| S3-compatible object storage (R2, B2, AWS S3, MinIO, any Railway bucket offering) | **Yes** | Yes | Scoped keys; private bucket; no public URLs are generated | Bucket versioning / object lock, plus a second-bucket replica | R2 free tier currently covers 10 GB (verify); AWS S3 about $0.023/GB-month | **Chosen** |

**Implemented without new dependencies:**
- `lib/storage/object-store.ts`: AWS SigV4 over `fetch` + `node:crypto`. A known-answer test reproduces AWS's published S3 GET Object signature. Path-style requests; https required except localhost; write-once (HEAD then PUT, sha256 in metadata); download integrity check.
- `lib/storage/content-addressed.ts`: with `ARTIFACT_STORE=s3` every write is uploaded **before returning** (the store is the source of truth; a conflict is refused before any local write). `ensureLocal()` fetches into the local cache on demand.
- **Readers switched to `ensureLocal`:** evidence integrity, the evidence download route, the video render-reuse check, the founder-intro asset, the TTS narration cache (a second container fetches instead of paying ElevenLabs again).
- **Evidence export tarballs** (written by the tar CLI) are mirrored explicitly.
- `scripts/artifacts-sync.ts`: dry run / `--apply` uploads existing local files; `--audit` checks every recorded artifact exists with its sha.
- **Tests:** `tests/unit/object-store.test.ts` (8) covers worker → web read, redeploy with an empty cache, same-key dedupe across containers, a conflict never overwriting, tamper detection, path escape and the http refusal.
- **Migration requirement:** run `artifacts-sync --apply` from wherever files exist today (`var/` on the founder's machine or the current worker), then `--audit`.
- **Activation requires a bucket and credentials: founder approval** (may be free tier, but it is a new vendor account).

## F3. Lost job locks: all handlers

Instead of auditing 26 handlers individually, **execution exclusivity is now structural**:
- `dispatchOnce` runs a job only while a dedicated connection holds `pg_advisory_lock(151, hashtext(jobId))`.
- A worker that claims a job still being executed elsewhere (a stale lease) cannot take the lock. It hands the job back without burning an attempt (`deferred`).
- A crashed worker's connection drops and releases the lock.
- Completion is settled under the lock.
- The handler's `signal` aborts if the lock connection dies.
- `executeRun` additionally takes a **per-run** lock, so two different jobs for the same run never spend concurrently.
- The **scheduler tick** runs on one worker at a time (`worker.tick_skipped_other_worker_ticking`).

**Verified:**
- `job-fencing.test.ts`: a reclaimed job is never executed twice, B's claim burns no attempt, and the deferred retry finds the job done.
- The per-run lock test.
- The existing worker-dispatch and rehearsal suites.

**Classification after this change:**

| Handler class | Examples | Multi-worker safety |
|---|---|---|
| Spends money | `execute_run`; `external_discovery` (Perplexity); `render_video_walkthrough` (ElevenLabs, cached by content key) | Same job: exclusive (job lock). Same run across jobs: exclusive (run lock). Discovery and video across *different* jobs for the same target: protected by existing idempotency keys (`generation_key`, enqueue dedupe) |
| Sends externally | Scheduled send drain (tick); profile-correction Gmail drafts | Tick is single-runner; sends keep their intent-key + RFC Message-ID reconciliation (spec 137) |
| DB-only, idempotent | parse, score, backfill (per-run+company advisory lock), gaps, knowledge build, events | Exclusive per job; retry-safe by design |

**Remaining reason to stay at one worker for launch:** none structural. Two workers were exercised only in tests, not under production load. Recommendation: launch at 1. Scale to 2 after a week of `worker.lock_lost` = 0.

## F4. Ollama-routed tasks: actual production dependency

| Task | Model | Production caller | Customer impact without a host |
|---|---|---|---|
| `knowledge_claim_extraction` | gpt-oss:20b | `extract_claims` job after client-site onboarding and external discovery; profile corrections | Claims are not proposed automatically; the operator enters claims by hand. Jobs fail after 3 attempts and appear in `/operations` |
| `detect_contradictions` | qwen3:30b | Profile corrections only | Profile-correction checks stop safely |
| `summarize_meeting`, `summarize_support_request` | qwen3:8b | Meeting/support workflows (installed disabled) | None |

**Decision:** no proprietary API fallback. AGENTS.md forbids silently restoring a proprietary model for promoted tasks, and an unevaluated fallback would also bypass the promotion gates.

**Implemented:** hosted-Ollama support done safely.
- A remote `OLLAMA_URL` must be https **and** carry `OLLAMA_API_KEY` (bearer, for an authenticating proxy in front of a GPU host).
- An unauthenticated public host is refused.
- The health probe and preflight use the same headers.
- Tests: `tests/unit/ollama-hosting.test.ts`.

**Classification:** blocking *activation* of automatic claim extraction and profile corrections, not deployment. A paid GPU host needs founder approval.

## F5. Backups

- **`backup.sh`** with `BACKUP_RECORD=1` writes every attempt to `backup_runs` (migration 134). Success records artifact, size, sha256, encrypted and uploaded; failure is recorded by an `ERR` trap with the failing line. Values pass as psql variables.
- **Monitoring:**
  - the exception queue raises `backup_stale` (high) when there has been no successful backup in 26 h, or a failure since; tested;
  - preflight BLOCKs on a stale backup.
- **Scheduling:**
  - `.github/workflows/backup.yml`: nightly; installs a matching `pg_dump`; encrypts; uploads to a separate backup bucket; records.
  - `.github/workflows/restore-drill.yml`: monthly; restores the newest backup into a throwaway Postgres in the runner; checks integrity, migration status, cutover status and row counts; prints the duration (RTO evidence).
  - Both are **inert** until `vars.BACKUPS_ENABLED == 'true'`.
- **Retention** belongs on the backup bucket: versioning or object lock, plus a lifecycle rule (for example 35 daily + 12 monthly). It is documented, not enforced by code.
- **Verified locally:** success row recorded; failure row recorded (`upload exit 3`); restore of the new backup passed earlier.

## F6. Content publishing

The automation `content_production_v2` publication path is **consolidated onto the canonical pipeline**:
- A new deterministic node `dom.canonical_publish_input` sits between client approval and the CMS. It builds the `cms.create_draft` payload solely from the approved, validator- and fact-verified `lib/content` asset (`entry.payload.contentAssetId`), rendered exactly as the publish gate re-checks it.
- The `publish` input carries the asset id, the CMS post id and this run's recorded approval id.
- The workflow's own agent draft is now only an internal research artifact.
- Missing or unverified asset → safe stop.
- The connector-boundary gate (F-prior) still applies to every caller.

**Tests:**
- `automation-demos.test.ts`: the existing v2 scenario with no asset never reaches a CMS node.
- `publish-gate.test.ts`: the node returns the exact approved text, safe-stops without an asset, and safe-stops once a newer unverified version exists.

## F7. Rehearsal on sanitized real data

- `scripts/sanitize-copy.ts` runs only on a **local** database named `rf_rehearsal*` with `--confirm`.
  - It deletes credential, session, chat and webhook tables.
  - It redacts contact emails and phones, names, reply, draft, message and support bodies, sender identity, tokens and IPs, through an explicit map plus a pattern-based catch-all.
  - It verifies no email survives, and stamps the database.
- `rehearsal-151.ts` **refuses** a database with real answers that lacks the stamp.
- **Verified on a copy:** 32 user emails redacted, 0 surviving; the stamp was set; the full rehearsal then passed on the sanitized copy.

**Security precautions for the founder-run rehearsal:**
1. Restore onto an encrypted disk (FileVault) on the founder's machine only.
2. Run `sanitize-copy --confirm` **before** any other use.
3. No `.env` provider or Gmail keys in that shell; the rehearsal strips them anyway.
4. Never upload the copy or its logs.
5. `dropdb` and delete the decrypted backup directory the same day.
6. Record the run (date, backup artifact name, stamp) in this log.

Captured answers and company names remain in the copy. They are business data under the same access rules as production.

## Final verification (second pass, local)

| Check | Result |
|---|---|
| `tsc --noEmit` | pass |
| `eslint --max-warnings 0 .` | pass |
| `vitest run` | **308 files / 3,348 tests passed** |
| Playwright, production build (`CI=1`) | **80/80 passed** |
| `next build` | pass |
| Fresh-database migration loop: up → down 134…126 → up | pass |
| Backup → ledger (success and failure rows) | pass |
| Sanitize → rehearsal on a seeded copy | pass |

**Note:** one earlier full run was interrupted mid-suite (process gone, two tests reporting 10–16 minute durations, consistent with host sleep or kill). The clean re-run above is authoritative.

## Remaining blockers (operator/founder actions)

The full table is in `deployment-checklist-151.md` §2.

**Blocking deployment:**
- G1 merge (founder; agent may not commit)
- G2 migration-number check at merge
- G3 backup and restore drill
- G4 bucket and `ARTIFACT_STORE=s3`
- G5 preflight
- G6 one worker replica

**Blocking feature activation:**
- G7–G9 rescore, sanitized rehearsal, then cutover
- G11 inference host
- G14 CMS publishing

**Deferrable with mitigation:**
- G10 retire legacy writer
- G12 error webhook
- G15 git history
- G16 legal (blocking only for the first signed agreement)

## Final release audit (2026-10-16/17)

Full report: `final-release-audit-151.md`. An independent read-only review found **no Critical** issues. Three High review findings, plus five defects surfaced by new adversarial tests, were fixed locally.

### Final verification (after every fix in this pass, run alone, under `caffeinate -dimsu`)

| Check | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | PASS |
| Lint | `npx eslint --max-warnings 0 .` | PASS |
| Vitest (real Postgres 14) | `caffeinate -dimsu npx vitest run` | **308 files passed, 1 skipped; 3,356 tests passed, 8 skipped** (the skipped file is the real-S3 suite, gated on `S3_TEST_ENDPOINT`), 310 s |
| Real S3-compatible server | SeaweedFS in Docker; `S3_TEST_ENDPOINT=… npx vitest run tests/integration/object-store-s3.test.ts` | 8/8 PASS |
| Production build | `DATABASE_URL=<test db> npm run build` | PASS |
| Playwright on the production build | `CI=1 npx playwright test` | **80/80 PASS** (1.3 min) |
| Migrations, fresh database | up → down ×9 (134…126) → up | PASS |
| New 126 down guard | planted `responses.served_model` → down refuses; `--allow-destructive-down` proceeds; up re-applies | PASS |
| Job fencing | `job-fencing.test.ts`, 12 consecutive full-file runs | 12/12 |
| Backup → restore drill | `backup.sh` (encrypted, ledger) → `restore.sh` into a scratch database | PASS, ~1 s, row counts match, ledger `ok, encrypted` |
| Artifact sync | dry run → `--apply` (1,453 files) → `--apply` (0 new) | PASS, idempotent |
| Sanitizer | planted email and phone in nested JSON, free text, `users`; JSON numbers present | PASS; JSON intact; jobs cancelled; stamped; rehearsal exit 0 |
| Preflight S3 probe | valid credential / wrong secret | PASS / BLOCK (403 with hint) |

### Fixes in this pass

- **Object store:**
  - conditional PUT, with a race test at unit level and against the real server;
  - an actionable 403 message plus a preflight credential probe;
  - integrity metadata required on download.
- **Workers (found by new crash tests):**
  - dedicated lock sessions with `pg_locks` liveness checks (removes an uncatchable driver crash and pool poisoning);
  - `max_lifetime: 0` on lock sessions;
  - bounded `sql.end` at shutdown;
  - `releaseClaim` always returns the attempt;
  - the run-lock session is watched;
  - a reserve failure releases the claim;
  - `withTickLock` extracted and tested.
- **Publishing:** `cms.publish_approved_asset` is bound to the same run's client approval and its own CMS draft and asset.
- **Data:**
  - migration 126 down is guarded;
  - cutover coverage is re-checked under the exclusive lock.
- **Sanitizer:**
  - base tables only;
  - truncate … cascade for credential and session tables; connector connections are revoked;
  - external message and thread ids nulled; queued jobs cancelled; triggers disabled;
  - generic JSON-safe email/phone scrub; skipped columns reported; verification names the leaking columns.
- **Smaller fixes:**
  - error-webhook redaction;
  - server-side roster scope check;
  - evidence download returns 404/503 instead of 500;
  - workflow secrets passed via `env:`;
  - `prepareMeasurement` try-lock;
  - identifier quoting in the sanitizer;
  - stale doc path in `docs/parser_revision_comparison.md`.

### Still open (documented, not blocking)

- Prediction and learning evaluation is uncached (fine at 0 plans; cache before ~100).
- The scoring bootstrap runs on the worker thread (fine at current roster sizes).
- The connection budget needs a session pooler sized ≥ 25 (checklist §2b).
- The revision-3 provenance file lives only in a gitignored folder (it is still tracked on `main`); archive it durably.

**Decision: CONDITIONAL GO.** See the gate table in `deployment-checklist-151.md` §2.
