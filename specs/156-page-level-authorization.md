# Spec 156 — Page- and action-level authorization (hotfix)

> Status: implemented locally (2026-10-21) on `hotfix/156-page-level-authorization`, branched from `main` (`41afb23`, migration 118). Not committed, not deployed. No migration.
> Severity: **P0**. On `main`, a signed-in client account can read other clients' data (pages) and invoke staff mutations (server actions, audit finding P1-13).
> Audience: operator (internal workspace). No client-facing change.

## Status

- **Vulnerability: FIXED** on this branch. Effective only once deployed.
- **Historical production exposure: UNKNOWN UNTIL PRODUCTION ACCOUNT/LOG REVIEW.** Test results do not show whether the hole was used.

## Operator review of production (read-only; mandatory; not done by the coding agent)

1. Client-role accounts and invitations:
   ```sql
   select id, email, role, active, created_at, last_seen_at
   from users where role in ('client_viewer', 'client_validator');

   select created_at, user_id, detail from audit_log
   where action = 'portal.invite_client' order by created_at;
   ```
2. If both are empty, no account could have reached either hole. Record that as the finding, with the date checked.
3. If any account exists:
   1. Deactivate it first (`setUserActive`).
   2. Check `last_seen_at`. If it is null, the account never signed in.
   3. List what it did:
      ```sql
      select action, count(*), min(created_at), max(created_at)
      from audit_log where user_id = any(array[<ids>]::uuid[]) group by action order by 1;
      ```
   4. In the host's request logs for those sessions, look for GETs to `/work`, `/projects/`, `/control-tower`, `/exclusivity`, `/prospects`, `/learnings`, and for POSTs with a `Next-Action` header (server-action calls).
   5. Record counts, dates and paths only, never row contents.

## Finding

Next.js renders a route's layouts and its page **concurrently**. If a layout throws `redirect()` or `notFound()`, the page segment has still been rendered, and its RSC payload is still streamed in the response. The browser shows the redirect or the 404, but the data is in the bytes.

Every internal page relies on a layout for authorization:
- `app/projects/[id]/layout.tsx`: project access plus a redirect for non-staff. Its comment calls the check "impossible for a new page to forget".
- `app/{prospects,work,control-tower,exclusivity,…}/layout.tsx`: `requireStaffPage()`.

`/learnings` has neither.

**Evidence (2026-10-21).** I ran a production build of `main` (`next build && next start`, dev auth as `client_viewer`, a local sandbox DB with canary strings). It was swept over every `page.tsx`, with the granted and an ungranted project id substituted in. **31 routes returned canaries the client must not see:**

| Route | What it returned |
|---|---|
| `/work` | Every client's tasks and project ids |
| `/control-tower`, `/exclusivity` | Portfolio client names and market data |
| `/projects/<ungranted>/*` (27 pages) | The other client's project name, description, tasks and section data |
| `/projects/<granted>/tasks` | The client's own internal (non-client-visible) tasks |

The same sweep on the 154/155 branch found 42 routes in a dev build and 35 in a production build.

**Exposure precondition.** An account provisioned in production with a client role (`client_viewer` / `client_validator`). Production refuses anyone without a `users` row. Whether any exists can only be answered against production. That read-only query is for the operator to run; it is not part of this spec.

## Fix

1. `lib/security/page-gates.ts` gains `requireProjectStaffPage(projectId)`:
   - no session → `/login`;
   - no grant → `notFound()` (404, never 403);
   - non-staff → `/portal/<id>`.
2. **Every internal page awaits its gate as its first statement**, before any data access:
   - `requireProjectStaffPage(id)` under `app/projects/[id]/**`;
   - `requireStaffPage()` everywhere else internal.

   The layouts keep their checks for defence in depth, but their comments stop claiming to be the boundary.
3. **Exempt pages, an explicit list with a reason for each:**
   - marketing pages and `/login`: public;
   - `/report/[slug]/*`: prospect report session (spec 134);
   - `/portal/**`: every read goes through `lib/portal/service.ts`, which asserts project access per call.
4. **Guards:**
   - `tests/unit/page-gates-static.test.ts` fails if any `page.tsx` outside the exempt list does not call a gate in its own source, or calls it after another `await`;
   - `scripts/authz-sweep.ts` (local sandbox only) repeats the canary sweep against a running server, so the evidence above is reproducible.

Route handlers (`app/api/**`) do not render through layouts and already assert their own access. They are re-verified here by reading each one, and are not otherwise changed.

## Acceptance criteria

