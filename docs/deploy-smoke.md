# Deploy Smoke Checklist

The checklist `docs/production-readiness-plan.md` §40 specified. Run it on
every fresh deploy and after any infra change. Every step must pass before
a client or prospect URL leaves the building.

1. **Boot refusals work.** With `AUTH_MODE` unset, the web process refuses
   to serve (fail-closed dev-auth rule). Restore `AUTH_MODE=supabase`.
2. **Login round-trip.** An operator can sign in via Supabase and reach
   `/control-tower`. A `client_viewer` reaches only `/portal`.
3. **Health.** `GET /api/health` → 200 with `worker: true` (the worker
   container is up and beating). With the bearer: queue empty or draining.
4. **Cron auth.** `POST /api/cron/automation` without the bearer → 401/503;
   with it → 200 and a JSON body naming dispatch/drift/alerts counts.
5. **A run executes.** Start a small benchmark against a real provider from
   the UI; the worker picks it up; responses/mentions/scores appear; the
   run page shows per-cell costs.
6. **Evidence holds.** The run's evidence page re-derives the numbers
   (`matchesStored` true) and the export verifies.
7. **Audit token surface.** Publish a test prospect audit; the `/audit/…`
   URL resolves logged-out, 404s when revoked, and `APP_URL` produced the
   link (not localhost).
8. **Portal isolation.** The client account sees its project only; a second
   project's report URL 404s for it.
9. **Alerting fires.** Stop the worker for 3 minutes → a `worker_stale`
   alert posts to the webhook; start it → health returns 200.
10. **Backup round-trip.** `npm run backup` produces an encrypted artifact
    off-box; `npm run restore` on it verifies and restores into the drill DB.
