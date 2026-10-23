# Brokerage foundation — spec 151 milestone D1

## Model (migration 131)

| Table | Purpose |
|---|---|
| `organizations` | A brokerage (kind `brokerage`); optional `company_id` for its own measured entity |
| `organization_entities` | Members: measured companies at level `individual` / `team` / `office`; soft removal |
| `organization_grants` | User → organization, read-only, revocable |

No separate application. Brokerage users are ordinary client accounts (`client_viewer`):
- they see granted rosters at `/portal/organizations/[orgId]`, linked from `/portal`;
- staff manage organizations at `/organizations`.

## Access rules (`lib/organizations/service.ts`)

- Staff see every organization. Other accounts see only organizations with an un-revoked grant.
- An ungranted or unknown id is `not_found`, so existence never leaks.
- Every write requires staff (`assertCanWrite`).
- **Data scope:** the roster reads `score_estimates` only from projects of kind `prospect` bound to a market (shared market benchmarks). A member's measurements inside any client's private project are never read.
- **No licensed RealTrends field is selected anywhere in the roster.** Production volume is not shown until rights are verified (see `production-readiness.md`, legal checklist).

## Roster

Per member:
- latest market-benchmark recommendation and mention rates **per model**, with 95% prompt-clustered intervals, counts and distinct prompts;
- market and measured date.

Wording states that it describes sampled API answers, not buyer reach.

## Verification

`tests/integration/organizations.test.ts`:
- deny by default before a grant;
- client accounts cannot grant or add members;
- a granted user sees only member rows;
- another client account and unknown ids get `not_found`;
- a newer private-project run with a different value is provably not read.

## Deliberately not built

- Partner management.
- Brokerage-level billing.
- Agent self-service.
- Office hierarchies beyond a level label.
- Bulk roster import (members come from benchmark-measured companies; datalist picker).

Build these when a brokerage pays.
