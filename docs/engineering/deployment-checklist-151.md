# Deployment checklist — release 151

Nothing here has been executed against staging or production. Every command is for the operator, after the founder's go. The release log (`release-151-log.md`) holds the evidence for each claim below.

## 1. What makes this release safe to stage

| Mechanism | Effect |
|---|---|
| Migrations 126–134 | Additive; nullable columns only on existing tables; no backfill. The worker image applies them on boot under an advisory lock |
| `scoring_state` = v1.1 at deploy; v1.2 compatibility rows go to `scores_staging` until the cutover | Dashboards are unchanged after deploy, **and the previous (pre-151) image can be redeployed** until Gate 5 |
| Cutover | Verification, then one transaction (copy staging → scores, flip) under an exclusive lock no scoring write can straddle. Rollback = flip back |
| Spec-151 down sections | Refuse to drop rows unless run with `--allow-destructive-down` |
| Job execution | Exclusive per job (advisory lock) and per run; scheduler tick single-runner |
| CMS writes | Gated on an approved, verified `lib/content` asset at the connector boundary |
| Backups | Recorded in `backup_runs`; stale/failed backups raise a high-severity exception |

## 2. Release gates

Classification:
- **B** = blocking deployment.
- **F** = blocking activation of a particular feature.
- **D** = safe to defer with the documented mitigation.

| # | Gate | Class | Current status | Evidence | Owner | Required action | Rollback strategy |
|---|---|---|---|---|---|---|---|
| G1 | Code review and merge of `feat/151-platform-v2` (uncommitted; AGENTS.md forbids agent commits) | B | Ready for review | Local: tsc, lint, vitest, Playwright, build, migration loop (release log, final verification) | Founder | Review the diff; commit in logical slices; open the PR; confirm CI green; merge | Revert the merge commit before deploy |
| G2 | Migration numbering at merge | B | 126–134 free on all local branches | Release log §0 | Founder | `ls db/migrations` on `main` after merge; renumber if a concurrent branch took 126+ | n/a |
| G3 | Encrypted, off-box backup before deploy + restore drill | B | Scripts and workflows ready; never run against production | Local drills (backup → restore ≈ 1 s; ledger rows for success and failure) | Operator | Set backup secrets; run `backup.yml` manually; run `restore-drill.yml` manually; record the duration | Backup is the rollback of last resort (restore into a new database, re-point `DATABASE_URL`) |
| G4 | Shared artifact storage (`ARTIFACT_STORE=s3`) | B | Implemented; verified against a real S3-compatible server (SeaweedFS, 8/8) including the conditional-write race; no production bucket exists | `object-store.test.ts`, `object-store-s3.test.ts`; preflight probes the credential (a missing key must return 404) and BLOCKs otherwise | Founder (vendor/bucket approval), then Operator | Create a private bucket and scoped key (§2a); set `ARTIFACT_STORE=s3`, `S3_*` on **both** services; run `artifacts-sync --apply` then `--audit` | Unset `ARTIFACT_STORE` (local mode). Objects stay in the bucket; nothing is deleted |
| G5 | Preflight post-migrate | B | Script ready | `scripts/preflight-151.ts`; local output in release log | Operator | Must show no BLOCK after the worker deploy | Redeploy the previous worker image (schema stays; additive) |
| G6 | Single worker at launch | B (configuration) | Exclusivity is structural (dedicated lock sessions, `pg_locks` liveness; crash and disconnect tested); unexercised under production load | `job-fencing.test.ts` (10 cases, 12 consecutive clean runs) | Operator | Replicas = 1 for the first week | n/a |
| G7 | Rescore history into staging | F (cutover) | Script ready; idempotent; resumable | `scoring-cutover.test.ts` (interrupted/resumed) | Operator | `rescore.ts` dry run → `--apply`; clear skipped runs (pending reviews) and re-run | Nothing to roll back: writes only `scores_staging` / `score_estimates` |
| G8 | Rehearsal on a sanitized production copy | F (cutover) | Tooling ready; real data never seen | Sanitizer + rehearsal passed on a seeded copy | Founder | Restore a backup locally, `sanitize-copy --confirm`, `rehearsal-151.ts`; review parity differences | Drop the local copy |
| G9 | Scoring cutover (readers → v1.2) | F (v1.2 dashboards) | Verified locally, including the lock race | `scoring-cutover.test.ts` | Founder decision, Operator executes | `scoring-cutover verify` → `apply --reason …` | `scoring-cutover rollback --reason …`. **After this gate only post-151 images may be deployed** (preflight reports it) |
| G10 | Retire legacy v1.1 writer | D | Not due | Cutover guards tested | Operator | After 14 clean days: `retire-legacy --confirm` | Not reversible without re-enabling and rescoring; defer if in doubt |
| G11 | Inference host for Ollama-routed tasks | F (automatic claim extraction; profile corrections) | No host; tasks fail closed | `ollama-hosting.test.ts`; preflight WARN | Founder (GPU host is paid) | Host Ollama behind an authenticating https proxy; set `OLLAMA_URL`, `OLLAMA_API_KEY` on the worker; pull models; `OLLAMA_KEEP_ALIVE` | Unset `OLLAMA_URL`: tasks fail closed again; claims are entered manually |
| G12 | Error alerting (`ERROR_WEBHOOK_URL`) | D | Code ready | `logger-forward.test.ts` | Operator | Set on web and worker | Unset |
| G13 | Nightly backups enabled | B for first paying client; D for this deploy if G3 was done the same day | Workflows inert | `backup.yml`, `restore-drill.yml`; `backup_stale` exception tested | Operator | Set `BACKUPS_ENABLED=true` and secrets; confirm one scheduled success in `backup_runs` | Set `BACKUPS_ENABLED=false` |
| G14 | Automation content v2 publishing | F (automated CMS publishing) | Consolidated: can only publish an approved `lib/content` asset; no CMS connected | `automation-demos` and `publish-gate` tests | Engineering, when a client wants CMS publishing | Connect a CMS for that client; start v2 with `payload.contentAssetId` | Revoke the CMS connection |
| G15 | Personal data in git history | D (diligence) | Removed from HEAD; history unchanged | Release log §(earlier) | Founder | Decide on an authorized history rewrite (`git filter-repo`) before sharing the repo | n/a |
| G16 | Legal items (IP assignment, RealTrends, provider terms, agreement review) | D for deploy; B for first signed client agreement | Not started | `production-readiness.md` §6 | Counsel | — | n/a |

