# Spec 172 — Replies from colleagues inside our threads are recorded

> Status: implemented (2026-10-30), not committed
> Audience: operator (internal); affects reply tracking, alerts and follow-up stops

## Why

2026-10-29/30: Matt McLaughlin (Indianapolis) forwarded our Touch 1 to his
colleague Kate Rossman, who replied twice in our thread ("can you tell me more
about this process?", then "What is the timeline and cost for a project like
this?"). `syncProspectReplies` only searched `from:<exact recipient>`, so
neither reply was recorded: no alert, no stage change, follow-ups would not
have stopped.

## Change

- Keep the exact-recipient search.
- Add a search by the recipients' **business domains** (free-mail domains
  never searched). A message from it counts **only if its Gmail thread is one
  of our sent threads** (`prospect_outreach_sends.gmail_thread_id`); it is then
  recorded as that prospect's reply. Our own address is ignored. Same-domain
  mail outside our threads is never attributed.
- Dedupe by Gmail message id is unchanged, so re-runs record nothing twice.

## Acceptance criteria

- [x] Integration: an in-thread colleague reply is recorded; a same-domain
      message in another thread is not; a re-run records nothing new.
- [x] Unit: `companyDomains` dedupes and skips free-mail domains.
- [x] Full suite (3,362), lint, typecheck pass.

## Spec 173 addendum (2026-10-30) — the operator's side of the conversation

The founder answered Kate twice from his iPhone; the OS recorded only what the
system sent, so positive replies looked unanswered and the prospect timeline
showed half the thread.

- The sync also searches our Sent mail to the same recipients/domains. A
  message from our address **inside one of our threads** that is not a
  ledgered system send (`provider_message_id`) is logged once as activity
  `operator_replied` (Gmail id, thread, recipient, subject, 600-char excerpt,
  real sent time).
- `positiveRepliesWaiting.answeredAt` = the later of a system send or an
  `operator_replied` activity after the reply.
- Integration test: the manual reply is logged once; the tracked system send
  is never logged as a manual reply.
