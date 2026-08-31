# Spec 124 — Competitive-Mismatch Reply Template

> Status: done
> Depends on: specs/032, specs/074, specs/090, specs/116, specs/122, docs/06, docs/13
> Branch: feat/124-competitive-mismatch-outreach

## Goal

A new primary cold-email template, `competitive_mismatch_reply_v1`, that leads
with one provable factual mismatch: a real same-market competitor produces
less than the prospect (RealTrends, same year, same metric, comparable entity
type), yet OpenAI's models recommend that competitor more often in our
benchmark. The system earns the claim deterministically; when any leg of the
comparison is not clean it fails closed and the existing
`reply-first-email-v1` template is used instead. The optimization target is
positive human replies per delivered email, so the spec also adds the first
reply-classification record (deterministic, operator-recorded) and template
attribution in analytics.

## Definitions

- **Candidate competitor**: another unarchived prospect in the same
  `market_launch` (same market by construction) with `prospect_type` other
  than `brokerage`, a resolved `company_id`, and a RealTrends verified
  production record (`prospect_authority_signals` metadata
  `record_type = 'realtrends_production'`).
- **OpenAI answer**: a `responses` row in the benchmark run with
  `provider = 'openai'`, `error is null`, non-holdout prompt. The denominator
  is the count of such answers — never prompts, runs, or mixed providers.
- **Recommendation count**: current-revision `mentions.recommended` rows on
  those answers, echo-excluded (`lib/scoring/prompt-echo.ts`), at most one
  per (answer, company) by the mentions unique key.
- One canonical calculation: `providerRecommendationCounts` in
  `lib/prospects/benchmark.ts`; the email renderer, QA gate, operator panel,
  and backfill script all consume it — nothing recomputes.

## Eligibility (all must hold; else fall back, with reason codes)

| Check | Reason code on failure |
|---|---|
| Prospect has RealTrends production with `production_year` | `PRODUCTION_DATA_UNVERIFIED` |
| ≥1 candidate with RealTrends production | `NO_VALID_COMPETITOR` |
| Same `production_year` both sides | `PRODUCTION_PERIOD_MISMATCH` |
| Same metric (closed volume; sides only if both lack volume) | `PRODUCTION_METRIC_MISMATCH` |
| Same entity type (`team` vs `team` / `individual` vs `individual`) | `ENTITY_LEVEL_MISMATCH` |
| Competitor production ≤ 90% of prospect's (configurable) | `NO_LOWER_PRODUCING_COMPETITOR` / `PRODUCTION_GAP_TOO_SMALL` |
| Competitor OpenAI recs ≥ prospect recs + 2 (configurable) | `NO_HIGHER_RECOMMENDATION_COMPETITOR` / `RECOMMENDATION_GAP_TOO_SMALL` |
| Run has OpenAI answers | `CHATGPT_DATA_UNAVAILABLE` |
| Benchmark completed ≤ 14 days ago (configurable) | `BENCHMARK_TOO_OLD` |
| Run completed/partial with a real scope | `BENCHMARK_SCOPE_INVALID` |
| Prospect + competitor `company_id` resolved | `ENTITY_RESOLUTION_UNCERTAIN` |
| A recipient first name exists (contact or team leader) | `NO_RECIPIENT_FIRST_NAME` |

Competitor priority among eligible candidates: larger recommendation gap →
stronger production inversion (lower ratio) → name tiebreak. Operator may
pick any *eligible* candidate (never an unvalidated one).

## Copy (deterministic; plain text; footer appended by `optOutFooter`)

Subject: `{firstName} — {marketShortName}` (market name before the first comma).

Body pattern — the ChatGPT naming follows the terminology rule (spec 090):
an API benchmark is never described as "asking ChatGPT"; the tested system is
named as the OpenAI model(s) behind ChatGPT:

```
{firstName} —

{recencyPhrase} I ran {scopeCopy} through the OpenAI model(s) behind ChatGPT.
{It/They} recommended {competitor} more often than your team, even though
RealTrends has you ahead on {closed volume|closed sides}.

Your team: {$X.XM closed} · recommended in {a} of {N} answers
{competitor}: {$Y.YM closed} · recommended in {b} of {N} answers

{implication line — seller-only vs mixed scope}

I have the exact questions and the side-by-side. Want me to send them?
```

