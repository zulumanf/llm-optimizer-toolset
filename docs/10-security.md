# 10 — Security

Internal tool, small attack surface — but it holds API keys with real spend and the evidence base for business decisions. Threat model: leaked keys, accidental public exposure, data tampering (even well-intentioned), and data loss.

## Authentication
- Supabase Auth, **email allowlist only** — no open signup, no OAuth "sign in with anything". Unknown email → no account.
- Sessions via Supabase SSR helpers; every App Router request resolves the user server-side. No client-side-only auth checks.
- All routes behind auth except `/login` and `/api/cron/*` (see below).

## Authorization
- Roles: `admin` (user management, settings, destructive ops like archiving) and `operator` (everything else). Checked **in server actions** — never only in UI.
- Cron endpoints authenticated by `CRON_SECRET` header (constant-time compare); reject and log anything else.
- Supabase Row Level Security enabled with a default-deny posture; the app uses the service role only in the worker, anon key + RLS in the app.

## Secrets
- Single `.env`, never committed; `.env.example` documents every variable with placeholders.
- Provider keys live only in server-side env (Vercel/worker env config). **No secret ever reaches client bundles** — enforced by using non-`NEXT_PUBLIC_` names.
- No secrets in logs: the AI provider layer redacts auth headers before any error is logged or stored in `responses.error`.
- Key rotation: quarterly or immediately on suspicion; one owner per key documented in the team vault.

## Rate limits & spend protection
- Outbound: per-provider rate limiting in `lib/ai/` (respect vendor limits, exponential backoff).
- **Budget caps:** every run has a max `cost_usd`; the worker halts the run at the cap and marks it `partial`. A global monthly spend ceiling alerts at 80% and hard-stops new runs at 100%.
- Inbound: basic rate limiting on auth endpoints; internal tool → nothing fancier needed yet.

## Audit logs
- `audit_log` (immutable, insert-only) records every consequential action: freezes, run starts, review corrections, task approvals, report publishes, role changes, settings changes — with user, entity, and detail.
- The integrity story depends on this: immutable data + audited actions = trustworthy evidence.

## Encryption
- TLS everywhere (Vercel/Supabase defaults). Postgres encrypted at rest (Supabase default).
- No additional app-layer crypto — we don't store user PII or payment data.

## PII
- The system stores team members' names/emails and AI responses about **companies** — by design, no consumer PII.
- If a raw response happens to contain personal data about an individual, it stays immutable per principles but is excluded from exports; flag it via mention review. Don't build prompts that solicit personal data.

## Backups & recovery

**Implemented (2026-07-29, P0 from the five-products audit).** Raw
responses are irreplaceable — a provider answer from last March can never
be re-captured — so backups cover both the database and the evidence
artifacts.

```bash
npm run backup                       # dump + artifacts + hash manifest
BACKUP_DIR=~/Library/Mobile\ Documents/com~apple~CloudDocs/parva-backups \
  npm run backup                     # off-box via iCloud (recommended)
npm run restore -- var/backups/<stamp>   # drill into llm_optimizer_restore
```

- `scripts/backup.sh` — `pg_dump` (custom format) + `tar` of `var/evidence`
  + `MANIFEST.sha256` over both, so a restore is verifiable the same way
  client evidence packages are. Prunes to the newest `BACKUP_KEEP` (default
  14) because this machine has hit ENOSPC before.
- `scripts/restore.sh` — verifies the manifest, restores into a **separate**
  database (`llm_optimizer_restore`) so a drill can never destroy live data,
  and prints row counts for eyeball verification.
- **Restore drill performed 2026-07-29**: manifest verified, 46 responses /
  207 mentions / 434 scores / 3 claims / 1 report restored, live database
  untouched.
- **Operator action required for real durability:** the default
  `var/backups` is the same disk — it protects against corruption and bad
  migrations, not disk loss or theft. Set `BACKUP_DIR` to a synced/mounted
  location and schedule it nightly (cron/launchd).
- Quarterly: run a drill and execute the integration suite against the
  restored database.
- When the Supabase milestone lands: managed daily backups + PITR replace
  the database half; artifact backups move to object storage.

## Dependencies & code
- `npm audit` in CI (fail on high/critical), Dependabot/Renovate enabled.
- No secrets or real captured data in test fixtures — fixtures are sanitized copies.
- Prompt-injection awareness: AI responses are untrusted text. They are rendered escaped, never executed, never fed into tool-calling contexts, and parser prompts treat response content as data (see `docs/12-ai-guidelines.md`).


## Authentication and identity (spec 014, 2026-07-30)

`AUTH_MODE=dev` serves one hardcoded user and is the mode the test suite runs
in — 893 tests must not depend on an inbox. `AUTH_MODE=supabase` reads a real
session.

**The role comes from the `users` table, never from the JWT.** A token is a
claim about identity; letting it also assert privilege means a stale or
compromised token carries whatever role it was minted with. One extra query per
request buys revocation that takes effect immediately — deactivating an account
hides its data on the next query, not at the next token refresh.

**Sign-in is magic link, and cannot self-provision.** `shouldCreateUser: false`,
and the address must already exist in `users` and be active. The login form
returns the same response for a known and an unknown address, so it cannot be
used to enumerate who works here.

**The service-role key never reaches a browser.** `lib/supabase/server.ts`
begins with `import "server-only"`, so any client component importing it —
directly or through a chain — fails the build rather than shipping the key.
That key bypasses row-level security entirely; `supabaseAdminClient()` exists
for provisioning only, and `supabaseRouteClient()` (anon key + session cookie,
RLS applies) serves requests.

**Row-level security is defence in depth.** The app connects as the table
owner, and owners bypass RLS, so these policies govern the Supabase-client path
rather than application queries. The primary control is service-layer scoping:
`assertProjectAccess` (backed by `visibleProjectIds`) gates every
`/projects/[id]/*` page through the segment layout, the three artifact
download routes (report CSV, evidence export, plan export — denials render as
404, because confirming an id exists is itself a leak), and the run-scoped job
actions; project listings (`listActiveProjects`, `listPortfolio`) filter by
the caller's grant in SQL. The 2026-07-31 audit found `visibleProjectIds`
defined but never called — the wiring above is what made this paragraph true.
Isolation tests connect as a non-owner role so they prove the policies instead
of passing vacuously.

**Evidence downloads are recorded.** `artifact_access_log` is insert-only and
captures who took a copy of raw client material off the platform, which the
audit log (what changed) does not answer.

## The public REST API is closed (2026-07-30)

Hosting the database on Supabase adds an attack surface that does not exist on
a laptop: **PostgREST**, which publishes every table in `public` at
`https://<ref>.supabase.co/rest/v1/<table>` to whoever holds the publishable
key — a key designed to be embedded in browsers.

Supabase's default privileges grant `anon` and `authenticated` full rights
(`arwdDxtm`) on every table `postgres` creates. Left alone, restoring this
schema would have exposed `responses`, `claims`, `audit_log` and
`connector_credentials` to the internet, writable, with only three tables
covered by RLS.

Both roles therefore hold **no privileges on `public`** — revoked at the default
level before the restore and explicitly after it. Nothing breaks, because the
application connects as the owner over postgres.js and never used `anon` for
data; the Supabase client is for sessions only. Verified by request: every table
returns 401 through the REST API.

This supersedes the line above describing the app as "anon key + RLS". RLS is
defence in depth for the Supabase-client path; the primary control is that the
API roles cannot read anything at all. **Any future table must be created by a
migration, never through the Supabase dashboard** — a table created there can
pick up default grants and land on the public API.
