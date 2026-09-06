# First-client activation pack — Ryan Ogle / Blu House Properties (DRY RUN)

> Status: prepared 2026-09-06 against canonical records. Nothing here has been
> executed. Ryan's prospect is at `audit_sent`; no engagement, agreement,
> invoice, payment, portal grant, work item or remeasurement exists for him.
> When he actually signs, follow `first-client-go-live-checklist.md` and use
> this pack for the Ryan-specific content.

Everything below serves one loop: MEASURE → DIAGNOSE → CHANGE → REMEASURE.

## What we already know (do not ask)

| Fact | Canonical source |
|---|---|
| Blu House Properties, team; lead agent Ryan John Ogle ("Ryan Ogle"); brokerage eXp Realty | prospect + RealTrends record (high-confidence match) + verified aliases (spec 130) |
| Ryan Ogle, Owner; email at thinkbluhouse.com | primary contact |
| 2025 production $81.1M / 204 sides (Josh May: $65.5M / 139 sides, RE/MAX of Grand Rapids) | RealTrends, licensed |
| Market: Grand Rapids (city node under MI), luxury segment, residential brokerage; 15 neighborhood nodes in the tree | market tree + launch |
| Baseline: OpenAI gpt-5.4-mini with search, 64 questions × 4 = 256 valid answers, captured 2026-08-31; Blu House 29/256 (20 distinct questions); Josh May 38/256 (21) | run 68ed325d, corrected evidence (spec 130). Historical Touch 1 said 11/256; kept historical with its correction |
| "Ryan Ogle" named in 45 of 256 answers, "Blu House Properties" in 23; the two are surfaced separately | private report, change-first rows |
| Sources the answers lean on: zillow.com (488 citations), realtor.com (396), homes.com (84). Every one of the 29 answers recommending Blu House cited Zillow; 12 cited Realtor.com; 2 Homes.com | response_citations on the run |
| thinkbluhouse.com is cited in 0 of 256 answers | report `ownSiteCited=false` |
| What the answers quote about Ryan: Zillow sales counts and ratings ("23 Ridgemoor sales", "most Fuller Avenue sales", "5.0 rating") | mention excerpts |
| Gap concentration: neighborhood questions (23 vs 33 of 59), seller questions (22 vs 31 of 46), townhomes (7 vs 10 of 15). Josh leads in Eastown (8 vs 5), John Ball Park (7 vs 0); tied in Ridgemoor (7 vs 7); Blu leads Fuller Avenue (6 vs 5) | per-question snapshot |
| Ryan replied positively and asked for pricing; he wants "easy and tangible" | reply ledger 2026-09-05 |

---

## PART 1 — Minimum onboarding questions

Audit of the five preview questions:

| # | Preview question | Verdict | Why |
|---|---|---|---|
| 1 | Which neighborhoods matter most this year? | KEEP | Decides work item 3 entirely; the tree has 15 nodes and none is confirmed. |
| 2 | Sellers, buyers or both? | MERGE into 1 | Seller questions are where the gap sits; the answer changes which track-record evidence we emphasize, not what we inspect. One sentence appended to question 1. |
| 3 | Which 2–3 teams are the real comparison? | KEEP as confirm-with-default | The baseline competitor set must be right before it is frozen; default is Josh May. "No one else" is a valid answer. |
| 4 | Which assets can your team edit? | KEEP, reframed as the access question | Needed to start Week 2 work; we cannot learn this from public pages. |
| 5 | Who approves public changes? | DELETE | Default is Ryan (Owner). State the default; he can delegate by replying. |

Final set: **three questions.**

1. For the next 90 days, which two or three neighborhoods matter most to you, and is that mostly sellers, buyers, or both? (The answers we captured mention Eastown, John Ball Park and Ridgemoor most; tell me if those are the right ones.)
2. We measure you against Josh May because he is the team the answers recommend most. Is there anyone else you consider the real comparison, or is that right?
3. Who on your team can edit thinkbluhouse.com and your Zillow, Realtor.com and Homes.com profiles? If you can add me as an editor on the website, do; for the profiles I will send exact field-by-field changes for your team to apply.

Default stated, not asked: approvals go to Ryan by email unless he names someone else.

### Onboarding email (unsent)

