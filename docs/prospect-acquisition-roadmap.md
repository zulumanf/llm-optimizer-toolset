# Prospect Acquisition — Implementation Roadmap

> Companion to `docs/prospect-acquisition-gap-analysis.md`. Spec: `specs/032-prospect-acquisition.md`.
> Complexity scale: S (≤½ day) · M (1–2 days) · L (3–5 days) · XL (>1 week).

## Phase 0 — Foundation and data integrity

### 0.1 Domain schema (migration 038) — **in slice**
- **Business value:** everything downstream persists somewhere real; provenance and evidence rules become DB constraints, not conventions.
- **Scope:** `market_launches`, `prospects`, `prospect_authority_signals`, `prospect_benchmarks`, `prospect_findings`, `prospect_audits`, `prospect_audit_views`, `outreach_drafts`, `screen_recording_plans`, `prospect_stage_history`, `prospect_activities`. Indexes on launch/stage/status filters. Insert-only triggers on history/views/activities. CHECK: findings cannot be approved without evidence; audits publish only from approved findings.
- **Dependencies:** none. **Risk:** low (additive). **Complexity:** M.
- **Acceptance:** migration applies and rolls back; immutability triggers verified by tests.

### 0.2 Authorization & isolation — **in slice**
- **Business value:** prospecting intelligence (competitive analyses of non-clients) never leaks to client accounts.
- **Scope:** staff-gated `/prospects` segment; every service function asserts staff; public audit route serves only published, unrevoked, unexpired snapshots; middleware allowlist for `/audit`.
- **Dependencies:** 0.1. **Risk:** high if wrong, low to build (pattern exists). **Complexity:** S.
- **Acceptance:** integration tests — client_viewer gets 404/denial on every prospect surface; revoked/expired/garbage tokens 404.

### 0.3 Stale-doc and precedent cleanup
- **Business value:** the next engineer doesn't re-litigate solved problems.
- **Scope:** fix spec 028 header, spec 014 AUTH_MODE note, `docs/target-gap-analysis.md` exclusivity row; record the spec-011-vs-send-gate contradiction in `DECISIONS.md` as an open decision.
- **Dependencies:** none. **Risk:** none. **Complexity:** S.
- **Acceptance:** docs match code at HEAD.

## Phase 1 — Prospect benchmark vertical slice (**this branch**)

### 1.1 Market launches + prospects CRUD & pipeline
- **Business value:** answers "which high-value teams should we contact" with a persisted, owned list per market.
- **Scope:** create/list launches (linked to the `markets` tree); create/edit prospects with provenance-labeled fields; pipeline stages with transactional `prospect_stage_history`; per-prospect activity timeline; do-not-contact flag.
- **Dependencies:** 0.1, 0.2. **Risk:** low. **Complexity:** M.
- **Acceptance:** operator creates launch → adds prospect → moves stages; every transition produces history + audit + activity rows.

### 1.2 Benchmark linkage & transparent metrics
- **Business value:** turns existing paid measurement into acquisition ammunition at zero marginal token cost.
- **Scope:** link prospect → `companies` row → completed run(s); compute mention rate, recommendation rate, first-position rate, share of voice, citation presence, competitive comparison **read-only** from `mentions`/`scores`; always show n (responses) and provider set; stability labels via `lib/evidence/stability.ts` conventions.
- **Dependencies:** 1.1; a run whose parse includes the prospect's company. **Risk:** medium — metric definitions must match `lib/scoring` exactly (reuse the pure functions, don't reimplement). **Complexity:** M.
- **Acceptance:** metrics for a linked prospect equal what `scores` stores for that company/run; unlinked prospects show an honest empty state.

### 1.3 Reality-to-AI findings with human approval
- **Business value:** the single most compelling, defensible insight per prospect — the core of the pitch.
- **Scope:** verified authority signals (provenance enum, source URLs); deterministic candidate-finding generator (authority-vs-visibility contrasts, competitor contrasts, absence findings) with prescribed safe phrasing ("underrepresented", "recommended less frequently" — never revenue claims); ranking; one approved primary finding per prospect; DB-enforced evidence linkage.
- **Dependencies:** 1.2. **Risk:** medium — wording discipline is a compliance requirement. **Complexity:** M.
- **Acceptance:** candidates cite real response/score evidence; approval requires evidence; prohibited phrasings cannot be produced by the generator.

### 1.4 Secure prospect audit page
- **Scope:** publish an immutable snapshot (headline, benchmark overview with n/providers/date range, key finding, competitive comparison, sanitized prompt evidence, methodology, low-pressure CTA); 256-bit token link; expiry; revocation; view tracking (`prospect_audit_views`); internal preview.
- **Dependencies:** 1.3. **Risk:** high (first anonymous surface) — mitigated by snapshot-only rendering. **Complexity:** M.
- **Acceptance:** published page contains zero internal notes; view rows recorded; revocation immediate.

### 1.5 Outreach draft + screen-recording plan
- **Scope:** deterministic reply-first email draft from the approved finding (versioned; edits create versions; approval gate; manual "mark as sent" only); screen-recording script + storyboard generator with status tracking.
- **Dependencies:** 1.3. **Risk:** low. **Complexity:** M.
- **Acceptance:** draft versions immutable once approved; no send code path from this module.

