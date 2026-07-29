# Five-Products Roadmap (Prioritized)

> 2026-07-29 · Gap priorities scored Client value × Dependency × Risk
> reduction × Feasibility (each 1–5; max 625). P0 = before any client use;
> P1 = during first paid pilot; P2 = before >5 clients; P3 = optimization;
> P4 = future.

## P0 — Trust and data integrity (Phase 0)

> **Status 2026-07-29 (same day):** classifier v2 **DONE** (spec 013,
> merged — live re-parse retracted all three false positives); backups +
> verified restore drill **DONE** (`npm run backup` / `npm run restore`,
> docs/10); real auth **BLOCKED on operator action** — spec 014 written and
> ready, needs a Supabase project the operator must create.

| Item | Product | Score | Rationale |
|---|---|---|---|
| LLM classifier v2 + fresh-context verifier | 1 | 5×5×5×4=**500** | Every metric, gap, verdict, and report inherits classification quality; name-collision false positives proven live. Feasible: agent runner + revision model exist; re-parse is a designed operation (`reparseRun`). Acceptance: collision fixture (Parva/Mahabharata) classified correctly; confidence-routed to review; parser_version bumped; historical revisions preserved. |
| Real authentication (Supabase) | shared | 5×5×5×3=**375** | Client data behind a hardcoded dev login is disqualifying; also unblocks client-viewer role (P1) and RLS (P2). Acceptance: login required; roles mapped; AUTH_MODE=dev still works for local dev. |
| Backups + restore runbook (pg_dump + var/evidence sync) | shared | 4×5×5×5=**500** | Evidence-grade product with zero backups is self-contradicting. Acceptance: nightly dump + artifact sync, tested restore, documented in docs/10. |

## P1 — Paid proof of concept (Phase 1)

| Item | Product | Score | Rationale |
|---|---|---|---|
| Self-reported AI-discovery lead log | 4 | 5×4×4×5=**400** | The only revenue signal available from day one; trivial build (one table + form + report section). Starts accruing before GA4 exists — waiting loses data forever. |
| GA4 CSV import + AI-referrer rules (confirmed/probable labels) | 4 | 5×4×3×4=**240** | Turns the pilot's manual traffic section into system data without OAuth scope creep. |
| ~~Schedule weekly baseline~~ **DONE** | 1/5 | 4×4×3×5=**240** | CRON_SECRET set, endpoint verified (401/200), Parva baseline configured (search-enabled, $2 cap), launchd template in `scripts/`. Caveat: fires only while the machine is awake and the app is serving — hosted scheduling is the durable answer. |
| Second live provider (Anthropic or Gemini key + live verification) | 1 | 4×3×4×4=**192** | docs/06 verdicts need ≥2 providers for "notable"; also de-risks OpenAI dependency. |
| ~~Client-validation UI page~~ **DONE** | 1 | 3×2×4×5=**120** | `/projects/[id]/validation` — seeded run creation, client instructions, immutable observation recording, directional comparison. Closes the audit's "tested but invisible" finding. |
| Weekly/monthly cadence report templates + delivery (email/PDF or share link) | 5 | 4×3×3×3=**108** | Report engine exists; cadence formats + any delivery mechanism. |
| Factual-accuracy monitoring v1 (responses vs approved claims) | 2 | 4×3×4×3=**144** | Reuses FACT_VERIFY pattern against claims; produces the "LLM misinformation report" clients feel viscerally. |

## P2 — Before scaling past ~5 clients (Phases 2–3 start)

- Notifications primitive (approval needed / job failed / material error) —
  products 2 & 5 alerts depend on it.
- Spec 012 vertical packs (prompt templates, compliance checklists, claim
  vocabularies) — required for realtor/medical clients; compliance agent
  currently generic-only.
- Spec 011 outreach CRM (journalist registry, pitch drafts, Gmail drafts,
  ranking packages) — the third-party-authority arm of product 3.
- Correction workflow as typed objects (finding→wording→before/after→recheck).
- Project-scoped sources + per-competitor source profiles (spec 009 v2 LLM
  enrichment).
- RLS + client-viewer read-only portal on Supabase.
- Rename `lib/attribution` → `lib/interventions` before product-4 build.
- Cloud artifact storage + signed URLs (Supabase Storage).

## P3 — Revenue loop (Phase 3)

- GA4 OAuth integration (replace CSV), landing-page/behavior metrics.
- CRM objects (lead→consultation→agreement→transaction→commission) +
  offline outcome events; import-first, integration-later.
- Attribution models with confidence labels (confirmed AI referral vs
  self-reported vs probable — never conflated; PRINCIPLES alignment).
- Prompt-cluster→landing-page→lead→revenue join views.
- Verdict-outcomes feedback into opportunity-score weights (loop step 14).

## P4 — Executive intelligence (Phase 4)

- Category-ownership map (compose from existing rates/stability/gaps —
  cheapest item in this phase, could pull forward).
- Quarterly QBR generation; budget-allocation recommendations; what-if
  scenario comparison; market-expansion analysis (needs spec 012 markets +
  product 4 revenue data).
- Cross-client benchmarks (needs ≥5 clients of data).

## Sequence recommendation

1. P0 trio (classifier v2 → auth → backups) — ~the next working block.
2. Lead log + cron + second provider (fast wins) while GA4 import is built.
3. Sign pilot #1 under the honest scope in `paid-pilot-readiness.md`.
4. During pilot: accuracy monitoring v1, validation UI, cadence templates.
5. Post-pilot: P2 by client vertical (packs before a realtor client;
   outreach CRM when authority work saturates owned content).

Each phase's acceptance criteria follow the platform's standing rule: spec
first (specs/ numbering continues), tests green, live smoke against real
data, DECISIONS updated.
