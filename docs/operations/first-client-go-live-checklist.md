# First real client — go-live checklist (spec 131)

Use this the morning a client says yes. Each step names the human action, what
you record in the OS, and the gate the OS enforces. Do the steps in order; the
OS refuses to skip a gate. The examples are placeholders — never pre-decide a
market boundary or a term from this page.

Where: **Projects → (client) → Engagement** once the project exists; before
that, the prospect page (prospect id is in the URL).

---

## WHEN CLIENT SAYS YES

### STEP 1 — Quote → engagement → agreement (spec 140; prospect page → "Commercial state")
"Prepare quote" (active policy) → send the price yourself → "Mark presented"
(terms freeze) → "Record signed engagement from quote" (terms come from the
quote; nothing retyped) → "Confirm market definition" (STEP 3, moved earlier
because the agreement names the boundary) → "Prepare agreement"
(`engagement_agreement_v1`, legal review NOT_REVIEWED — counsel follow-up, not a
gate) → send it through your channel → "Mark agreement sent" → signed copy back
→ "Record signed agreement" with the reference.
**OS gate: CONTRACT_SIGNED** (a signed state needs a reference). Pre-quote
engagements can still use "Record signed engagement" + "Record contract state".

### STEP 2 — Payment (human: issue and collect externally)
"Create invoice schedule" (3 × $2,500 as `ENG-<id>-1..3`, due day 0/30/60).
Issue invoice 1 outside the platform; when funds land, "Record installment
payment" (installment 1). The panel shows paid / remaining; the contract is
PARTIALLY_PAID until all three land.
**OS gate: ACTIVATION_PAYMENT** = installment 1 in full. "Start onboarding"
passes only with STEP 1 + STEP 2. Admin override of the payment condition
requires a written reason and is audited. The contract condition cannot be
overridden.

### STEP 3 — Market definition (founder decision)
"Confirm market definition": write the exact boundary in words — city limits vs
metro vs county, which neighborhoods are in, what is out. The OS never derives
this from the market name. Signing already ran the one-live-client-per-market
check; activation re-runs the territory conflict check.

### STEP 4 — Promote prospect to client (automatic at signing)
Signing promotes the prospect (spec 057): the company, contacts, benchmark link,
Touch 1, replies, corrections and the published report stay on the prospect; the
client project is created (or the prospect's benchmark project converted). The
pre-sale rival becomes a tracked competitor. Nothing is duplicated.
Check: prospect stage `contracted`, project listed under Clients.

### STEP 5 — Freeze the paid baseline
Engagement page → "Freeze baseline". Defaults: the prospect's linked benchmark
run, provider OpenAI, subject = client company, competitors = tracked rivals.
Before pressing: confirm the run is the corrected one (spec 130 aliases applied),
the counts match the private report, and the competitor set on the project is
the one the client will be measured against (signing carries in the Touch 1
rival; add others on the Competitors tab first — the package is frozen with
whatever competitors exist at that moment). The package is immutable once frozen;
a second freeze is refused.

### STEP 6 — Activate exclusivity
Requires STEP 1 + 2 (onboarding started) and STEP 3. "Activate exclusivity" runs
the conflict check against every other live agreement. Then review the
"Market exclusivity" section and press "Pause outreach to N prospect(s)" — this
unschedules queued cold drafts and pauses sequences for competing prospects in
the protected market. The send gate refuses them regardless from this point.

### STEP 7 — Onboarding intake (human: email or call; record in "Onboarding intake")
The intake dialog is prefilled from the prospect/company/contact records; ask
only for what is empty or wrong (required: legal name, brand, primary contact,
email, website, market boundary, one priority, who controls the website).
Ask only what the record does not already hold (see the "Ryan signed tomorrow"
preview for the pattern): priority neighborhoods · buyer vs seller priority ·
the 2–3 real comparison competitors · which pages/profiles their team can edit ·
who approves public changes · access we actually need (delegated invites only).

### STEP 8 — Resolve onboarding (record answers as context items)
Add context items with provenance: `publicly_observed` (from the benchmark),
`client_confirmed`, `client_priority`. Access items carry `requested → granted /
not_needed / declined`. Never paste credentials — delegated access or the
encrypted connector vault. Assets: main site, owned pages, GBP, Zillow,
Realtor.com, Homes.com, brokerage profile.

### STEP 9 — First implementation plan (2–5 items)
"New work item": title · observation · hypothesis · confidence
(high / medium / experimental) · control (we / client / third party) · target
URL · evidence (a baseline answer) · client approval required? Approve the plan
on the Tasks tab. Then "Mark active" — the OS refuses until every checklist line
holds (agreement, payment, identity, market definition, exclusivity, priorities,
assets, access, baseline, plan).

### STEP 10 — Approvals (only where required)
Public copy, profile edits, business claims, new pages → approval required.
Send the exact proposed change (before / after / where) to the approver from
STEP 7. "Record client decision" (approved / rejected / edit requested) with the
channel and their words. Start is refused until `approved`.

### STEP 11 — Execute and record every material change
Start → do the work → set the after state (exact change) → complete. The change
log is derived from this; "optimized profile" without before/after/URL/evidence
is not a change.

### STEP 12 — First client update (human: send)
Engagement page → "Weekly update (draft)": DONE / IN PROGRESS / NEED FROM YOU /
MEASUREMENT / NEXT, derived from the record. Send it yourself; "Record update
sent". Repeat weekly; the page flags when the cadence slips.

### STEP 13 — Remeasure (same instrument)
When a planned slot is due (Today shows it): start a run on the **same frozen
question set and provider** (the market benchmark project the baseline came
from; same repetitions). When finished, "Record remeasurement" into the slot.
The OS grades comparability and states observed movement. A changed instrument
is `non_comparable` — no percentage, ever.

### STEP 14 — 90-day review (founder decision)
Day 69: stage derives to renewal review. Bring: baseline vs latest comparable
measurement · work completed with before/after · what was learned · what can and
cannot be attributed · remaining opportunity · next proposed work. Record
`offered` / `declined`. Renew → new signed term with its own STEP 1–2 gates.
Not renewing → "Close / offboard" (admin): exclusivity released on the term end
date, portal grants revoked, planned measurements cancelled, former client
flagged do-not-contact through the cooldown (default 180 days). Deliver the final
summary manually. Records stay historical.

---

## What stays manual, on purpose
Contract execution · invoicing and payment confirmation · market boundary ·
exclusivity activation and sweep · client decisions · starting remeasurement
runs · sending updates · renewal and close.

## Where to look when something is off
Today (engagement cards) → Engagement page "Next action" → checklist detail →
`docs/operations/first-client-delivery-runbook.md` failure-mode table.
