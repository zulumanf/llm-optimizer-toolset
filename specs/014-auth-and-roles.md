# Spec 014 — Real Authentication & Role Enforcement

> Status: done (2026-07-30) — see "Not built" below
> Depends on: specs/001 (roles) · docs/10 · DECISIONS (auth deferred)
> Priority: **P0** (docs/audits/paid-pilot-readiness.md)

## Blocker (be explicit)
`lib/auth.ts` returns a hardcoded dev user and throws for
`AUTH_MODE=supabase` ("not implemented yet"). Implementing it requires a
Supabase project that only the operator can create (account, org, billing
tier, region choice). **Nothing in this spec can be executed until
`SUPABASE_URL` and `SUPABASE_ANON_KEY` (+ service role key) exist in
`.env`.** No partial implementation should be merged in the meantime: an
untested auth integration against an unreachable service is worse than an
honest dev-mode gate.

## Why it is P0
Client evidence — raw captures, claims, reports — currently sits behind a
login that does not exist. Even with a single operator, "who did this"
in the audit log is only as trustworthy as the identity behind it, and no
client can be given read-only access without real sessions.

## Scope when unblocked

1. **Auth adapter** — implement the `supabase` branch of `lib/auth.ts`
   (`getCurrentUser()` reads the session; unauthenticated → redirect to
   `/login`). Keep `AUTH_MODE=dev` working for local development and tests
   (tests must not need a network identity provider).
2. **Login route + middleware** — `app/login/page.tsx`, session refresh
   middleware, sign-out. Dark-mode-consistent with the design system.
3. **Roles mapped to real users** — `admin | operator | reviewer |
   client_viewer | client_validator` on a `users` table (or Supabase
   `app_metadata`), replacing the env-configured single role. The existing
   `assertRole` gates (`lib/mentions/service.ts`, `lib/attribution/…`,
   archive controls) then become meaningful rather than decorative.
4. **Client-scoped access** — `client_viewer`/`client_validator` see only
   projects they are granted, read-only, and never internal notes
   (report drafts, gap rationales, task internals). Enforce in queries
   first (a `projectsVisibleTo(user)` helper used by every list), then add
   Postgres RLS as defence in depth.
5. **Audit-log identity** — `audit_log.user_id` becomes a real FK; add
   artifact-access logging for evidence downloads.
6. **Secrets** — service-role key server-only, never in a client bundle;
   documented in docs/10.

## Acceptance criteria
- [ ] Unauthenticated request to any `/projects/**` route redirects to login.
- [ ] `AUTH_MODE=dev` still boots the app and the full test suite with no
      Supabase reachable.
- [ ] A `client_viewer` session sees exactly one client's projects,
      read-only, with no write action rendered or accepted server-side
      (tested at the service layer, not just the UI).
- [ ] Every existing role gate has a test proving denial for the wrong role.
- [ ] Evidence downloads are recorded in the audit log with the actor.
- [ ] docs/10 updated; DECISIONS records the final role model.

## Operator checklist to unblock
1. Create a Supabase project (any region; free tier is sufficient to start).
2. Add to the single `.env`: `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, and set `AUTH_MODE=supabase`.
3. Decide whether client users get logins in the pilot, or whether clients
   receive exported evidence packages only (the pilot readiness doc assumes
   exports; logins can wait for pilot #2).


## Not built (2026-07-30) — stated so nothing here is over-claimed

- **No client logins are issued.** The operator's answer to checklist item 3
  was "internal tool, single operator", so `client_viewer` / `client_validator`
  exist as roles, are enforced everywhere, and have tests — but no such account
  has been provisioned. Clients receive exported evidence packages, which is
  what the pilot-readiness doc already assumed. `user_project_access` is the
  seam that makes issuing one a data change rather than a refactor.
- **The magic-link flow has not been exercised end to end.** `AUTH_MODE` is
  still `dev`, so no real sign-in has happened against the live Supabase
  project. The code paths are typed, built and unit-covered; they are not
  proven. Flipping the mode is the remaining step.
- **RLS is defence in depth, not the primary control.** The application
  connects as the table owner, and owners bypass RLS. Policies bite on the
  Supabase-client path; service-layer scoping remains the control that governs
  application queries. Tests connect as a non-owner role precisely so they
  prove the policies rather than passing vacuously.
- **`assertRole` still only distinguishes admin and staff.** `reviewer` is
  defined and treated as staff, but nothing yet grants it narrower rights than
  `operator`.