Subject: Blu House Properties, next 90 days

Ryan,

Thank you. We are on for 90 days, starting Monday. The agreement is signed and the first payment is in, so I have started.

Here is what happens next, in plain terms.

What I am doing this week, without needing anything from you: I am locking your starting point (29 of 256 answers recommend you, across 20 of the 64 questions; Josh May is at 38). Then I am going page by page through the places those answers actually pull from: your Zillow, Realtor.com and Homes.com pages, and thinkbluhouse.com. The answers name "Ryan Ogle" and "Blu House Properties" as two different things, and your own site is never one of their sources. By Friday you will have a short list of exactly what I found and what I want to change first.

Three things I do need from you. A reply to this email is enough:

1. For the next 90 days, which two or three neighborhoods matter most to you, and is that mostly sellers, buyers, or both? The answers we captured mention Eastown, John Ball Park and Ridgemoor most. Tell me if those are the right ones.
2. I measure you against Josh May because he is the team the answers recommend most. Is there anyone else you consider the real comparison, or is that right?
3. Who on your team can edit thinkbluhouse.com and your Zillow, Realtor.com and Homes.com profiles? If you can add me as an editor on the website, please do. For the profiles I will send exact field-by-field changes for your team to apply, since those accounts should stay yours.

Two ground rules so there are no surprises. Anything public, such as wording on a profile or a page, I will send to you first with the current version, the proposed version and why. You approve, ask for a change, or say no. I never need your passwords; editor invites or your team applying the change is how this works.

You will get a short update from me every week: what changed, what is in progress, what I need from you, and what the measurement says. The same 64 questions get re-asked mid-term and again before the end, counted the same way, so the before and after are comparable. I will tell you what moved and what I can and cannot attribute to the work.

If you would rather talk than type, I am happy to do a 20-minute call this week. Otherwise the three answers above are all I need to get going.

Francisco

### Kickoff call

**Not required.** Every input that changes the plan is one of the three questions above, and Ryan already read the evidence in the private report. Offer an optional 20-minute call in the email for his preference, not ours. If taken, the agenda is the three questions plus the approval flow, nothing else.

---

## PART 2 — Day 0 internal activation (signed + first payment confirmed)

Canonical sequence is `first-client-go-live-checklist.md`. This table adds Ryan's specifics and the pass/fail conditions.

| # | Step | Human action | System action | Pass | Fail |
|---|---|---|---|---|---|
| 1 | Commercial state | Confirm signed agreement (entity Blu House Properties / eXp Realty as named in the paper), $7,500/mo, 90 days, $22,500, payment terms; record signed + contract reference; record invoice and payment with the same invoice id | Engagement row; `client_engagements.contract_status=signed`; `billing_events` rows | Engagement page shows contract signed with reference and payments received $7,500 | Any of: no reference, no payment row → stay `signed`, do not start onboarding |
| 2 | Market boundary | Decide per PART 3 and write it in words | `confirmMarketDefinition` stamps actor + time | Definition text present on the engagement | Not written → exclusivity refuses to activate |
| 3 | Conflict check | Read the "Market exclusivity" section | Signing already refused if another live client held the market; activation re-runs `detectConflicts` | No other live agreement overlaps Grand Rapids | Overlap → stop; founder decides (override requires written reason) |
| 4 | Promote prospect | Press "Record signed engagement" with prospect id `ba4860d6…`, start date, terms, scope from PART 13 | Stage → contracted; project created (spec 057); Josh May carried in as competitor; midpoint/final slots planned | Prospect shows `contracted` and `promoted_project_id`; Competitors tab lists Josh May | Prospect not linked to company → refused (it is linked) |
| 5 | Freeze baseline | Confirm run 68ed325d, provider OpenAI, aliases Ryan John Ogle / Ryan Ogle present; add any extra competitor Ryan named (question 2) BEFORE pressing | `freezeBaseline` writes the immutable package | Package shows 29/256, 20 distinct, Josh May 38/256, 256 raw answers referenced | Counts differ from the report → stop and investigate before freezing |
| 6 | Start onboarding + activate exclusivity | "Start onboarding" then "Activate exclusivity" | Gate: signed + payment; agreement reserved → active | Exclusivity badge `active` | Gate reasons listed on the page → resolve step 1 or 2 |
| 7 | Pause conflicting outreach | Review the listed Grand Rapids prospects (today: 19 non-Ryan, 1 contacted, 0 scheduled drafts, 0 active sequences), press "Pause outreach" | Drafts unscheduled, sequences paused, conflict_status blocked; the send gate refuses them regardless | Section shows 0 scheduled / 0 active afterward | Any send to a GR prospect after activation is a defect; report it |
| 8 | Onboarding checklist | None yet | Derived from the record (10 lines) | Lines 1–5 and 9 done after steps 1–6 | — |
| 9 | Work candidates | Create the three items in PART 4 with evidence from the frozen package; item 1 approval required; item 3 blocked `client_input` | Tasks with provenance | Three items visible on the Engagement page, item 3 not overdue | Item without evidence → refused by the task system |
| 10 | Onboarding email | Send the PART 1 email from Gmail; press "Record update sent" (channel email) | Audit row for the cadence signal | Last client update = today | Not recorded → Today shows "First client update not yet sent" |
| 11 | Next-action owner | Set the engagement owner and task owner to Francisco (only operator) | Owner fields | Engagement page shows next action "Finish onboarding: …" | — |
| 12 | Measurement calendar | Read PART 8; decide whether to run the final earlier than the planned slot date | Planned slots already exist (day 45, end−10); record runs into them when done | Slots visible under Measurement | — |