- [x] Sweep of a production build of this branch: 0 canary hits for `client_viewer` across 137 requests (the same script found 31 on `main`). Staff routes redirect a client to `/portal`; another client's project 404s; the client's own project redirects to `/portal/<id>`.
- [x] Staff (admin, operator) still render every page: full Playwright suite 76/76, on an isolated database (`E2E_DATABASE_URL`).
- [x] The static test passes, and fails when a gate is removed from a project page and from a staff page (checked by mutation).
- [x] `app/api/**` routes checked one by one. Cron and health use `requireCronSecret`. Evidence, plan export and report CSV/HTML use session + `assertProjectAccess`. The assistant stream uses session, and `askAssistant` asserts staff. Webhooks verify signatures. `open/[token]` and `audit-signal` are public by design (spec 092 / audit pages).
- [x] Typecheck and lint are green; vitest has 2,688 passed. The 13 failures in `tests/integration/followups.test.ts` also fail on untouched `main`: they are time-dependent fixtures, fixed by `010a92a` on the spec 147 branch, and unrelated to this change.

## Test infrastructure

`scripts/seed-e2e.ts` accepts any local database whose name contains `e2e`, and global setup creates the configured database. `E2E_DATABASE_URL` previously could not isolate a run, because the seed only accepted the shared `llm_optimizer_e2e`. CI's URL still passes.

## Write side: server actions (P1-13, ported)

Server actions are public POST endpoints. No layout or page gate protects them.

### What `main` does

**The shared runner.** `makeActionRunner` (used by 23 of the 31 action files) only authenticates. Its services usually check `assertCanWrite` themselves, but after validating input. A client therefore got validation errors that revealed the input shape, but no write.

**Hand-written actions with no role check at all.** These are confirmed by reading the code and, where marked, by the runtime suite:

| Action | Effect a client could cause on `main` |
|---|---|
| `workflows.startWorkflowAction` | start a durable workflow |
| `workflows.decideApprovalAction` | decide any non-admin approval and resume its workflow |
| `workflows.cancelWorkflowAction` | cancel a workflow run |
| `workflows.retryNodeAction` | retry a node |
| `workflows.resolveExceptionAction` | resolve an exception |
| `automation.startAutomationRun` (test mode) | start an automation run. **Runtime suite: 642 write statements as `client_viewer`.** |
| `automation.retryAutomationNode` | retry a node |
| `automation.cancelAutomationRun` | cancel a run |
| `automation.suppressContact` | add a suppression entry |
| `automation.stopOutreachSequence` | stop an outreach sequence |
| `knowledge.requestClaimExtraction` | queue paid claim extraction on any project's source. The project id is checked only against the artifact, never against the caller's grant. |
| `runs.estimateRun` | read the question count and cost estimate of any prompt-set version (no wording) |

### Gated, but not first (late refusal, not exploitable)

- `assistant.*`: `assertStaff` sits in the service. `confirm`/`cancel` act only on the caller's own pending actions, which only staff can create.
- `knowledge.uploadSource`: `ingestSource` asserts.
- `control-tower.acknowledgeDrift`, `onboarding.onboardClient`: the service asserts after parsing.
- The engagement helper `run`: every engagement service asserts.

### Fix

This is spec 155's diff for those nine files, checked to apply cleanly to `main` and to carry no spec 147 code:

- `makeActionRunner` calls `assertCanWrite` before the wrapped action;
- every hand-written action asserts staff immediately after `getCurrentUser()` (workflows: before validation);
- read-only staff actions use `assertRole(user, "operator")`.

### Guards

**`tests/integration/server-action-authorization.test.ts` (runtime).** It calls every exported action of every `"use server"` module as `client_viewer` and `client_validator`. The client has a grant on a real project, and every call names it. A call passes only if all five hold:

1. it was refused;
2. the refusal came from a staff gate (`assertCanWrite`/`assertRole`), not from a validation error or a lookup that missed;
3. no query ran before that gate (grant reads inside auth excepted);
4. no INSERT/UPDATE/DELETE statement ran, including rolled-back and zero-row statements. Statement-level triggers bump a sequence, and sequences never roll back;
5. there was no fetch, http/https call or subprocess.

Positive controls show the instruments detect staff queries, writes and success.

**`tests/unit/server-action-gates-static.test.ts` (structural, no DB).** Each exported action calls an unconditional staff gate before any parse, query or `await`, or delegates to a runner that does. It also asserts that the runner itself gates before calling the action.

**Exemptions are explicit with reasons:** `app/login/**` (sign-in), the marketing audit request, and the report-session walkthrough request.

## Test fixtures

`tests/integration/followups.test.ts` pinned Touch 1 to 2026-09-01, and the 21-day sequence age is checked against the real clock, so 13 tests failed on `main` from 2026-09-22 onwards. Commit `010a92a` (from the spec 147 branch) is ported unchanged. It is test-only, and replaces pinned dates with dates computed from now.
