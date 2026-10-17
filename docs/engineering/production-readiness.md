# Production readiness, deployment and diligence — spec 151 milestone D2

> **Superseded for release steps by `deployment-checklist-151.md`** (gated rollout with the scoring switch) and `release-151-log.md` (hardening log and blockers). Sections below remain the background.

Nothing in spec 151 is deployed. Every production action below needs the founder's explicit approval. Local tests passing is **not** production verification.

## 1. Release blockers

> Updated by the final release audit (`final-release-audit-151.md`). The authoritative gate table is `deployment-checklist-151.md` §2.

| # | Blocker | Status | Who |
|---|---|---|---|
| B1 | Apply migrations 126–134 to production, in order (worker boot) | Not done; local apply/rollback/reapply loop passes | Founder approval + operator |
| B2 | Rescore history (`scripts/rescore.ts`, then `--apply`). Writes only `scores_staging`; readers stay on v1.1 until `scripts/scoring-cutover.ts apply` | Not done | Operator |
| B3 | Shared artifact storage: S3-compatible object store (`ARTIFACT_STORE=s3`) | **Built**; verified against a real S3-compatible server; no production bucket (checklist §2a) | Founder (vendor approval), operator |
| B4 | Inference host for the Ollama-routed tasks (fail closed without it) | Not done | Founder decision (paid) |
| B5 | Production backups: `backup.yml` / `restore-drill.yml` secrets, a first backup, a timed restore drill, then `BACKUPS_ENABLED=true` | Workflows ready and inert; local drills pass | Operator |
| B6 | Error tracking: set `ERROR_WEBHOOK_URL` on web and worker (forwarded lines are redacted) | Code ready | Operator |
| B7 | Full Playwright suite against the production build | **Done locally** (see release log, final verification) | — |
| B8 | Session-mode pooler sized ≥ 25 clients (advisory locks need session mode) | Not checked in production | Operator |

## 2. Deployment procedure (Railway, existing topology)

1. **Freeze.** No sends or runs in flight: check `/operations` and the queue.
2. **Backup.** `BACKUP_DATABASE_URL=<direct> BACKUP_ENCRYPTION_KEY=… BACKUP_UPLOAD_CMD=… npm run backup`.
3. **Merge.** Merge `feat/151-platform-v2` after review. The worker image runs migrations on boot (`Dockerfile.worker`). Deploy the worker first so the schema exists before the web uses it, with `BUILD_COMMIT` set.
4. **Verify.**
   - `scripts/migrate.ts status` shows 126–131 applied.
   - The worker heartbeat reports the new `start_baseline_wave` handler.
5. **Rescore before web traffic.** Run the dry run, then `--apply` (B2). It makes no provider calls, publishes no events, and is idempotent. The new web build reads v1.2 only: dashboards, competitor views, report snapshots and prospect benchmark reads would be empty for historical runs until this completes.
6. **Deploy web.**
7. **Smoke.**
   - A run page shows "Per-model estimates".
   - `/operations` loads.
   - `scripts/marketing-claims-verify.ts --check` still passes (public numbers are independent of `scores`).
8. **Rollback.**
   - Code: redeploy the previous image. The new tables are additive and old code ignores them.
   - Schema: `npm run db:rollback` once per migration, newest first (131 → 126). The down sections drop only what they added.
   - Rolling back 126 drops `score_estimates`, `competitor_cohorts` and `measurement_instruments` rows. They can be recomputed from raw rows, except cohorts and pins, which are recreated by re-freezing.

## 3. Operating without the founder

| Need | Where |
|---|---|
| What needs attention today | `/operations` (exception queue) |
| Deploy and environment | `docs/deployment.md`, §2 above |
| Backup / restore | `scripts/backup.sh`, `scripts/restore.sh` (both now honour `BACKUP_DATABASE_URL` / `ARTIFACT_ROOT`) |
| Measurement method | `docs/06-scoring-methodology.md`, `docs/engineering/measurement-v2.md` |
| Client delivery | `docs/engineering/client-operations.md`, `docs/operations/*` |
| Costs | `/operations`, `docs/engineering/unit-economics.md` |
| Tests | `npm run typecheck && npm run lint && npm test` (requires `TEST_DATABASE_URL`); `npm run test:e2e` |