Recency: same operator week → "Earlier this week"; previous week → "Last
week"; older (≤ max age) → "Recently". Scope copy from run audiences:
seller-only → "questions {market} sellers ask when choosing an agent";
buyer+seller → "{market} buyer and seller questions"; else "{market} real
estate questions". No links, no attachments, no calendar, no bold, no
jargon, no fabricated-loss language (PROHIBITED_PHRASES still gates).
The promised follow-up asset is the existing audit page (questions +
complete answers), sent on reply — not linked in touch 1.

## Database changes

Migration `094_competitive_mismatch_outreach.sql` (reversible):
- `outreach_drafts.evidence_snapshot jsonb` — the full mismatch context the
  body asserts, frozen at approval (trigger
  `forbid_approved_outreach_draft_mutation` replaced to include it).
- `prospect_replies` — insert-only ledger: prospect, contact, send, body
  text, received_at, classification (enum check), classifier_version,
  recorded_by. Update/delete forbidden by trigger.

## API (server actions / services)

- `createOutreachDraft` extension: optional `competitorCompanyId`; system
  path evaluates mismatch context in-transaction, renders the new template
  when eligible (persisting `prompt_version = competitive_mismatch_reply_v1`
  + `evidence_snapshot`), else falls back unchanged.
- `recordProspectReply(user, {prospectId, contactId?, sendId?, bodyText, receivedAt?, classification?})`
  — deterministic classification (`lib/prospects/reply-classify.ts`,
  override allowed), inserts ledger row, records `replied` stage for
  non-bounce/OOO classifications via the existing transition, writes an
  `opt_out` suppression on `unsubscribe`.
- `competitiveMismatchReview(prospectId)` — read model for the operator
  panel (context + all candidates + reason codes).

## Validation rules

- Draft QA (`qaDraftContent`) accepts the `{Name} —` greeting form and
  validates the greeted name identically to `Hi {Name},`.
- For drafts carrying an evidence snapshot, the count-consistency check
  validates the body's `N of M` denominators against the snapshot's OpenAI
  answer count (not the published audit sample).
- Mismatch drafts get claim revalidation at approval AND dispatch
  (`qaDraft`): live recompute must still produce the same competitor
  eligibility, counts, and denominator; benchmark age must still be within
  the hard max; body numbers must equal the snapshot. Any failure fails the
  draft (refusal, not warning).

## Analytics

- `SendFact.templateVersion` (draft `prompt_version` via the existing join);
  `byTemplate` send grouping in `lib/prospects/analytics.ts` + Analyze
  section.
- `ProspectBehaviorFacts.replies` (classification + receivedAt);
  `positiveReply` computed as positive-classified repliers / delivered once
  any classified reply exists (else stays not-recorded). Open rates remain
  directional-only.

## Edge cases

- Multiple contacts on one team: existing recontact-person + brokerage caps
  gate duplicates; the draft binds one contact; the evidence snapshot records
  the comparison so a future touch can see it was used.
- Competitor production newer than prospect's (different years) → period
  mismatch, ineligible; never compare across years.
- Volume present on one side, sides on the other → metric mismatch.
- Benchmark ages past 14 days between approval and scheduled dispatch → the
  dispatch-time QA rerun blocks the send.
- Already-contacted prospects: backfill only reports eligibility; it never
  drafts or sends.

## Acceptance criteria

- [x] Eligible fixture renders exactly the copy pattern; every ineligible
      fixture in the table above returns its reason code and falls back.
- [x] Denominator is provably OpenAI answers only (provider filter in the
      one canonical query; Perplexity/Google/Anthropic/mock excluded).
- [x] Draft QA rejects a mismatch draft whose body counts disagree with its
      snapshot, and any draft citing two denominators.
- [x] "yes" / "sure" / "send it" / "what did you find?" classify positive;
      "unsubscribe" suppresses; OOO does not mark replied.
- [x] Historical drafts/sends/mentions/snapshots untouched (append-only
      changes only).
- [x] Backfill script prints evaluated / eligible / reason-code counts.

## Test cases

`tests/unit/mismatch.test.ts` (eligibility matrix, selection priority,
scope/recency/format helpers, full render assertions, prohibited-content
guards), `tests/unit/reply-classify.test.ts` (phrase table),
`tests/unit/draft-qa.test.ts` extensions (greeting form, snapshot
denominator, conflict). Typecheck, lint, build.

## Definition of done

All acceptance criteria pass · tests green · lint/typecheck clean ·
migration applies and rolls back · DECISIONS.md updated (template identity
stored on drafts; peer-prospect production reuse; ChatGPT naming;
deterministic reply classifier).
