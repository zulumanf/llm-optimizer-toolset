# Spec 170 — Alert the owner on replies worth answering within the hour

> Status: implemented (2026-10-28), not committed
> Audience: operator (internal email to the prospect owner)

Priority #1 is the first client; speed to lead after "show me" matters most.
Replies land in the outreach mailbox, and nothing alerted the founder.

- `recordProspectReply` (every path: Gmail sync and manual) calls
  `alertOperatorOfReply` for **newly recorded** replies only.
- Classifications: positive_interest, question, proof_request, referral.
  Unsubscribe, not interested, decline and objection stay quiet.
- Recipient: the prospect owner's account email (positive replies assign an
  owner first), else the sender identity. Never a prospect.
- Content: classification, prospect, market, a 600-character excerpt, the
  prospect link. Sent through the Gmail connector; failure is logged and never
  affects recording the reply.

## Acceptance criteria
- [x] `buildReplyAlert` unit tests (alert / no alert / excerpt).
- [x] Full suite (3,344), lint, typecheck pass.