Time on Day 0: about 90 minutes of founder work.

---

## PART 3 — Market definition decision (founder confirms; nothing is pre-decided)

Canonical tree today: `MI` (region) → `Grand Rapids` (city) → 15 neighborhoods (Belknap Lookout, Creston, East Hills, Eastgate, Eastown, Fuller Avenue, Garfield Park, John Ball Park, Michigan Oaks, Ridgemoor, Roosevelt Park, South East End, Southeast Community, Southwest Community, West Side). There is no metro, Kent County or West Michigan node, and no suburb nodes (East Grand Rapids, Ada, Grandville, Wyoming, Kentwood are not in the tree).

| Option | Scope in the OS | Exclusivity effect | Prospecting effect | Benchmark fit | Client expectation |
|---|---|---|---|---|---|
| A. Grand Rapids city node (the launch's current scope: residential brokerage, luxury) | The city node; every neighborhood node is inside it, so all 15 conflict automatically | Blocks any other retained client at city or neighborhood level, luxury residential | Pauses the 19 other Grand Rapids prospects for the term | Exact: the 64 questions are Grand Rapids + these neighborhoods | Ryan may assume suburbs are covered; they are not nodes, so nothing is promised or protected there. Must be stated in writing. |
| B. MI region node | The whole state | Blocks every Michigan market we could ever sell | Pauses every Michigan launch | Far wider than the instrument | Over-promises; not recommended |
| C. City node plus explicitly added suburb nodes (only if Ryan's production and the agreement name them) | Requires adding market nodes by hand first | Protects the named suburbs too | Pauses prospects in those nodes (none exist today) | Questions would not cover the suburbs; a separate question set would be a new instrument | Matches an agreement that names suburbs |

Founder must write the definition in words, for example the shape (not the decision): "City of Grand Rapids and its neighborhoods as listed in the market tree; residential brokerage, luxury segment; suburbs and the wider West Michigan region are excluded unless added by written amendment." If the paper agreement names East Grand Rapids or other suburbs, choose C and add the nodes before activation.

---

## PART 4 — First week value

By Friday of Week 1 Ryan sees, in one email and on the portal:
- **What we verified**: the frozen starting point (29/256, 20 questions; Josh 38/256) and a page-by-page audit of the four places the answers draw from, with the exact current wording of the person/team relationship on each.
- **What we prepared to change**: the one-line identity relationship, sent for approval with current and proposed text.
- **What is waiting on him**: the three answers, the editor invite, one approval.
- **What comes next**: profile changes in Week 2, owned-site changes in Week 3, first re-check in early October.

Can begin immediately (no client dependency): the public audit of Zillow, Realtor.com, Homes.com, eXp profile and thinkbluhouse.com; the baseline freeze; the approval request for the identity line. Cannot begin: any profile edit (client-owned accounts), any owned-site edit (access), neighborhood work (question 1).

### Work item 1 — Identity consistency (PREVIEW ONLY)

| Field | Value |
|---|---|
| Title | Ryan Ogle and Blu House Properties presented as one identity |
| Observation | In the 256 captured answers "Ryan Ogle" is named in 45 and "Blu House Properties" in 23, usually separately; the split changed our own first count (11 → 29 once the lead agent was credited). thinkbluhouse.com is cited by none of the answers. |
| Hypothesis | If every page the answers draw from states the same person ↔ team relationship, the team's track record is more likely to be represented under one name and counted for the team. Not a promise. |
| Confidence | high_confidence |
| Control | we_control for thinkbluhouse.com once an editor invite exists; client_controls for zillow.com, realtor.com, homes.com, eXp profile |
| Targets (verified) | zillow.com (cited in all 29 Blu-recommending answers), realtor.com (12), homes.com (2), thinkbluhouse.com (0; contact domain, named in the report) |
| Action | Inspect each page and record the exact current relationship wording; propose one line used everywhere both names appear: "Ryan Ogle, Owner, Blu House Properties (eXp Realty)". Role and brokerage are the verified values; nothing else is added. |
| Approval | Required (public copy). |
| Before | Known: answers credit "Ryan Ogle" with Zillow sales counts and a 5.0 rating as an individual; team named separately; site never cited. Page-level wording: recorded during the Week 1 audit. |
| After | Pending. |
| Measurement | Same 64 questions, OpenAI with search, 4 repetitions; compare 29/256 and 20 distinct questions; additionally count answers naming both forms. |

### Work item 2 — Third-party profiles (PREVIEW ONLY)

| Platform | What we KNOW from evidence | What must be INSPECTED (public first, then with Ryan's team) | Profile-level action candidates |
|---|---|---|---|
| Zillow | Cited in 488 answer citations and in 29 of 29 Blu-recommending answers; answers quote per-neighborhood sales counts ("23 Ridgemoor sales") and a 5.0 rating attributed to Ryan Ogle | Whether a team profile exists and links the agent profile; name form on each; brokerage field; service areas listed; whether past sales are fully attributed to Ryan/team; bio wording | Align name form and team ↔ agent link; add priority neighborhoods to service areas only if true; complete past-sales attribution; bio carries the identity line |
| Realtor.com | Cited in 396 citations; 12 of 29 Blu-recommending answers | Agent vs team profile; brokerage; service areas; bio; whether reviews/transactions are current | Same alignment; specific fields decided after inspection |
| Homes.com | 84 citations; 2 of 29 | Whether the profile is claimed at all; name/brokerage/team fields | Claim if unclaimed; align fields |
| eXp Realty brokerage page | Brokerage named in RealTrends; not evidenced as a cited source | Public agent page wording | Align identity line if editable by Ryan |

Not "optimize profiles": each change is a named field on a named page with a before and after recorded.

### Work item 3 — Neighborhood evidence (BLOCKED_CLIENT_INPUT)

Stays blocked until question 1 is answered. Evidence: Josh leads John Ball Park 7–0 and Eastown 8–5; Ridgemoor tied 7–7 (Blu's strongest single question is Ridgemoor townhomes, 3 of 4).

- If Ryan confirms Eastown / John Ball Park / Ridgemoor: check publicly whether Blu House has recent, attributable sales in each (Zillow past sales, MLS-backed pages). Where true, make the record visible and consistent (past-sales attribution, service areas, one owned-site page per confirmed neighborhood carrying only verifiable, provenance-tagged facts). Where Blu House has no sales in a neighborhood (John Ball Park may be such a case), say so and do not manufacture claims.
- If Ryan says they do not matter: decline the item (the task system now supports declining an approved item) and pick the neighborhoods he names instead.

---

## PART 5 — Asset / access plan

| Asset | Why needed | Access needed? | Preferred method | Client action | Work can begin without it? |
|---|---|---|---|---|---|
| thinkbluhouse.com | Never cited by the answers; carries the identity line and any neighborhood evidence pages | Yes, to edit | Editor invite to the CMS (platform identified during the public audit) or their web person applies our copy | Add editor, or name the web contact | Audit yes; edits no |
| Zillow agent/team profile | Dominant source in every Blu-recommending answer | No delegated access | Ryan's team applies exact field changes we send | Apply changes, confirm by reply | Audit yes; edits no |
| Realtor.com profile | Second source | No delegated access | Same | Same | Audit yes; edits no |
| Homes.com profile | Third source | No | Same (claim first if unclaimed) | Same | Audit yes |
| eXp Realty agent page | Brokerage identity consistency | No | Ryan edits within eXp tools | Apply | Audit yes |
| Google Business Profile | Not evidenced as a source in the 256 answers | Not requested | — | — | Not in first 30 days |
| Analytics / Search Console | Not needed for the measurement; the instrument is the 64 questions | Not requested | — | — | Not in first 30 days |

Never request passwords over email. If Ryan sends one anyway, do not store it; reply asking for an editor invite instead.

---

## PART 6 — First 30 days

| Wk | # | What | Why | Evidence | Owner | Client dependency | Approval | Done when | Measurement link |
|---|---|---|---|---|---|---|---|---|---|
| 1 | T1 | Public audit of Zillow, Realtor.com, Homes.com, eXp page, thinkbluhouse.com: record current identity wording, team link, brokerage, service areas, past-sales attribution | Answers draw only from these pages | Citation counts; 45 vs 23 naming split | Francisco | None | None | Before-state recorded on items 1 and 2 | Baseline package |
| 1 | T2 | Freeze baseline, activate exclusivity, pause GR outreach, send onboarding email | Day 0 | — | Francisco | None | None | Checklist lines 1–6, 9 done | — |
| 1 | T3 | Identity line approval request | Item 1 | Naming split | Francisco → Ryan | Ryan approves | Required | Decision recorded | Item 1 |
| 2 | T4 | Apply profile changes on Zillow, Realtor.com, Homes.com from T1 findings | Item 2 | Source dominance | Ryan's team (exact instructions from us) | Yes | Required for bio wording | After-state verified publicly and recorded | Item 2 |
| 2 | T5 | Owned-site identity change (about/team page) | Item 1 | Site never cited | Francisco (editor) or their web person | Editor invite or web contact | Approved in T3 | Live page checked; after-state recorded | Item 1 |
| 3 | T6 | Neighborhood evidence for the confirmed neighborhoods: attribution completeness and one factual page per confirmed neighborhood (client-provided facts tagged CLIENT_PROVIDED, sales facts tied to public records) | Item 3 | Neighborhood gap 23 vs 33 | Francisco + Ryan's team | Question 1 answered; facts supplied | Required (new public pages) | Pages live, claims provenance-tagged | Item 3 |
| 4 | T7 | Verification pass: re-check every changed page publicly; complete change log with before/after; send Month 1 review | Trust | — | Francisco | None | None | Change log complete; review sent | All |
| 4 | T8 | Measurement readiness: confirm instrument (prompt set version 6062f819, OpenAI gpt-5.4-mini with search × 4, market project 71332b5c), schedule the early check | Comparability | — | Francisco | None | None | Run planned in the OS | Early check |

Eight tasks. Dependencies, not the calendar, control order: if the editor invite arrives Day 2, T5 moves into Week 1.

---

## PART 7 — What not to do in the first 30 days

- Do not redesign thinkbluhouse.com; change the identity line and add factual neighborhood pages only.
- Do not publish generic "best agent in Grand Rapids" pages; the answers cite Zillow-style records, not marketing copy.
- Do not chase realtor.ca, redfin, agentpronto or reddit because they appear in citations; they do not appear in the answers that recommend Blu House.
- Do not add neighborhoods to service areas or pages where Blu House has no attributable sales (John Ball Park is 0 in the baseline for a reason we have not verified).
- Do not rewrite profile bios or claims without Ryan's recorded approval.
- Do not touch the 64-question set, provider, repetitions or classification during the term; a changed instrument is non-comparable.
- Do not claim causality; report observed movement.
- Do not rerun the benchmark weekly looking for a good week; two remeasurements plus one early check.
- Do not request or store passwords.
- Do not expand into SEO, ads, social or CRM work because it is adjacent.

---

## PART 8 — Measurement calendar

Preview schedule (canonical rules: midpoint day 45, final end−10, renewal review end−21): baseline capture 2026-08-31, midpoint 2026-10-22, final 2026-11-26, renewal review 2026-11-15, term end 2026-12-06.

Problem: the final remeasurement lands eleven days AFTER the renewal review date, so the renewal conversation would rest on the midpoint only.

Recommended for Ryan (record runs into the existing planned slots; rule change is a separate decision):

| Beat | Date | Why |
|---|---|---|
| BASELINE | captured 2026-08-31, frozen Day 0 | Corrected 29/256 over the pre-sale run |
| EARLY CHECK | ~2026-10-07 (day 30) | Diagnostic only, after Week 2–3 changes: confirms the instrument still runs cleanly and shows early movement without being reported as progress. Fills the "midpoint" slot. |
| MIDPOINT | folded into the early check | Avoids three runs in six weeks |
| FINAL FORMAL REMEASUREMENT | ~2026-11-12 (day 66) | Nine weeks after implementation began; results in hand before the review |
| RENEWAL REVIEW | 2026-11-17 to 11-20 | Rests on the final measurement, the change log and what remains |
| TERM END | 2026-12-06 | A post-term measurement belongs to a renewed term |

Follow-up (P2, not now): set the final slot to end−24 and the review to end−19 in the canonical rules so this ordering holds by default.

---

## PART 9 — What counts as progress

DELIVERY PROGRESS (change log): identity line approved and live on N of 5 target pages; profile fields aligned on Zillow / Realtor.com / Homes.com; neighborhood pages live for the confirmed neighborhoods; approvals resolved; blockers cleared.

MEASUREMENT PROGRESS (same instrument only): recommendations 29 → X of 256; distinct questions 20 → X of 64; Josh May 38 → X; questions gained and lost by name; category movement (neighborhood 23 → X of 59; seller 22 → X of 46; townhome 7 → X of 15).

SOURCE / REPRESENTATION CHANGES: share of Blu-recommending answers citing thinkbluhouse.com (0 → X); answers naming both "Ryan Ogle" and "Blu House Properties" together (X → Y); Zillow remains the dominant source or not.

Never a composite score, never a percentage without both numerators and denominators shown.

---

## PART 10 — Week 1 client update (example, hypothetical state)

Weekly update — Blu House Properties — week ending 2026-09-11

Here is where the work stands this week.

DONE — what changed this week
- Locked your starting point: 29 of 256 answers recommend Blu House, across 20 of the 64 questions. Josh May: 38 of 256. Counted the same way every time from here on.
- Audited the five pages the answers actually use (Zillow, Realtor.com, Homes.com, eXp, thinkbluhouse.com) and recorded the exact current wording on each. Finding: three of the five describe you and the team differently; your own site is not one of the answers' sources.

IN PROGRESS — what we are working on
- Field-by-field change list for Zillow, Realtor.com and Homes.com, ready for your team once the identity line is approved.
- Eastown and Ridgemoor evidence, now that you confirmed those two. John Ball Park is parked: the answers never credit Blu House there and I want to verify the sales record before proposing anything.

NEED FROM YOU
- Approve, change, or decline the identity line I sent Tuesday (current vs proposed wording, one line, three pages).
- Editor access to thinkbluhouse.com, or the name of your web person.

MEASUREMENT
- No new measurement this week. The baseline stands; the first re-check is planned for the week of 2026-10-06 and I will not read anything into it before then.

NEXT
- Your team applies the profile changes (I send exact fields).
- Owned-site identity change as soon as I have access.

---

## PART 11 — Month 1 review (structure)

Portal summary plus a one-page email; no deck.

1. What we learned (the audit findings, in plain words, with the before-states)
2. What we changed (change log: page, before, after, date, approval)
3. What remains (open items and why: access, approval, facts)
4. What we are testing (the hypotheses, stated as hypotheses)
5. What we need from Ryan (only real blockers)
6. When we measure next (early check date; what it can and cannot tell us)

---

## PART 12 — Client approval experience (preview; not written to Ryan's record)

**Change requested: how you and the team are described**

CURRENT: Zillow agent page names "Ryan Ogle" with no team; thinkbluhouse.com about page names the team without the owner line. (Exact current text recorded in the Week 1 audit.)

PROPOSED: One line wherever both appear: "Ryan Ogle, Owner, Blu House Properties (eXp Realty)."

WHERE: thinkbluhouse.com about/team page; Zillow, Realtor.com and Homes.com agent and team profile bios.

WHY: In the 256 answers we captured, "Ryan Ogle" appears in 45 and "Blu House Properties" in 23, mostly as separate things. One consistent line gives the answers one identity to credit.

EVIDENCE: 20 baseline answers linked on the task; the naming counts above.

APPROVE · REQUEST CHANGE · REJECT (reply with one word and any edits; I record your decision and the wording you approved)

---

## PART 13 — Scope boundary ($7,500/month)

IN SCOPE
- Measurement on the frozen 64-question instrument: baseline, early check, final remeasurement, comparability verdicts
- Evidence-backed diagnosis of where and why the answers under-represent Blu House
- Identity and profile consistency changes on the pages the answers draw from (owned site, Zillow, Realtor.com, Homes.com, brokerage page), implemented by us where we have access and coordinated with Ryan's team where we do not
- Factual owned-site evidence pages for confirmed neighborhoods (a small number; facts, not marketing)
- Monitoring on the stated cadence; weekly update; Month 1 and 90-day reviews

OUT OF SCOPE unless separately agreed
- Website redesign or migration; general SEO retainer; social media; paid advertising; CRM implementation; PR; custom development beyond page copy and a few factual pages; photography; listing marketing; work in markets outside the confirmed boundary

Scope is stated on the engagement record; anything else is a founder-review item, not a silent yes.

---

## PART 14 — What we control and what we do not (client-facing)

We control: the analysis; the exact wording and facts we propose; changes to pages you give us access to; how carefully the work is recorded; the measurement, counted the same way each time.

We do not control: which agents OpenAI's model chooses to recommend; how quickly Zillow, Realtor.com or Homes.com publish a change or re-crawl a page; model or search updates during the term; the outcome. What we promise is a rigorous starting point, changes with evidence behind them, a record of everything done, and an honest before and after.

---

## PART 15 — 90-day review (structure; no future results)

1. STARTING POINT: 29 / 256, 20 of 64 questions; Josh May 38 / 256; captured 2026-08-31 (OpenAI with search, 4 repetitions)
2. WHAT WE LEARNED: audit findings, source dependence (Zillow), naming split, neighborhood distribution
3. WHAT WE CHANGED: the change log, page by page, with dates and approvals
4. WHAT HAPPENED: final measurement X / 256 on the same instrument; distinct questions X; Josh May X; questions gained and lost; category movement; source and naming changes
5. COMPARABILITY / METHODOLOGY: grade and reasons; anything that changed and how it was handled
6. WHAT WE CAN ATTRIBUTE: only changes in representation that we made and can point to (a page now cited, one identity now named)
7. WHAT WE CANNOT ATTRIBUTE: movement in recommendation counts; competitor movement; model behaviour
8. WHAT REMAINS: open items, declined items, dependencies never resolved
9. RECOMMENDED NEXT 90 DAYS: the two or three highest-confidence items from what remains
10. RENEW / COMPLETE: Ryan's decision; if complete, the offboarding steps and dates

---

## PART 16 — Time to first value

| Milestone | Earliest | Controlled by |
|---|---|---|
| First client-facing value (starting point locked; audit findings shared) | Day 0 email; findings by Day 5 | Us |
| First implemented change | Owned-site identity line: Day 3–5 if the editor invite arrives by Day 2, otherwise Week 2. Profile fields: Week 2, after approval and Ryan's team applies them | Ryan (access, approval, applying) |
| First weekly update | Day 5–7 | Us |
| First useful remeasurement | Early check ~day 30 (diagnostic); first result we would put weight on: final ~day 66. Re-crawl and model refresh timing is unknown; we do not promise propagation dates | Third parties and the model |

---

## PART 17 — Founder daily view

Today: engagement cards (commercial gate, onboarding incomplete, approvals awaited, client input needed, measurement due, renewal due, invoice overdue, and now weekly update due and approved work ready to start). This week: the Engagement page "Next action" and the Work section. Waiting on Ryan: "Needs the client" section and the waiting-on-client signal. Done: "What changed". Measurement: next planned slot. Communication: last client update stat and the cadence signal. No redesign needed.
