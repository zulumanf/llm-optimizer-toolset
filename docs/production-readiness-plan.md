# Production Readiness Plan — Closing the Five Gaps

Written 2026-08-03 from the four-lens assessment at HEAD `09389fc` (branch `feat/032-contacts-and-import`, 93 commits ahead of `main`).

Baseline scores and targets:

| Variable | Now | After this plan | What caps it below 10 |
|---|---|---|---|
| Measurement trustworthiness | 7 | 9 | 10 requires months of live multi-provider history and a captured-response parser corpus, not code |
| Prospecting workflow | 6 | 9 | 10 requires a real prospect-discovery data source and outreach deliverability reputation, both external |
| Client work tracking | 6 | 9 | 10 requires effort actuals and contract-value data only the operator can supply |
| Client access & security | 6 | 9 | 10 requires DB-level RLS as primary control — a deliberate architecture change, deferred |
| Deployment & operations | 3 | 9 | 10 requires redundancy/monitoring maturity that only accrues with uptime |

Composite target: **~9 / 10** (from 5.8).

Sequencing rule: phases are ordered by risk, not by score gain. Phase 0 and 1 are prerequisites for everything else mattering — a perfect audit page nobody can load is worth 0.

---

## Phase 0 — Safety rails (Day 1, ~half a day of code)

Nothing ships publicly until these land. All are small.

- **0.1 Make `AUTH_MODE` fail closed.** `lib/env.ts:10` defaults to `"dev"`; `middleware.ts:26` waves everyone through as a hardcoded admin unless the var equals `"supabase"`. Invert it: production build + missing/dev `AUTH_MODE` → refuse to serve (throw at boot), and the dev-admin path requires an explicit `AUTH_MODE=dev` **and** `NODE_ENV !== "production"`. Acceptance: a production build with no `AUTH_MODE` env var returns 500/redirect-to-login on every route; unit test proves it.
- **0.2 Rotate the Supabase DB password** (current one is weak and sits in plaintext `.env` while the pooler is internet-reachable) and enable Supabase network restrictions to the app host + operator IP. Operator task, ~1h.
- **0.3 Confirm the Supabase auth redirect allowlist** contains only the production origin — `app/login/actions.ts:43` builds `emailRedirectTo` from the client-controlled `origin` header, and the allowlist is the only backstop. Operator task, ~15m.
- **0.4 Merge `feat/032-contacts-and-import` to `main`.** 93 commits of the prospecting stack exist on one branch on one laptop. PR, CI green, merge. Everything after this point branches from `main`.
- **0.5 Fix stale docs that misdirect future work:** CLAUDE.md "not multi-tenant, internal only" → describe the real posture (staff + client roles, portal, public audit tokens); check the acceptance boxes in specs 038–043 that shipped; update spec 011's "no code path may exist" wording to match the DECISIONS.md supersession; mark spec 045 approved. ~1h, prevents the next contributor (human or agent) from reasoning from false premises.

## Phase 1 — Deploy (Days 2–4)

The single biggest score mover: it takes Deployment 3→8 on its own and unblocks Prospecting and Client Access simultaneously.

