# First-client delivery runbook (spec 131)

Operator checklist for a signed retained client. Everything below that is
**manual** is manual on purpose for the first client; the OS records the
truth of each step and refuses to advance without it.

## 0. Before signing — contract (MANUAL, no legal language in the platform)
The platform does not generate or sign contracts. Use counsel-reviewed paper.
Record only the state (`draft → sent → signed` + reference) on the engagement page.
Minimum terms the agreement must cover before you mark it `signed`:
- Client legal entity · Recommended First legal entity
- Start date · initial term (90 days) · monthly fee ($7,500) · total initial value ($22,500)
- Payment terms (invoice monthly in advance; first payment before onboarding)
- Scope (AI recommendation diagnosis, evidence improvements, high-confidence implementation, monitoring, remeasurement) and explicit exclusions (SEO, redesign, ads, social, CRM, general marketing)
- Client responsibilities (access, approvals, timely input)
- **No ranking / visibility guarantee** — the promise is rigorous baseline, evidence-backed diagnosis, documented execution, remeasurement
- Access / permissions (delegated access only; no shared passwords)
- Confidentiality · use of public and client-provided data
- Termination · renewal (no auto-renew unless written) · IP / work product · limitation of liability
- Testimonial / case-study permission as a separate, optional clause (default: none)

## 1. Day 0 — record the signing (engagement page: "Record signed engagement")
Prospect id, start date, term, fee, total, scope. This: moves the prospect to
`contracted`, promotes it (spec 057) if needed, **reserves** the market,
carries the pre-sale rival into the project, plans the day-45 and end−10
remeasurements. Nothing is sent or charged.

## 2. Commercial gate (MANUAL ledger, deterministic gate)
- Record contract `signed` with a reference (file location / e-signature id).
- Issue the first invoice outside the platform; record `invoice_created` (amount, due date, invoice id).
- When the payment lands, record `payment_received` with the same invoice id.
- "Start onboarding" then passes. An admin may override the payment condition with a written reason (audited); never the contract.

## 3. Onboarding (derived checklist — complete only when every line holds)
1. Agreement state known · 2. Payment state known · 3. Identity verified (subject company + primary contact)
4. **Market definition confirmed** — write the boundary yourself (city vs metro vs county, which neighborhoods). Then "Activate exclusivity" (refuses on overlap with another live client).
5. Exclusivity check passes · 6. Top priorities captured (context items with provenance `client_priority`)
7. Key assets inventoried · 8. Required access resolved (no `requested` left open; delegated invites only)
9. **Baseline frozen** from the pre-sale benchmark run (corrected evidence, OpenAI) · 10. First plan ready (≥1 evidence-backed work item)
Then "Mark active".

Onboarding call agenda (collect only what changes the work): top neighborhoods to win; property types; buyer vs seller priority; luxury/general/niche; markets they do NOT care about; competitors they care about and don't; correct business/team/lead-agent naming; owned pages; Zillow/Realtor/Homes/brokerage/GBP profiles; access we actually need.

## 4. Work (Tasks + Engagement page)
Every item: observation → hypothesis → confidence (high/medium/experimental) → control (we/client/third party) → scope (in/out/founder review) → client approval required? → target URL → before state. Public copy, profile edits, business claims, new pages: approval required. Record the client's decision from the channel they used (email/call/meeting) — the trail is append-only. Blocked items name who they wait on and are not "late".
On completion, fill the after state. The change log is what the remeasurement is read against.

## 5. Monitoring and communication (defined cadence, not real time)
- Weekly: open the engagement page, review signals, send the composed weekly update (DONE / IN PROGRESS / NEED FROM YOU / MEASUREMENT / NEXT). If nothing material happened, it says so. Record "update sent".
- Weekly market benchmark runs already refresh the shared instrument; drift/accuracy findings surface on Today.
- Do not promise continuous monitoring.

## 6. Remeasurement (same instrument)
Start a run on the **same frozen question set and provider** (the shared Grand Rapids market project, OpenAI, 4 repetitions). When it finishes, "Record remeasurement" into the planned slot. The OS grades comparability and states observed movement without attribution. A changed instrument is recorded `non_comparable` — never a percentage.

## 7. Day 69+ — renewal review
Bring: baseline vs latest measurement, what changed (with before/after), what was learned, remaining opportunity, next proposed work. Mark `offered` / `declined`. Renewal opens a new signed term (its own contract + payment gate). Never auto-renew.

## 8. Offboarding (admin)
"Close / offboard": exclusivity released on the term end date, portal grants revoked, planned remeasurements cancelled, former client flagged do-not-contact through the cooldown (default 180 days). Deliver the final report and completed-work summary manually. Records stay historical.

## Failure modes → what the system does
| # | Scenario | Behaviour |
|---|---|---|
| 1 | First payment fails | Stays `signed`; onboarding refused; Today shows "commercial gate" |
| 2 | Onboarding never completes | Never `active`; checklist shows the open lines |
| 3 | Refuses website access | Access item `declined`; dependent tasks blocked `client_access`; not late |
| 4 | Says Eastown is irrelevant | Context item stays `publicly_observed`; the item is rejected, not worked |
| 5 | Rejects a proposed change | `client_approval=rejected`; start refused; decision trail kept |
| 6 | Third-party profile uneditable | Blocked `third_party`; visible on the page and Today |
| 7 | Developer takes 3 weeks | Blocked `third_party` with note; weekly update lists it |
| 8 | Remeasurement run partial/failed | Unfinished runs refused; partial runs graded `low` on answer ratio |
| 9/10 | Count falls / competitor rises | Reported as observed movement with deltas; no causal claim |
| 11 | No movement after 90 days | Comparison shows it; renewal review built on work delivered + learned |
| 12 | "Why renew?" | Renewal view: baseline vs latest, changes, learned, remaining opportunity |
| 13 | Cancels | Close: exclusivity released on end date, grants revoked, cooldown |
| 14 | New Grand Rapids prospect | Can exist; sends refused by the dispatch gate while protected |
| 15 | Someone sells another GR retainer | `signClient` refuses (one live engagement per market) unless admin override with reason |
| 16 | Page leaks another client | `assertProjectAccess` in every portal read; 404 on denial |
| 17 | Methodology changes mid-term | `non_comparable` with reasons; disclosed, never averaged |