Still founder-bound, not solved by code:
- Railway and Supabase account ownership;
- the Gmail sender identity;
- outreach scripts run from the laptop with a direct database URL;
- launchd schedulers;
- the Ollama host.

## 4. Security changes in spec 151

- **New client-reachable surface: `/portal/organizations/[orgId]`.** Deny by default, existence not leaked, read-only, market-benchmark data only. Covered by `tests/integration/organizations.test.ts`.
- **New staff-only surfaces:** `/optimization`, `/operations`, `/evaluation`, `/organizations`. All gated by `requireStaffPage`; every write calls `assertCanWrite`.
- **Exception queue:** cross-client and staff-only (`assertCanWrite`).
- **Ollama health probe:** a read-only GET to the configured `OLLAMA_URL` with a 2.5 s timeout. The URL is operator-configured, not user input.
- **Error forwarding:** emails and phone numbers are redacted before posting (`redactForwarded`, tested); deduped 5 min per event; fire-and-forget.
- **CMS publication binding (final audit):** `cms.publish_approved_asset` requires an approved, same-project client approval whose workflow run created that exact CMS draft from the same asset.
- **Object store:** write-once via conditional PUT; downloads without RF integrity metadata are refused; the preflight probes credential scope.
- **`.dockerignore`:** keeps `.env`, `var/`, `.local-data/`, and editor and agent config out of local image builds.
- **Unchanged:** every send gate, approval tier, evidence release check and immutability trigger.
- **Not addressed:** RLS (still 3 tables; isolation stays app-layer), CSP/HSTS, rate limits on public beacons, and one-click List-Unsubscribe.

## 5. Sensitive data in tracked files

Done in this branch (reversible, no history rewrite):
- **Moved to `.local-data/` (gitignored):** six campaign contact and draft JSON files from `scripts/` and the raw answer dump in `data/internal/`. The scripts that read them now point there.
- **Removed:** `tmp-run-followups.mts`, which hardcoded a production project id.
- **New `.gitignore` rules** prevent re-adding them.

Still present (founder decision):
- prospect names in `lib/pricing/policy.ts`, `DECISIONS.md`, `docs/sales/` and `docs/operations/`;
- production ids in docs;
- **the full git history**, which still contains every removed file. Removing them from history requires an explicitly authorized rewrite. Until then, treat the repository as containing personal data.

## 6. Legal diligence checklist (questions for counsel — no conclusions here)

| Area | What to obtain | Status |
|---|---|---|
| IP assignment | Founder → company assignment covering all code, docs, data and domains. Confirm the terms of the AI coding tools used (nearly every commit is AI co-authored) | Not in repo |
| Repository ownership | Move from a personal GitHub account to a company organization; add a proprietary notice | Not done |
| RealTrends | Written terms: internal use, use in client and prospect reports, derived anonymized statistics, retention, and transfer on change of control | Unknown (`docs/human-verification-gates.md`) |
| AI provider outputs | Per provider (OpenAI, Perplexity; Google and Anthropic if enabled): storage, aggregation, publication of aggregates, use for benchmarking competitors, transfer to an acquirer | Not reviewed |
| Customer data rights | Engagement agreement clauses: measurement data ownership, anonymized aggregation across clients (needed for cross-client learning), retention, deletion on request, change of control | Agreement template is stamped `NOT_REVIEWED` |
| Prospect data and outreach | Lawful basis for storing contact details; CAN-SPAM (one-click unsubscribe is missing); Gmail API `gmail.send` scope verification | Partial |
| Third-party licenses | Direct dependencies: 28 MIT, 5 Apache-2.0, 2 ISC, 1 BSD-2, 1 Unlicense. Transitive: sharp/libvips LGPL-3.0. Image: Alpine ffmpeg and chromium. Confirm distribution obligations | Inventory in strategy doc 01 |
| Change of control | Vendor contracts (Railway, Supabase, ElevenLabs, Google Workspace, RealTrends) and any client contracts | No client contracts yet |