### 1.6 Exclusivity gate on progression
- **Scope:** stage transitions past `qualified` require a recorded exclusivity check on the prospect's market; blocked verdicts stop progression without admin override + rationale (reuses spec 028 machinery).
- **Dependencies:** 1.1. **Risk:** low. **Complexity:** S.
- **Acceptance:** conflict-blocked prospect cannot advance; override writes audit + rationale.

## Phase 2 — Personalized audit & outreach preparation (deepen)

| Item | Value | Scope | Deps | Risk | Cx | Acceptance |
|---|---|---|---|---|---|---|
| 2.1 Prospect-owned benchmark runs | Run fresh benchmarks for prospects with no existing coverage | `projects.kind='prospect'` (or equivalent); relax `startRun` status check; fix `listCompaniesForProject` exclusion so client SoV denominators are untouched; reuse `onboardClient` | Slice | High (touches measurement core; needs regression tests on client scores) | L | Existing client scores byte-identical before/after a prospect run |
| 2.2 CSV import + research profile | Faster market coverage | Import leading-team lists; per-fact source URL + confidence; no scraping | 1.1 | Low | M | Imported rows labeled by provenance |
| 2.3 Prospect contacts | Real outreach targets | `prospect_contacts` with role/channel prefs, do-not-contact per contact | 1.1 | Low | S | Suppression checks match on contact identifiers |
| 2.4 LLM-assisted finding candidates | Richer angles | Optional LLM generator behind the same deterministic evidence gate + human approval; store model/prompt version/inputs | 1.3 | Medium | M | Every LLM candidate carries model+prompt_version+confidence; unverifiable claims blocked |
| 2.5 Citation-gap section on audits | Stronger evidence story | Reuse `response_citations`/`sources` per competitor | 1.4 | Low | M | Section shows source categories with counts |
| 2.6 Audit email verification option | Higher-trust sharing | Optional email challenge before token page renders | 1.4 | Medium | M | Verified views distinguish visitor identity |

## Phase 3 — Engagement tracking and sales pipeline (activate)

| Item | Value | Scope | Deps | Risk | Cx | Acceptance |
|---|---|---|---|---|---|---|
| 3.1 Resolve spec-011 contradiction | Unblocks send automation | Written decision: gated-send stands or red-level stands | — | Low | S | `DECISIONS.md` entry |
| 3.2 Verified email channel | Real sends, real tracking | Verify Gmail connector live (or add ESP); OAuth redirect flow | 3.1 | High (deliverability, compliance) | L | A real draft lands in Gmail drafts; sends recorded |
| 3.3 Sequence dispatcher | Follow-ups actually happen | Wire `dueSequences()` into cron heartbeat; enrollment-conflict + frequency caps; per-step approval | 3.2 | Medium | M | Step 2 fires after delay; suppressed contacts never enrolled |
| 3.4 Reply ingest + classification | Answers "what happened after we sent it" | Gmail thread polling → `classify_reply` prompt → human review queue → `applyInboundSignal` | 3.2 | Medium | L | Replies classified, never auto-answered |
| 3.5 Deal economics on pipeline | Forecasting | Expected value, retainer, probability, loss reason on prospects; stage-duration analytics | Slice | Low | S | Pipeline report sums correctly |
| 3.6 Prospect→client conversion | Preserves baseline proof | Convert via `onboardClient`; freeze pre-client benchmark reference; case-study permission flag | Slice, 2.1 | Medium | M | Original benchmark immutable post-conversion |
| 3.7 Acquisition analytics dashboard | Funnel visibility | Reply/positive-reply/meeting/proposal/close rates by market/insight/channel; opens de-emphasized | 3.2–3.4 | Low | M | Dashboard matches raw counts |

## Phase 4 — Automation, experimentation, and scale

| Item | Value | Scope | Deps | Risk | Cx |
|---|---|---|---|---|---|
| 4.1 Acquisition experiments | Learn what earns replies | Experiment entity (hypothesis/variants/eligibility/guardrails), honest significance handling | 3.7 | Medium | L |
| 4.2 `prospect.identified` publisher + workflow triggers | Auto-start research on new prospects | Publish the already-declared events; connect `prospect_audit_outreach_v1` | Slice | Medium | M |
| 4.3 Scheduled re-benchmarks for active prospects | Fresh evidence | Reuse scheduled-run machinery per launch | 2.1 | Low | S |
| 4.4 Market-status board | "Which markets are available/reserved/protected" | Rollup of launches + agreements + reservations; control-tower tile | Slice | Low | M |
| 4.5 Multi-provider verification | Claim "across ChatGPT and Perplexity" honestly | Fund + verify Anthropic/Google/Perplexity keys; include search fees in cost math | — | Medium | M |

## Sequencing rationale

The slice (Phase 0–1) is chosen so that **every externally visible claim is backed by measurement data the platform already trusts**, and nothing in it can send, scrape, or fabricate. Phases 2–3 add reach (fresh benchmarks, real channels) only after the evidence discipline and isolation boundaries are proven. Phase 4 optimizes a machine that demonstrably works.