## 2a. Artifact bucket setup (G4) — Cloudflare R2 recommended

Simplest fit for RF's scale (< 1 GB, two services): R2 with private buckets and no egress fees. Verify current pricing before approving.

1. Cloudflare dashboard → R2 → create buckets `rf-artifacts-prod` and `rf-artifacts-staging` (private; no public access, no custom domain). Separately create `rf-backups-prod` for database backups.
2. R2 → Manage API tokens → create a token **scoped to the one bucket** with permission *Object Read & Write*. Record the access key id, the secret and the account S3 endpoint `https://<account-id>.r2.cloudflarestorage.com`.
3. Set on **both** web and worker: `ARTIFACT_STORE=s3 S3_ENDPOINT=<endpoint> S3_BUCKET=rf-artifacts-prod S3_REGION=auto S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… S3_PREFIX=production`.
4. Verify: `scripts/preflight-151.ts --phase pre-deploy` must print `PASS artifact storage … credential OK (missing → 404)`. A 403 means the token lacks list or read access on the bucket.
5. Encryption at rest is provider-side (on by default). Put no lifecycle or expiry rule on the artifacts bucket: evidence is immutable and retained. On the backups bucket, enable object lock or versioning; retention follows `backup.yml`.

If AWS S3 is chosen instead:
- a private bucket with SSE-S3 default encryption and Block Public Access on;
- an IAM policy granting `s3:GetObject` and `s3:PutObject` on `arn:aws:s3:::<bucket>/*`, and `s3:ListBucket` on `arn:aws:s3:::<bucket>`.

## 2a-bis. Outreach email (spec 157, if that branch is merged)

`APP_URL` must be set on **both** web and worker, e.g. `https://app.recommendedfirst.com`. Without it, every Gmail send refuses with `one_click_unsubscribe`. The public paths `/api/unsubscribe/*` and `/unsubscribe/*` must reach the web service unauthenticated (the middleware already allows them).

## 2b. Database connection budget

Advisory locks require a **session-mode** pooler or direct connections; a transaction-mode pooler silently breaks them.

Per process, the shared pool max is 10. The worker additionally opens up to 2 dedicated lock sessions (job and run, `application_name=rf-lock`), plus 1 while ticking. Before launch, size the session pooler to at least 25 clients, or lower the pool sizes.

## 3. Staging rehearsal (recommended before production)

Staging = a separate Railway environment with its own Postgres, loaded from a **sanitized** copy (never raw production data).

