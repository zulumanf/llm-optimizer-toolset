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

## Internal open-weight inference (Ollama)

Some internal tasks run on self-hosted open-weight models, through `lib/ai/internal/ollama.ts`. The mapping from task to model lives in `INTERNAL_TASK_TARGETS` in `lib/ai/routing.ts`. These tasks never fall back to a paid provider: when Ollama is down, the task fails closed.

- **The worker needs `OLLAMA_URL`** pointing at the inference host. It defaults to `http://127.0.0.1:11434`. The web process does not call Ollama.
- **Production host:** Francisco's Mac behind an authenticating proxy and Tailscale Funnel, `https://rf-ollama.tail390f0b.ts.net`. Setup, key handling, rotation, kill switch and failure modes: `ops/inference-host/README.md`.
- **A remote host must be https with `OLLAMA_API_KEY`** (sent as a bearer token; spec 158). A plain-http or keyless remote `OLLAMA_URL` is refused before any request. Every request is aborted after `OLLAMA_REQUEST_TIMEOUT_MS` (280 s) and fails closed.
- **No host = four features off, not wrong.** Without a reachable host, `summarize_meeting`, `summarize_support_request`, `knowledge_claim_extraction` (source uploads, discovery) and `detect_contradictions` fail closed. Provisioning the host is an operator decision to make before deploying the 142–147 lineage. Contractual measurement never uses Ollama (`tests/unit/measurement-provider-boundary.test.ts`).
- **The models must be pulled** on the inference host: `qwen3:8b`, `qwen3:30b` and `gpt-oss:20b` (`LOCAL_INTERNAL_TARGETS` in `lib/ai/internal/registry.ts`).
- **Keep `qwen3:30b` resident.** `detect_contradictions` (spec 146) passed its promotion gate of warm p95 ≤ 60 s, measured at 41.8 s. That figure assumes the model is already loaded, because a cold load added about 7 s of model loading on the evaluation host. Ollama unloads idle models after 5 minutes by default, and profile-correction runs are infrequent. So on the **Ollama server** (not in the app's env), set `OLLAMA_KEEP_ALIVE` to keep the model loaded, for example `-1` for indefinitely, or a duration longer than the gap between runs.
  - Give the host enough memory for the resident models together. `qwen3:30b` Q4_K_M used about 22 GB.
  - Check residency with `ollama ps`.
  - The `compare` node's 300 s timeout still covers a cold load after a restart, but cold calls don't meet the latency figure the route was promoted on.

## Migrations before code (spec 158)

The worker image applies migrations when it boots (`Dockerfile.worker`). A
**web-only** deploy does not. So when a release includes migrations, apply
them before any process runs code that expects them:

1. `npx tsx scripts/migrate.ts status --db "$PRODUCTION_DATABASE_URL"`. Note the pending list.
2. `npx tsx scripts/migrate.ts up --db "$PRODUCTION_DATABASE_URL"`. Run it from an operator machine; do not start the worker for this.
3. Only then deploy web (and the worker, if the release intends it to run).

Releases that need this: the 142–147 lineage (migrations 119–125). Migration 119 adds
`llm_calls.backend` and `duration_ms`. Code ahead of it fails every AI-usage
ledger write, including OpenAI measurement spend, and the daily spend cap then
undercounts. The ledger logs `llm_ledger.write_failed` at error level. If that
event appears after a deploy, a migration was skipped.

Starting the worker is a separate decision, not a deploy step. On boot it runs a
full scheduler tick that can transmit overdue approved outreach (see the
measurement/outreach isolation spec before starting it).

## Before the next production deploy (main at 22c4a5b or later)

`main` now contains the 156 authorization fix, the 148/150 outreach hardening and the 142–147 lineage with spec 158. None of it is deployed. Decide and do these in order:

1. **Migrations 119–125 first.** Apply them with `scripts/migrate.ts up` against production before any code ships (see "Migrations before code" above).
2. **Ollama: decided (2026-10-23): Francisco's Mac via Tailscale Funnel** (`ops/inference-host/README.md`). On the Railway **worker** service, set `OLLAMA_URL=https://rf-ollama.tail390f0b.ts.net` and `OLLAMA_API_KEY` (from the Mac's Keychain; see the README). While the Mac is asleep or offline, meeting summaries, support triage, claim extraction and contradiction detection fail closed. Contractual measurement is unaffected. Nothing calls it until the worker runs again.
3. **Leave `PROFILE_CORRECTIONS_ENABLED` unset.** Unset means profile checks and correction drafting stay off.
4. **Deploy the web service only. The worker stays stopped.** On boot it runs a full tick that can send overdue approved outreach. Starting it waits for the measurement/outreach isolation spec.
5. **After deploying, run the authorization smoke test in spec 156.** Until that passes, the fix is in code but not proven in production. Historical exposure stays **unknown** until the production account and log review is done.

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
