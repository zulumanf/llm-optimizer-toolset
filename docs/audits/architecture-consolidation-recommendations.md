# Architecture & Consolidation Recommendations

> 2026-07-29 · Companion to `five-connected-products-audit.md`

## Canonical architecture: keep the spine, add products as modules

**No rewrite is warranted.** The evidence: one implementation each of
parsing, scoring, gap analysis, agents, and approvals; 181 passing tests;
five immutability triggers; and a queue that already survived crash-recovery
testing. The five products should be organized as modules over the existing
shared spine:

```
                    ┌────────────────────────────────────────────┐
                    │  SHARED SPINE (exists)                     │
                    │  auth/roles · projects(=clients) · claims  │
                    │  evidence(+artifacts,hashes) · audit_log   │
                    │  jobs queue · lib/ai adapters+agent runner │
                    │  approvals pattern · reports engine        │
                    └────────────────────────────────────────────┘
   P1 Visibility        P2 Reputation      P3 Authority       P4 Revenue        P5 Advisory
   lib/prompts,runs,    lib/claims (+      lib/gaps,tasks,    (new) lib/        lib/reports (+
   parsing,scoring,     monitoring,        content (+011      analytics,        cadences,
   evidence             corrections)       outreach)          leads,crm         synthesis)
```

## Specific recommendations

1. **Rename `lib/attribution/` → `lib/interventions/`** (and route
   `/interventions` already matches). "Attribution" must be free for
   product 4's revenue semantics before any of it is built. Mechanical
   change; do it in a quiet window. (Duplication-risk class: naming.)

2. **Unify citation storage.** Today: `mentions.cited_urls` (per-company,
   parse-time) + `sources` (global upserts) + payload re-scans at read time
   (`lib/ai/citations.ts` callers). This converges correctly but `sources`
   should become **project-scoped** with an optional `response_id` link
   table when product 2's monitoring lands — per-client source intelligence
   is a selling point and current global counts blur clients.

3. **Two "evidence" tables are fine — document the split.** `evidence`
   (DB-fact references backing tasks/claims) vs `evidence_artifacts`
   (hashed files). Renaming `evidence` → `evidence_refs` would be clearer
   but migration churn outweighs benefit now; add a docs/03 note instead.

4. **Notifications as a shared primitive, not per-product.** Products 2
   (drift alerts), 3 (approval queues), 5 (weekly pulse) all need it.
   One `notifications` table + digest job + (later) email adapter. Build
   once, before any product-level alert feature.

5. **Cadence layer belongs to the reports engine.** Weekly pulse / monthly
   exec / quarterly QBR should be report *templates* with generation
   triggers, not new subsystems — the immutability, evidence-gating, and
   delta machinery is already there (`lib/reports/*`).

6. **Category-ownership map is a view, not a feature.** All inputs exist
   (per-category drilldowns, stability labels, gap scores). Compose; don't
   model anything new.

7. **Agent registry when agent count grows.** Three agents share one
   runner today; at >5 (parser v2, accuracy monitor, competitor evidence,
   pitch drafter…) add a declarative registry (id, version, schema, model,
   effort) in one module, mirroring docs/13.

8. **Keep the Postgres queue** until content/outreach graphs need DAG
   dependencies or human-wait steps measured in days; the recorded revisit
   point (DECISIONS) stands. Temporal/Trigger.dev adoption earlier would be
   speculative complexity.

9. **Storage:** local `var/evidence/` is correct for the single-box present;
   the Supabase milestone should move artifacts + add signed URLs in the
   same change as client-viewer access (they're coupled: portals need URLs).

10. **Dead/scaffold cleanup:** wire the client-validation UI (services are
    tested and invisible), or mark the feature explicitly "API-only" in
    the spec. `EvidenceCaptureAdapter` stays as an intentional seam.

## What NOT to do

- No microservices; no separate apps per product (CLAUDE.md rule holds and
  the audit found no scaling pressure that contradicts it).
- No ORM introduction mid-flight; schema-as-SQL is load-bearing for the
  immutability/trigger discipline.
- No composite "AI visibility score" as a product surface (PRINCIPLES —
  the audit confirms component-metrics-first is working and is a
  differentiator).
- Don't build product 4 on inference-heavy attribution. The platform's
  brand is evidence; launch attribution with confirmed/self-reported/
  probable labels and never blend them.
