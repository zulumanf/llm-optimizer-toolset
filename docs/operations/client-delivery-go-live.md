# Client delivery go-live (spec 154)

The operator procedure for taking a signed client from welcome to Day 90 on the delivery page (`/projects/<id>/delivery`). It supersedes the baseline steps in `first-client-delivery-runbook.md`: freezing now happens only on the delivery page, under an accepted protocol.

## What is automated, what is manual

| Step | Where | Status |
|---|---|---|
| Contract, payment and commercial gate | Engagement page | READY (existing). Signing and invoicing stay outside the app. |
| Portal login | Settings → client access (admin) | MANUAL. Needs `AUTH_MODE=supabase`. |
| Welcome message | Delivery §1 → "Prepare welcome" | VERIFIED WITH LIMITATIONS. Drafted; you send it from your mailbox, then mark it sent. |
| Business details (prefilled) | Delivery §2 → intake dialog | READY. The client confirms on a call; you record it. |
| Question import (CSV of the review sheet) | Delivery §3 | READY. |
| Client approval of the questions | Delivery §3 → "Record client decision" | MANUAL (operator-recorded). The trail is visible to the client. |
| Measurement protocol and acceptance | Delivery §4 | READY (operator-recorded acceptance; frozen in the database). |
| Baseline run | Runs page | MANUAL start. Needs the production worker. |
| Baseline lock | Delivery §5 | READY (gated). |
| 90-day plan | Delivery §6 | READY. Draft from the baseline or start blank; edit; publish. |
| Weekly update | Delivery §7 | VERIFIED WITH LIMITATIONS. Drafted from records; you send it, then mark it sent. |
| Check-ins | Delivery §8 | MANUAL scheduling. No calendar sync. |
| External tool (Ahrefs etc.) | Delivery §9 | MANUAL import. No API. |
| Final measurement and Day-90 review | Runs → Engagement "Record measurement" → Delivery §7 | VERIFIED WITH LIMITATIONS. |
| Fee decision | Outside the app | MANUAL by design. Spec 152 is unbuilt. |
| Evidence export and close | Engagement page | MANUAL export; close revokes portal access. |

## Before the first client

1. Review and merge this branch, after 148/150. Apply migration 140 (`npm run db:migrate` against production, by the founder).
2. Deploy. Confirm `/api/health` reports the deployed commit.
3. Start the production worker only after confirming that no outreach is queued for the client's market (audit P0-04).
4. Rehearse on synthetic data in a local sandbox:
   ```bash
   createdb -h localhost -p 5433 rf_onboarding_sandbox
   npx tsx scripts/migrate.ts up --db postgres://localhost:5433/rf_onboarding_sandbox
   DATABASE_URL=postgres://localhost:5433/rf_onboarding_sandbox ALLOW_MOCK_PROVIDER=1 AUTH_MODE=dev \
     npx tsx --tsconfig tsconfig.json scripts/client-delivery-rehearsal.ts
   ```
   The script refuses non-local databases. It creates two clearly SYNTHETIC clients: one pending, one mid-delivery.

## Medina, in order

1. **Engagement page:**
   - record the contract (signed, with the file reference);
   - record the $1,000 `payment_received`;
   - click "Start onboarding". It refuses without both.
2. Settings → invite Medina's primary contact (admin). Add further viewers only if Medina names them.
3. Delivery §1:
   - prepare the welcome and add the first check-in date;
   - copy the text, send it from your mailbox, then mark it sent.
4. Kickoff call, walking the prefilled intake (Delivery §2):
   - segments;
   - minimum value 300000;
   - neighborhoods in order;
   - surrounding communities Medina confirms (Rio Rancho, Corrales, Placitas, Los Ranchos, Sandia Heights: each confirmed or dropped);
   - name variants (e.g. "Elias Medina", "Medina Real Estate, Inc.");
   - approvers.
   Never take passwords; ask for editor invitations.
5. **Question sheet:**
   - Medina marks every row in the review sheet;
   - resolve every "Revise" and "Check service area" row with them;
   - File → Download → CSV (the questions tab);
   - Delivery §3: "Validate first", then "Import and freeze".
6. Send Medina the question list (the portal shows it under Approvals). Record the decision when they reply.
7. **Protocol (Delivery §4):**
   - provider `openai`, the exact pinned model id, and repetitions;
   - geographic context, plus whether a `user_location` is used. Decide this before the baseline: it is a methodology choice;
   - windows and name variants;
   - the success criteria, word for word from the agreement.
   Share it, then "Record acceptance" with their name and channel.
8. **Company record:**
   - add every agreed name variant as an alias **before** the run;
   - run the recall check from the Medina runbook.
9. **Runs:**
   - start the baseline on the frozen set, with capture reuse **off**;
   - wait for parsing;
   - clear the review queue;
   - consider a second run a few days later to measure noise.
10. Delivery §5: "Lock baseline". If it refuses, read the reasons — they are the checklist.
11. Delivery §6:
    - "Draft from baseline";
    - edit titles, owners and dates, and add items with their evidence;
    - "Fill phase due dates";
    - review it with Medina, then "Publish to client".
12. **Weekly:**
    - "Start as work item" for each plan item you begin;
    - set provenance and the exact wording. For public changes, mark client approval required;
    - record decisions as they arrive;
    - every week: "Prepare weekly update" → send → mark sent.
13. Every two weeks: schedule the check-in and record notes and action items afterwards.
14. **Optional, Ahrefs:**
    - import the export verbatim in §9;
    - QA it;
    - make it visible only if verified. Record whether it can tell a recommendation from a mention. Never describe it as an independent verification of the fee.
15. **Day 80–85:**
    - run the final measurement on the same set;
    - Engagement → record it into the final slot;
    - Delivery §7: "Prepare Day-90 review" → send → mark sent.
16. Decide the fee **with Medina** under the protocol, outside the app.
17. **Wrap-up (Delivery §10):**
    - export the evidence package and send it;
    - close open items;
    - Engagement → close (revokes the portal) or renew.

## Rollback

- **Code:** revert the branch merge. The portal falls back to its pre-154 views. Because the freeze gate goes with it, also revert to the manual baseline procedure.
- **Schema:** `npx tsx scripts/migrate.ts down` reverts migration 140. This drops the protocol, update, meeting, decision and external tables **and their data**. Before reverting in production, export those tables. Prefer a code-only rollback.
- **No feature flag.** The portal switches on whether an engagement exists. Projects without one see the old portal unchanged.

## Known limitations

- Client logins cannot be rehearsed under dev auth (only admin/operator). Client-role isolation is covered by integration tests.
- An unauthorised answer URL renders the not-found page with HTTP 200 (streaming under the portal loading state). No data is shown.
- Self-service client approval is not built. Decisions are recorded by the operator.
- Segment breakdowns exist only for snapshots frozen after this change.
- Uncertainty intervals ignore within-question correlation and are labelled as such.
- No PDF export, email sending or calendar sync.