```bash
# --- on the founder's machine (encrypted disk) ---------------------------------
# 0. newest production backup (G3 must be done)
aws s3 cp s3://$BACKUP_BUCKET/postgres/<newest>.tar.gz.enc ./ --endpoint-url $BACKUP_S3_ENDPOINT
BACKUP_ENCRYPTION_KEY=… npm run restore -- ./<newest>.tar.gz.enc rf_rehearsal_$(date +%Y%m%d)
DATABASE_URL=postgres://localhost:5433/rf_rehearsal_$(date +%Y%m%d) npx tsx scripts/sanitize-copy.ts --confirm
DATABASE_URL=postgres://localhost:5433/rf_rehearsal_$(date +%Y%m%d) npx tsx scripts/rehearsal-151.ts --out rehearsal.json   # G8
pg_dump --format=custom --no-owner -d rf_rehearsal_$(date +%Y%m%d) -f staging-seed.dump

# --- staging environment ---------------------------------------------------------
pg_restore --no-owner -d "$STAGING_DATABASE_URL" staging-seed.dump
# staging services: same images, staging DATABASE_URL, ARTIFACT_STORE=s3 with a STAGING bucket/prefix,
# AUTH_MODE=supabase (staging project), no provider keys unless a paid test is approved, no Gmail connection
railway environment staging
railway up --service worker      # applies 126–134 on boot
DATABASE_URL="$STAGING_DATABASE_URL" npx tsx scripts/preflight-151.ts --phase post-migrate
railway up --service web
DATABASE_URL="$STAGING_DATABASE_URL" npx tsx scripts/rescore.ts --apply
DATABASE_URL="$STAGING_DATABASE_URL" npx tsx scripts/scoring-cutover.ts verify
DATABASE_URL="$STAGING_DATABASE_URL" npx tsx scripts/scoring-cutover.ts apply --reason "staging rehearsal"
DATABASE_URL="$STAGING_DATABASE_URL" npx tsx scripts/scoring-cutover.ts rollback --reason "staging rollback drill"

# --- clean up -----------------------------------------------------------------
dropdb rf_rehearsal_$(date +%Y%m%d); rm -f staging-seed.dump rehearsal.json ./<newest>.tar.gz.enc
```

## 4. Production — exact ordered operator commands (do not run without the founder's go)

Assumes `PROD_DIRECT_URL` is the production **direct** (non-pooled) connection, `railway` is linked to the production project, and the shell has no `ALLOW_MOCK_*` or `MEASUREMENT_DEFAULT_INSTRUMENT`.

```bash
# ===== Gate A — before anything changes ========================================
git checkout main && git pull                                   # merged release (G1, G2)
ls db/migrations | tail -10                                     # 126–134 present, unique
DATABASE_URL=$PROD_DIRECT_URL npx tsx scripts/migrate.ts status # expect pending: 126–134
gh workflow run backup.yml && gh run watch                       # G3: fresh encrypted off-box backup
gh workflow run restore-drill.yml && gh run watch                # G3: restore drill; record duration
psql "$PROD_DIRECT_URL" -c "select status, count(*) from runs where status in ('pending','running') group by 1"   # expect none
# take dashboard screenshots of 3 clients + 1 market benchmark (comparison baseline)

# ===== Gate B — configuration (both services) ===================================
railway variables --service worker --set ARTIFACT_STORE=s3 --set S3_ENDPOINT=… --set S3_BUCKET=… \
  --set S3_REGION=auto --set S3_ACCESS_KEY_ID=… --set S3_SECRET_ACCESS_KEY=… --set S3_PREFIX=production \
  --set ERROR_WEBHOOK_URL=… --set BUILD_COMMIT=$(git rev-parse HEAD)
railway variables --service web    --set ARTIFACT_STORE=s3 --set S3_ENDPOINT=… --set S3_BUCKET=… \
  --set S3_REGION=auto --set S3_ACCESS_KEY_ID=… --set S3_SECRET_ACCESS_KEY=… --set S3_PREFIX=production \
  --set ERROR_WEBHOOK_URL=…
# from wherever artifacts exist today (founder machine var/, or the current worker):
ARTIFACT_STORE=s3 S3_…=… npx tsx scripts/artifacts-sync.ts            # dry run
ARTIFACT_STORE=s3 S3_…=… npx tsx scripts/artifacts-sync.ts --apply
ARTIFACT_STORE=s3 S3_…=… DATABASE_URL=$PROD_DIRECT_URL npx tsx scripts/artifacts-sync.ts --audit   # expect missing 0
DATABASE_URL=$PROD_DIRECT_URL npx tsx scripts/preflight-151.ts --phase pre-deploy   # no BLOCK except "migrations" WARN

# ===== Gate C — schema (worker deploy applies migrations) =======================
railway up --service worker                                     # replicas = 1 (G6)
DATABASE_URL=$PROD_DIRECT_URL npx tsx scripts/migrate.ts status # expect pending: none
DATABASE_URL=$PROD_DIRECT_URL npx tsx scripts/preflight-151.ts --phase post-migrate   # no BLOCK (G5)
psql "$PROD_DIRECT_URL" -Atc "select read_version, write_legacy from scoring_state"  # v1.1 | t

# ===== Gate D — application ====================================================
railway up --service web
curl -fsS https://app.recommendedfirst.com/api/health
# compare dashboards with the Gate A screenshots: identical numbers
DATABASE_URL=$PROD_DIRECT_URL npx tsx scripts/marketing-claims-verify.ts --check
# watch 24 h: error webhook, /operations, and dual write:
psql "$PROD_DIRECT_URL" -c "select 'scores' t, scoring_version, count(*) from scores where computed_at > now()-interval '1 day' group by 2 union all select 'staging', scoring_version, count(*) from scores_staging where computed_at > now()-interval '1 day' group by 2"

# ===== Gate E — enable nightly backups (G13) ====================================
gh variable set BACKUPS_ENABLED --body true
# next morning: psql "$PROD_DIRECT_URL" -c "select finished_at, ok, uploaded from backup_runs order by finished_at desc limit 3"

# ===== Gate F — rescore history (G7; invisible to readers) =======================
DATABASE_URL=$PROD_DIRECT_URL npx tsx scripts/rescore.ts            # dry run: note the count
DATABASE_URL=$PROD_DIRECT_URL npx tsx scripts/rescore.ts --apply    # resumable; re-run after clearing skipped runs

# ===== Gate G — cutover (G8 rehearsal done; founder decision) ====================
DATABASE_URL=$PROD_DIRECT_URL npx tsx scripts/preflight-151.ts --phase pre-cutover
DATABASE_URL=$PROD_DIRECT_URL npx tsx scripts/scoring-cutover.ts verify          # review every parity difference
DATABASE_URL=$PROD_DIRECT_URL npx tsx scripts/scoring-cutover.ts apply --reason "verified YYYY-MM-DD, N runs" [--accept-differences]
# verify: project tiles show v1.2, trends have no gaps; daily `scoring-cutover verify` for 14 days

# ===== Gate H — later (D) =======================================================
# after 14 clean days:  scoring-cutover.ts retire-legacy --reason "…" --confirm
# after a week of worker.lock_lost = 0: raise worker replicas to 2
```

