---
name: run-app
description: Launch and drive this app locally — the verified recipe with every trap found the hard way (shared .next, zombie runs, env overrides, worker requirement). Use when asked to run, restart, demo, or debug the app.
---

# Running the AI Visibility OS locally

## The one command (preferred)

```bash
npm run app        # scripts/dev-all.sh: starts Postgres if down, migrates,
                   # starts worker + dev server; Ctrl+C stops everything
```

## Manual launch (what agent sessions actually use — two background processes)

**⚠️ `.env` may point DATABASE_URL at the REMOTE Supabase DB.** For local work
always override, or you will read/migrate production:

```bash
DATABASE_URL="postgres://localhost:5433/llm_optimizer_dev" AUTH_MODE=dev ALLOW_MOCK_PROVIDER=1 npm run dev
DATABASE_URL="postgres://localhost:5433/llm_optimizer_dev" AUTH_MODE=dev ALLOW_MOCK_PROVIDER=1 npm run worker
```

- **Both processes are required.** `npm run dev` alone serves pages but runs
  never execute — execute/parse/score jobs need the worker.
- `AUTH_MODE=dev`: no Supabase login; you are the admin dev user.
- `ALLOW_MOCK_PROVIDER=1`: enables the mock AI provider + mock prospect
  source (fixture data, clearly fictional). Real runs need `OPENAI_API_KEY`
  (in `.env`) and don't need this flag.
- Postgres: postgresql@14 on **:5433** via brew services. After a reboot it
  may not auto-start: `brew services start postgresql@14`.

## Traps (each one cost real debugging time)

1. **NEVER run `npm run build` while the dev server is up.** They share
   `.next/`; the build clobbers the dev server's chunks mid-flight →
   "Cannot read properties of undefined (reading 'call')" / missing
   vendor-chunk errors. Fix for any corrupted-chunk error: stop server,
   `rm -rf .next`, restart. All state is in Postgres; nothing is lost.
2. **Zombie runs starve the queue.** The worker is single-loop; a stuck
   `pending/running` run (e.g. configured for a provider with no API key)
   blocks everything behind it while cells fail-retry for minutes. Check
   `select id,label,status from runs where status in ('pending','running')`
   and cancel strays via `cancelRun(user, { runId })` before starting runs.
3. **Smoke checks after start**:
   `curl -s -o /dev/null -w "%{http_code}" localhost:3000/` → 200;
   `/prospects` → 200. A run completed = `runs.status='completed'` AND
   `scores` rows exist for the run.
4. **Verifying a run processed**: watch the worker's stdout for
   `run.execute.done` / `scoring.computed`, or poll the scores count —
   don't poll only `runs.status` (scoring lands after completion).
5. Driving service flows from scripts: `npx tsx --tsconfig tsconfig.json
   <script>` with the env overrides above; resolve the dev user from
   `users` via `DEV_USER_ID` (lib/auth).
6. Migration testing is local-only:
   `npx tsx scripts/migrate.ts up|down --db "postgres://localhost:5433/llm_optimizer_dev"`.
   Never point migrate at the remote unless deploying is the explicit intent.
