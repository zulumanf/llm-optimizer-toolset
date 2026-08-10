# Deployment

The single largest gap in the 2026-08-09 architecture audit was this document
not existing. Everything here is host-agnostic; the host itself is the one
open operator decision (`docs/production-readiness-plan.md` decision #1).

## Topology

Three processes, one database:

| Process | Artifact | Notes |
|---|---|---|
| Web | `Dockerfile` (Next standalone, port 3000) | Health check: `GET /api/health` (unauthenticated minimal shape, 200/503) |
| Worker | `Dockerfile.worker` | Runs migrations on boot, then the job loop. **Without it, every run/parse/score/workflow queues forever.** |
| Postgres 14 | Managed, or the compose `db` service | The worker and web share one `DATABASE_URL` |
| Scheduler | Any cron hitting the cron endpoints | Until the host has one: `.github/workflows/heartbeat.yml` (needs `APP_URL` + `CRON_SECRET` repo secrets) |

Self-host / VPS: `POSTGRES_PASSWORD=… docker compose up -d` runs all three.
Managed hosts (Railway / Fly / Render): create two services from the two
Dockerfiles plus a managed Postgres; set the env below on both services.

## Environment

`.env.example` documents every variable; `lib/env.ts` validates at boot.
Production minimums:

- `DATABASE_URL` — the managed Postgres.
- `AUTH_MODE=supabase` + the three `SUPABASE_*` values. A production process
  refuses to serve dev auth (`lib/env.ts` fail-closed rule).
- `APP_URL` — the public origin; audit links and outreach drafts refuse or
  degrade without it.
- `CRON_SECRET` — the scheduler's bearer; cron endpoints refuse without it.
- `OPENAI_API_KEY` (+ other provider keys as verified).
- `AUTOMATION_CREDENTIAL_KEY` — connector credential envelope.
- `BACKUP_ENCRYPTION_KEY` + `BACKUP_UPLOAD_CMD` — see Backups.
- `DIGEST_WEBHOOK_URL` — digests and **system alerts** land here.
- Never in production: `ALLOW_MOCK_PROVIDER`, `ALLOW_MOCK_SCORING`,
  `ALLOW_DEV_AUTH_IN_PROD`.

## Scheduling

Point any cron at (bearer `CRON_SECRET`, POST):

- `/api/cron/automation` — every 5–15 min: trigger dispatch, event delivery,
  drift detection, system alerts, knowledge maintenance, outcome sweep.
  All work is windowed/deduped; late or doubled ticks are safe.
- `/api/cron/weekly-cycle` — hourly is fine: starts each project's weekly
  cycle once per ISO week.

The GitHub-Actions heartbeat covers both every 10 minutes as a stopgap.
`scripts/install-schedulers.sh` (launchd) is the laptop-era mechanism —
retire it at first deploy.

## Backups

`npm run backup` dumps Postgres + evidence artifacts, manifests hashes,
then (with `BACKUP_ENCRYPTION_KEY`) encrypts to one artifact and (with
`BACKUP_UPLOAD_CMD`) ships it off-box. Schedule it daily beside the app
(worker host cron or a CI schedule with DB access). Production rule: **no
key, no backup schedule — the dump contains prospect PII.**

Restore drill (run one before the first client, then quarterly):
`BACKUP_ENCRYPTION_KEY=… npm run restore -- <artifact>.tar.gz.enc` —
decrypts, verifies the manifest, restores into `llm_optimizer_restore`
(never the live DB), prints row counts. Promotion is a deliberate manual
step.

## Observability

- `GET /api/health` with the `CRON_SECRET` bearer → full report: worker
  liveness (heartbeat staleness), queue depth/age/overdue, open drift
  signals, 24h spend vs ceiling.
- System alerts post to `DIGEST_WEBHOOK_URL`, deduped per kind per hour:
  worker stale, queue backlog, open drift signal, spend ≥90% of ceiling,
  DB unreachable.
- Structured JSON logs on stdout — point the host's log drain somewhere
  durable.

## First-deploy checklist

Run `docs/deploy-smoke.md` end to end before pointing anything real at it.
