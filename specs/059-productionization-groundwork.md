# Spec 059 — Productionization Groundwork (host-agnostic)

**Status:** Implemented — all acceptance criteria verified 2026-08-10 (docker builds prove in CI; encrypted backup/restore round-trip drilled locally)
**Branch:** `feat/059-productionization`
**Source:** Architecture gap audit 2026-08-09 (the #1 gap) + `docs/production-readiness-plan.md` Phase 1 — the only phase that never started. The control plane's clock is a laptop lid; backups are unencrypted on the same disk; a dead worker is invisible; `docs/10-security.md` claims three controls that don't exist; and there is no deployment artifact of any kind.

## Why

The hosting *platform* is an open operator decision — but almost none of Phase 1 actually depends on it. A Dockerfile runs on Railway, Fly, Render, or a VPS unchanged; a health endpoint, a worker heartbeat, alerting, encrypted off-box backups, a complete env contract, and truthful documentation are host-agnostic. Shipping them now turns the eventual host choice into an hour of wiring instead of a project.

## Scope

### A. Liveness: heartbeat, health, alerts (migration 068)
- `worker_heartbeats` (mutable ops table — this is operational state, not measurement): worker id, last_seen_at, jobs_processed. The worker loop beats every poll cycle.
- `GET /api/health`: unauthenticated → minimal `{ok, db, worker}` with 200/503 (what a platform health check needs, leaking nothing); with the `CRON_SECRET` bearer → the full report (worker staleness, queue depth and oldest-queued age, overdue scheduled jobs, open drift signals, 24h spend vs ceiling).
- `lib/ops/health.ts` + `lib/ops/alerts.ts`: deterministic thresholds (worker stale > `WORKER_STALE_SECONDS`, queued jobs older than `QUEUE_ALERT_MINUTES`, any open drift signal, spend ≥ 90% of ceiling). The cron heartbeat posts firing alerts to `DIGEST_WEBHOOK_URL`, deduped through `ops_alerts` (one post per alert kind per `ALERT_RESEND_MINUTES`) — the audit's "log('error','worker.crashed') goes to a terminal nobody is watching" closed.

### B. Deploy artifacts
- Multi-stage `Dockerfile` (standalone Next build) + `Dockerfile.worker`, `docker-compose.yml` (web + worker + Postgres 14) for any-host or self-host runs.
- `.github/workflows/heartbeat.yml`: a scheduled GitHub-Actions heartbeat hitting `/api/cron/automation` and `/api/cron/weekly-cycle` with the secret — an off-laptop scheduler that works the moment `APP_URL`/`CRON_SECRET` repo secrets exist, regardless of host. Exits quietly when secrets are unset. (GH cron is ~5-min-granular and best-effort — fine for a heartbeat whose work is windowed and deduped; the runbook says to move to the host's scheduler when one exists.)
- `next.config.ts` gains `output: "standalone"` for the container build.

### C. Backups: encrypted, off-box-ready
- `scripts/backup.sh`: when `BACKUP_ENCRYPTION_KEY` is set, the dump+evidence tarball is AES-256 encrypted (openssl, pbkdf2) — unencrypted backups of a DB containing prospect PII were an audit P1. When `BACKUP_UPLOAD_CMD` is set (e.g. an rclone/aws-cli line), the artifact is shipped off-box and the success is verified. `scripts/restore.sh` decrypts symmetrically. Same-disk unencrypted remains the zero-config default *for dev only* and the script says so loudly.

### D. Contract truth
- `lib/env.ts` schema + `.env.example` gain every ad-hoc variable the audit found (`ALLOW_MOCK_SCORING`, `DAILY_SPEND_CEILING_USD`, `COMMISSION_RATE_ESTIMATE`, `SENDER_COMPANY`, `SENDER_CREDENTIAL`, `DIGEST_WEBHOOK_URL`, `MCP_USER_ID`, `GOOGLE_API_KEY`, `PERPLEXITY_API_KEY`, `AUTOMATION_CREDENTIAL_KEY`, backup/alert knobs) — all optional, but declared: "the app refuses to boot with missing config" stops being fiction for the variables that matter.
- CI gains a **visible, non-blocking** `npm audit --audit-level=high` report (blocking would freeze the repo on today's unfixable transitive advisories — sharp/libvips via Next) and `.github/dependabot.yml` for automated update PRs. `docs/10-security.md` is rewritten to claim exactly what exists: app-layer tenant isolation with limited RLS defense-in-depth, no inbound rate limiting yet, audit-report + Dependabot (not a blocking gate).
- `docs/deployment.md` (topology, env matrix, host wiring, cron, backups, restore drill), `docs/deploy-smoke.md` (the checklist the readiness plan specified), and a README that stops lying about the database, the e2e suite, and the env list.

## Out of scope
- The actual first deploy (blocked on the host decision) and host-specific config.
- ESP/sending domain (spec 052's identity table awaits the operator's values).
- Inbound rate limiting (needs the deployment target's edge story; documented as absent).

## Acceptance criteria
- [x] Worker loop beats; `/api/health` returns minimal shape unauthenticated and the full report with the bearer; a stale heartbeat flips `worker` false and the endpoint 503s (tests).
- [x] Alerts fire deterministically at the thresholds, post once per window per kind, and re-arm after the window (tests).
- [x] `docker build` succeeds for web and worker images (CI job builds them).
- [x] Backup script encrypts when keyed and refuses a keyed restore of an unencrypted artifact (and vice versa); manifest verification still holds (script-level test).
- [x] Env schema parses a fully-populated and a minimal `.env`; `.env.example` documents every schema variable (test).
- [x] `npm test`, lint, typecheck green; migration 068 reversible.
