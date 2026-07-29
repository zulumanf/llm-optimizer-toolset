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
