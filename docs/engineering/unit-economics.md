# Unit economics — spec 151 milestone C

## Measured (`lib/economics/service.ts`, `/operations`)

Every figure carries a source:
- `measured` — from RF's own ledgers;
- `ledger` — from the billing or labor ledger;
- `not_recorded` — no data. It is shown as missing, never as $0.

| Figure | Source |
|---|---|
| Measurement inference per project | `responses.cost_usd` (measured). Reused captures cost $0 to the reusing project |
| Internal LLM inference per project / unattributed | `llm_calls.cost_micro_usd` (measured) |
| Failed cells / total cells; failed jobs | `responses.error`, `jobs.status` (measured) |
| Delivery and sales hours by activity | `labor_entries` (migration 130). Insert-only; corrections are negative rows that name what they correct (ledger) |
| Revenue received | `billing_events.payment_received` (ledger) |
| Labor cost | Only when the operator supplies `?rate=` — echoed back as an assumption |
| Contribution margin | revenue − measured inference − costed delivery labor. **Not** gross margin after infrastructure, **not** EBITDA |
| Hosting, database, email, TTS, search/contact APIs | `not_recorded`: enter from invoices |

Projects are tagged by kind. Client projects are delivery cost. Market benchmark (prospect) projects are acquisition cost and are shown separately.

## Known inaccuracies inherited from capture pricing

- OpenAI flex-tier pricing is not applied, so costs are overstated.
- Search fees are estimated.
- Gemini, Perplexity and Anthropic search fees are unverified.

See strategy doc 01 §3.1.

## Scenario model (`lib/economics/scenarios.ts`, `/operations`)

Pure functions. **Every input is an assumption typed by the operator; nothing is pre-filled and nothing is a measured RF figure.** For $0.5M / $1M / $2M / $3M revenue the model shows:
- clients needed;
- gross (contribution) margin;
- EBITDA margin;
- the **maximum labor hours per client-month** that still reach 50% and 60% EBITDA.

The model:

```
clients     = revenue / annual revenue per client
delivery    = clients × 12 × (inference + other APIs + labor h × loaded rate)
EBITDA      = revenue − delivery − (platform infra + S&M + G&A + R&D)
max labor h = (revenue × (1 − target) − fixed − clients × 12 × (inference + APIs)) / (clients × 12 × rate)
```

Known-answer tests: `tests/unit/economics-scenarios.test.ts`.

## What would have to be true (worked example — illustrative, not RF data)

Assumptions:

| Input | Value |
|---|---|
| Annual revenue per client | $12k |
| Inference per client-month | $20 |
| Other APIs per client-month | $30 |
| Loaded labor rate | $75/h |
| Fixed costs per year | $304k (infra $24k, S&M $100k, G&A $60k, R&D $120k) |

At $1.2M revenue:
- 100 clients;
- 50% EBITDA allows about 2.6 h of labor per client-month;
- at $0.5M the same fixed base makes 50% unreachable.

The lever is labor per client-month and fixed cost, not inference.

## What is missing before any margin claim

1. Real labor entries for real clients.
2. Infrastructure invoices.
3. Revenue.

Until all three exist, the honest statement is: "inference is cheap; delivery cost is unmeasured."
