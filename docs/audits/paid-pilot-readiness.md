# Paid-Pilot Readiness Assessment

> 2026-07-29 · Companion to `five-connected-products-audit.md`

## Classification: **READY WITH MANUAL OPERATIONAL SUPPORT** — after three P0 fixes

A 90-day proof-of-concept for one client is realistic **if the operator
runs the platform as an analyst console and delivers client-facing outputs
manually** (exported evidence packages + reports), and **only after the
three P0 blockers below are closed**. It is NOT ready for a client to log
in, and NOT ready to promise in-system revenue attribution.

## Pilot requirement scorecard

| Requirement | Can do today? | Evidence / caveat |
|---|---|---|
| Onboard one client | ✅ | Project + subject + claims + competitors + prompts, all UI (spec 008) |
| Verified entity record | ✅ | Claims register with evidence + approval |
| Frozen benchmark | ✅ | Freeze + versioning + holdout flags |
| Repeated LLM observations | ✅ (OpenAI ±search) / ⚠️ others coded, never live-run | `lib/ai/*`; keys absent |
| Preserve raw evidence | ✅ | Immutable + SHA-256 at capture |
| Classify mentions/recommendations | ⚠️ **P0** | Heuristic v1 has proven name-collision false positives |
| Transparent metrics | ✅ | Numerator/denominator + drill-down + mismatch flags |
| Positive AND negative observations | ✅ | Evidence Explorer filters |
| Export evidence package | ✅ | Hash-verified tar.gz |
| Identify competitors + sources | ✅ (surface-level) | Matrix + search citations; "why they win" depth pending |
| Evidence-gap recommendations | ✅ | 6 typed detectors + opportunity scores |
| Action tasks + completion tracking | ✅ | Tasks + interventions + verdicts |
| GA4 connect or analytics import | ❌ | Product 4 missing — pilot must report traffic manually outside the system, or descope |
| Track AI referrals | ❌ | Same |
| Self-reported AI discovery capture | ❌ | Same (a one-table lead log would be a small P1 add) |
| Weekly/monthly/final reports | ⚠️ | Report engine works; cadence + delivery manual; cron unscheduled |
| Client data privacy | ⚠️ **P0** | Data-scoped, but single shared login and **no backups** |
| Read-only client visibility | ❌ | No client login; deliver via exports (acceptable for a pilot if disclosed) |

## P0 blockers (required before ANY paying client)

1. **LLM classifier v2 (with fresh-context verification).** The heuristic
   parser counts other entities named like the client as client mentions —
   proven live with "Parva" (Mahabharata answer counted as a mention;
   collision set includes parvahealth.com, parvaconsulting.com). A paid
   pilot built on evidence-grade transparency cannot show a client
   miscounted evidence. Feasible: the fact-verify agent pattern
   (`lib/ai/agent.ts`) already exists; mention revisions absorb re-parses
   by design.
2. **Real authentication.** `lib/auth.ts` is a hardcoded dev user. Even
   with zero client logins, operator access to client data must be behind
   a real login (Supabase auth is the recorded plan).
3. **Backups + retention.** Postgres (port 5433) and `var/evidence/` live
   on one laptop with no backup job. Client evidence loss = pilot over.
   Minimum: nightly `pg_dump` + `var/` sync to cloud storage, documented
   restore.

## P1 (during the pilot's first weeks)

- Self-reported AI-discovery lead log (small table + form) so "how did you
  find us?" data accrues from day one even without GA4.
- GA4 CSV import + referrer-rule classification (confirmed vs probable
  labels), replacing the manual traffic sections of reports.
- Schedule the weekly baseline (set CRON_SECRET + real scheduler).
- Client-validation UI page (services + tables already exist and are tested).
- Second provider live (Anthropic or Gemini key) — single-provider verdicts
  can never reach "notable" under docs/06's ≥2-provider rule; disclose
  otherwise.

## What to sell honestly in the pilot

Visibility benchmarking with auditable evidence, competitor/source
intelligence, gap-driven action plans, fact-locked content production, and
before/after remeasurement of every shipped action — with traffic/lead
attribution delivered manually from the client's own GA4 until product 4
exists. Do not sell: client portal access, revenue attribution, automated
reputation monitoring, or media outreach.