## 5. Rollback table

| When | Action | Data impact |
|---|---|---|
| Before Gate G (no v1.2 in `scores`) | Redeploy the previous image (worker and web) | None. `scores` is v1.1-only; new tables are ignored by old code |
| After Gate G | `scoring-cutover.ts rollback --reason …` (readers back to v1.1); redeploy **only post-151** images | None. Legacy writer kept v1.1 current |
| Artifact storage problem | Unset `ARTIFACT_STORE` on both services | Files written while enabled live in the bucket; re-enable to read them |
| Worker misbehaves | Redeploy the previous post-151 worker image; replicas 1 | None |
| Schema must go (last resort) | Code rollback first (to a pre-151 image only if before Gate G) → `scoring-cutover rollback` if past G → `migrate.ts down` × 9 (134 → 126) | Refuses while protected tables hold rows. Export them (`pg_dump -t …`) and re-run with `--allow-destructive-down`. Dropping 126 loses `responses.served_model` / `captured_at` (recomputable) and `mentions.matcher_version` (provenance only) |
| Total failure | Restore the Gate A backup into a new database; re-point `DATABASE_URL` | Writes after the backup are lost; reconcile the outreach ledger manually |

## 6. Monitoring (first 14 days)

| Signal | Where | Threshold |
|---|---|---|
| Error events | `ERROR_WEBHOOK_URL` | New event names investigated the same day |
| Exception queue | `/operations` | No new high item caused by the release; `backup_stale` never present |
| Dual write | Gate D query | v1.1 rows in `scores` and v1.2 rows in `scores_staging` for every new run (both tables after Gate G) |
| Cutover coverage | `scoring-cutover verify` daily after Gate F | 0 missing |
| Worker exclusivity | Logs `worker.job.already_executing`, `worker.lock_lost`, `run.execute.already_running` | 0 expected with one worker. Also `run.execute.lock_connection_lost` and `worker.job.lock_connection_unavailable` |
| Lock sessions | `select count(*) from pg_stat_activity where application_name = 'rf-lock'` | ≤ 3 per worker; never growing |
| Artifacts | `artifacts-sync --audit` weekly | missing 0, mismatch 0 |
| Spend | `/operations` spend item | Unchanged vs. pre-release |
| Publishing gate | `workflow_exceptions` kind `evidence_conflict` | Only from deliberate tests |