- **1.1 Pick hosting.** Constraint: the system is web app + **long-running worker** (`npm run worker`, `workers/core.ts`) + Postgres (already on Supabase). Vercel cannot host the worker. Recommended: single platform that runs both as services (Railway or Fly.io — web service + worker service from one repo), Supabase stays the DB. Alternative: Vercel for web + Railway for worker (two dashboards, one more failure seam). **Operator decision required.**
- **1.2 Deploy artifacts:** Dockerfile (or Railway/Fly config) for web and worker, env management (all keys server-side; verify no secret ever appears as `NEXT_PUBLIC_*`), `APP_URL` env var introduced and used for share links (replaces `window.location.origin` in `components/prospects/audit-actions.tsx:44`) and `emailRedirectTo`.
- **1.3 Cron.** Point platform cron (or an external pinger) at the four routes under `app/api/cron/` with `CRON_SECRET`. Retire the launchd agents (currently failing with exit 7 on a laptop that must be awake). Acceptance: `weekly-cycle` fires on schedule in production and `client_health_snapshots` rows appear.
- **1.4 Inbound rate limiting** on `/login` (magic-link spam) and `/audit/[token]` (scraping) — none exists despite `docs/10-security.md:24` claiming it. Middleware-level, per-IP token bucket backed by Postgres or the platform's edge limiter. ~0.5d.
- **1.5 Provider keys.** Operator supplies `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `PERPLEXITY_API_KEY`; run one live verification run per provider against the Lumina fixture project; flip `verified: true` on the pricing rows that check out. Until then every client-facing surface must say "measured on ChatGPT" — not "AI assistants."
- **1.6 Deploy smoke checklist** committed to `docs/`: boot with auth on, login round-trip, run executes via worker, audit token resolves, portal login sees only granted project. Acceptance: checklist executed and dated in the doc.

## Phase 2 — Measurement provenance (Days 5–6) → Trustworthiness 7→9

All pure code, no operator input.

- **2.1 Parser stamp truth.** `lib/parsing/service.ts` stamps `activeParserVersion()` (LLM) even when the LLM classifier threw and the heuristic fallback produced the rows. Thread the *actual* classifier used into the insert so fallback rows carry the heuristic version. Add a test that forces the LLM path to throw and asserts the stamp.
- **2.2 Pin parser version per run, not per env-read.** `lib/parsing/version.ts` derives the version from `OPENAI_API_KEY` presence at read time; key changes silently reclassify history. Resolve once at run/parse-job creation and store it.
- **2.3 Exclude mock downstream.** Add `provider != 'mock'` to scoring aggregation (`lib/scoring/metrics.ts`), report/benchmark reads, and the audit snapshot assembly — plus a boot-time warning banner when mock rows exist in the connected DB. The registry gate is necessary but not sufficient; the dev recipe (`.claude/skills/run-app`) legitimately creates mock rows.
- **2.4 Immutability trigger on `scores`** — the one measurement table protected only by convention. Migration + reversibility test, matching `responses`/`mentions`.
- **2.5 Benchmark-run reaper.** A dead-lettered `execute_run` job leaves the run at `running` forever. Sweep: runs `running` with a dead-lettered/absent job → `failed` with reason, surfaced in the Today feed. Mirrors the workflow engine's stale-node reaper.
- **2.6 Evidence-before-cost ordering.** In `lib/runs/execute.ts`, `costMicroUsd()` throws *before* the raw response insert — one dropped pricing row away from destroying evidence. Capture first, then price; a pricing failure marks the cell errored *after* the payload is safe.
- **2.7 Spend ceiling + shared rate gate.** Add a global daily cap (`DAILY_BUDGET_MAX_USD`, checked at run start against the day's recorded spend) and hoist `createRateGate()` out of `executeRun` so concurrent runs actually share it, as its own docblock claims.

Acceptance for the phase: `select distinct provider` hygiene is enforced by code, not by the operator remembering; a run whose worker dies three times reaches a terminal state; all new paths tested.

## Phase 3 — Prospecting last mile (Days 7–10) → Prospecting 6→9

- **3.1 Audit link in the draft.** `lib/prospects/outreach.ts` generates a draft that never includes the audit URL while the audit page's CTA says "reply to the email that brought you here." Insert the published link (requires 1.2's `APP_URL`); refuse draft generation when no published audit exists, or include it conditionally.
- **3.2 Draft editing.** Replace the read-only `<pre>` on the prospect detail page with an editable body (server action, re-run prohibited-phrase gate on save, audit-log the edit). The operator will always want to personalize.
- **3.3 Bind contacts to drafts.** Contact picker on `GenerateDraftButton` → `contactId` through to send, so the per-contact DNC gate fires and the ledger records the person, not the business address. This is the point of the branch you just built.
- **3.4 Token expiry on by default.** UI passes `expiresAt` (default e.g. 30 days, editable) on publish; add an "expire now" action distinct from revoke. Kills the immortal-link gap.
- **3.5 Real send channel — smallest honest version.** Add a `gmail` channel to the prospect send path reusing the existing Google connector adapter (`status: implemented_unverified`) behind the existing gate chain, with OAuth done once by the operator. Migration widens the `channel` check constraint. Falls back to `manual` if OAuth isn't granted. **Operator decision:** Gmail OAuth vs. staying manual-but-assisted (3.1+3.2 alone already remove most of the friction — a `mailto:` with prefilled body+link is an acceptable v1).
- **3.6 Operator preview ≠ external view.** Signed preview parameter or staff-session detection so the operator's QA opens don't inflate "external views" (`lib/prospects/service.ts:2097`).
- **3.7 Vertical-neutral copy.** The snapshot bakes in real-estate language ("teams", "listing appointment") and a broken fallback ("40 real the monitored market questions"). Move vertical phrasing into the market pack definition so a non-real-estate pack reads correctly; fix the fallback sentence.
- **3.8 Discovery: make the button honest.** The Discover dialog renders with an empty provider list and errors on submit (mock-only registry). Either hide it until a real source adapter exists, or ship one real adapter (e.g. Google Places for the current vertical). Hiding is fine for 9/10; CSV import is a workable universe source.

## Phase 4 — Client access hardening (Days 11–12) → Client access 6→9

- **4.1 `client_visible` on interventions** (deny-by-default, matching tasks) — today internal work titles reach the portal verbatim via `lib/portal/service.ts:89-93`.
- **4.2 Defense in depth in portal services.** `portalWork(projectId)` et al. take no user; the layout is the only check. Pass the session user and re-assert access inside each service, per Next.js guidance that layouts are not an authorization boundary.
- **4.3 Export column audit.** Report CSV/HTML/evidence routes check project access but not staff — enumerate the columns each export emits and strip internal-only fields (cost, operator notes) for client-role requests.
- **4.4 `audit_log.project_id`.** Migration adds the column, `writeAudit` populates it, backfill where resolvable. This is also the enabler for 5.2.
- **4.5 Error message hygiene.** `app/error.tsx` renders `ClassifiedError` strings verbatim; review the catalog for anything internal before client eyes are on it.

## Phase 5 — The agency layer (Days 13–17) → Client tracking 6→9

- **5.1 Cross-client work board.** One staff page: all open tasks across projects, filterable by owner / priority / due / client, overdue surfaced. The queries are trivial (`owner_id`, `due_date`, `project_id` all exist); the gap is purely a missing page.
- **5.2 Per-client activity timeline.** A UI reader for `audit_log` (post-4.4) on the project page: "everything we did for this client, newest first." Turns the write-only work history into the accountability answer for "what did we do in March?"
- **5.3 Tasks enter the control-tower queue.** Add `task_overdue` / `task_p1_stalled` as `QueueSource` kinds with formula weights, so the "what first?" surface can finally see the work items.
- **5.4 Make the 90-day plan live.** Write `plan_items.status` and `plan_items.task_id`: composing a plan item can spawn a linked task; completing the task flips the item. The schema has waited since migration 026.
- **5.5 One attention surface to rule them.** Don't rebuild — reconcile: Today becomes the single entry point and embeds the control-tower queue's top-N; notifications/approvals stay as drill-downs. Cheap version: cross-links + a shared "attention count" so the four surfaces stop disagreeing.
- **5.6 Digest delivery.** Wire `digestText()` to one real channel (email via the same connector as 3.5, or Slack webhook). Copy-button → actually sent.
- **5.7 Contract value column** (`projects.contract_value_cents`, nullable) so control-tower commercial weighting stops proxying value with provider spend. Operator supplies the numbers.

## Explicitly deferred (recorded so they're chosen, not forgotten)

- RLS as primary control (app connects as table owner; switching to a non-owner role + policies on 140 tables is an architecture project — revisit before any external pen test).
- Live cross-provider claims in client materials until 1.5 verification passes per provider.
- Fuzzy/domain dedup on prospect import; effort actuals / time tracking; GA4/CRM ingestion; monthly/quarterly report generators; white-label portal branding.

## Operator decisions needed (everything else proceeds without input)

1. **Hosting platform** (1.1) — recommendation: Railway or Fly.io, web + worker together.
2. **Provider API keys** (1.5) — Anthropic, Google, Perplexity.
3. **Send channel** (3.5) — Gmail OAuth vs. assisted-manual v1.
4. **Contract values** (5.7) — optional, anytime.

## Effort summary

| Phase | Days | Score impact |
|---|---|---|
| 0 Safety rails | 0.5–1 | unlocks everything; Security 6→7 |
| 1 Deploy | 2–3 | Ops 3→8, Prospecting +1, Security +1 |
| 2 Provenance | 2 | Measurement 7→9 |
| 3 Prospecting last mile | 3–4 | Prospecting → 9 |
| 4 Access hardening | 2 | Security → 9 |
| 5 Agency layer | 4–5 | Tracking → 9, Ops → 9 (monitoring maturity) |

**Total: ~3.5 working weeks solo**, front-loaded so that after week 1 (Phases 0–2) the tool is already safely deployable with trustworthy data — the remaining two weeks are capability, not risk.
