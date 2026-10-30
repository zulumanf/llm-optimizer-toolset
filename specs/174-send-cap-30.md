# Spec 174 — Gmail daily send cap 25 → 30; SearxNG for contact research

> Status: implemented (2026-10-30), not committed
> Audience: operator (internal)

## Send cap

`GMAIL_DAILY_SEND_CAP` 25 → 30 (founder, 2026-10-30). Restart week: 59 Gmail
sends, 0 bounces, 0 complaints, ~63% opens. Needed to fit ≥ 100 Touch 1 plus
~30 follow-ups in one week. Next step to 35 only if bounces stay at zero.
The send gate's `daily_send_cap` check and the dashboards read the constant.

## Contact research search engine

`scripts/contact-discover.ts`: optional self-hosted SearxNG (JSON API, env
`SEARXNG_URL`) tried before Brave, which rate-limits after ~10 queries.
SearxNG answers are blocked only on its own 429/403 — its JSON lists upstream
engines that hit a CAPTCHA, which the HTML block detector misread. Contact
verification is unchanged (literal email on the official page, re-verified at
promotion; generic inboxes refused). No model is called.

## Acceptance criteria
- [x] Full suite, lint, typecheck pass.
