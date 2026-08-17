# 05 — Feature Specifications (Overview)

One section per feature: purpose, user flow, edge cases, acceptance criteria. These are the stable product-level descriptions; the **executable, build-this-now versions live in `specs/`** with schema changes, endpoints, and test cases. When this file and a spec disagree, the spec (newer, more detailed) wins — then update this file.

| Feature | Executable spec |
|---|---|
| Project Management | `specs/001-project-management.md` |
| Prompt Library | `specs/002-prompt-library.md` |
| Experiment Runs | `specs/003-experiment-runs.md` |
| Response Classification & Review | `specs/004-response-classification.md` |
| Competitor Analysis | `specs/005-competitor-analysis.md` |
| Reporting Dashboard | `specs/006-reporting-dashboard.md` |
| Attribution | `specs/007-attribution.md` |

---

## Prompt Manager (Prompt Library)

**Purpose:** author the questions we ask AI assistants, organized into sets that can be frozen into immutable versions for reproducible runs.

**User flow:** create set → add prompts (text, category) → reorder → **Freeze** → set version becomes selectable when starting a run. Editing after freeze changes the working copy only; next freeze = next version.

**Edge cases:** freezing an empty set (blocked); freezing with no changes since last version (blocked, "no changes"); editing a prompt used in past runs (fine — past runs reference the frozen snapshot); deleting a set with versions (archive only).

**Acceptance criteria:** a frozen version's contents are bit-identical forever; every run displays exactly which version it used; diffs between versions viewable.

## Experiment Runs

**Purpose:** execute a frozen prompt set across providers/models with N repetitions, capturing raw responses immutably.

**User flow:** New Run → pick prompt-set version, providers/models, repetitions → cost estimate shown → confirm → progress view (completed/failed cells) → run completes → parsing kicks off automatically.

**Edge cases:** provider outage mid-run (cells fail with recorded errors, run ends `partial`, retry-failed-cells action); duplicate cell protection (idempotent jobs); budget cap exceeded (run pauses, operator decides); cron and manual runs colliding (queue serializes per project).

**Acceptance criteria:** every attempted call has a `responses` row (success or error); no response ever updated after insert; rerun never touches an old run's data.

## Response Classification & Review

**Purpose:** turn raw text into structured mentions (who was mentioned, recommended, at what position, with what sentiment and citations) with confidence, routing uncertain parses to humans.

**User flow:** automatic after each run → Review queue lists `needs_review` mentions with excerpt + highlighted raw response → operator confirms or corrects → correction saved as new revision, original kept.

**Edge cases:** brand alias collisions ("Lumina" vs. an unrelated "Lumina Labs"); answers with no brands at all (valid, counts in denominators); non-English answers; parser version upgrade (re-parse creates new revisions, never overwrites).

**Acceptance criteria:** every mention row carries `parser_version` + `confidence`; below-threshold parses never enter scoring until reviewed; correction history fully visible.

## Competitor Analysis

**Purpose:** the same metrics we compute for the client, computed for tracked competitors, compared.

**User flow:** manage competitor list per project (company + aliases + tier) → dashboard comparison view: share of voice, recommendation rate side by side, per provider, over time.

**Edge cases:** competitor added mid-history (metrics computed from existing raw data retroactively — raw data makes this free); competitor rebrands (alias update, re-parse forward); untracked brands appearing often (surfaced as "unrecognized brands" suggestions).

**Acceptance criteria:** identical methodology for the client and competitors — no metric exists for one and not the other.

## Reports

**Purpose:** immutable point-in-time snapshots for decision-making: scores, deltas vs. previous period, notable excerpts, suggested tasks.

**User flow:** generate draft for a period → operator edits narrative sections (never numbers) → publish → locked forever → shareable/exportable.

**Edge cases:** publishing with unreviewed low-confidence mentions in the period (blocked or explicitly flagged in the report); regenerating a draft after new data (allowed for drafts only).

**Acceptance criteria:** published reports render identically forever; every number links to its underlying scores/responses.

## Evidence & Tasks

**Purpose:** close the loop — findings become concrete work with proof attached.

**User flow:** from any score/mention/report, "Create task" → task drafted with evidence links → human approves → tracked to done → follow-up run measures effect (see `specs/007-attribution.md`).

**Edge cases:** task suggested with zero evidence (blocked); evidence's parent report superseded (task keeps original evidence — it pointed at immutable data).

**Acceptance criteria:** no suggested task without evidence; no task auto-executes anything (`PRINCIPLES.md` #8).

## Audit Refresh Queue

**Purpose:** consume the weekly baseline data flowing for prospect markets — every published audit gets a prepared refresh, and the operator's remaining work is one reviewed click per audit (`specs/075-audit-refresh-queue.md`).

**User flow:** scheduled market run finishes → `audit_refresh_v1` prepares a candidate per published audit (linked run, generated findings, week-over-week delta, dry-run preflight) → operator opens `/prospects/refresh-queue` → reviews the delta and finding, types/edits the required human finding, acknowledges any warnings → Approve & publish republishes through the unchanged `publishAudit` gates to the same token; Hold dismisses for the week.

**Edge cases:** preparation failure becomes a `needs_attention` card, never a silent skip; a claim that flipped (prospect now leads the rival) is flagged loudly before approval; promoted/revoked prospects are excluded and refuse late approval; a newer run supersedes undecided candidates; duplicate event delivery is idempotent per (prospect, run).

**Acceptance criteria:** nothing prospect-visible changes without `approveAuditRefresh` — a named staff click through the full publish gates (`PRINCIPLES.md` #8).

## Branded Audit Links

**Purpose:** the emailed audit URL leads with the prospect's own name instead of 43 characters of noise, without weakening the token-is-the-lock security model (`specs/076-branded-audit-links.md`).

**User flow:** first publication auto-mints `/audit/<name-slug>/<16-char-key>` → copy-link and outreach drafts prefer it → the link follows the prospect's current published audit through supersedes and refreshes → revocation burns branded and legacy doors together.

**Edge cases:** wrong slug + valid key permanently redirects to the canonical slug; valid slug + wrong key is a 404 indistinguishable from any bad token; a burned key never resurrects across republishes; legacy token URLs work forever.

**Acceptance criteria:** the key alone is the credential (96 bits); the slug grants nothing.
**Acceptance criteria:** the key alone is the credential (96 bits); the slug grants nothing.

## Audit Sense-Check

**Purpose:** an LLM second read of the assembled audit — coherence, overreach, numbers, copy, fairness — before a human decides to send it (`specs/077-audit-sense-check.md`).

**User flow:** operator clicks Sense check on the prospect page (or, post-075, it runs during weekly refresh preparation) → concerns render with severity, area, and quoted text → at publish, concern-severity findings on a content-hash-matching check join the acknowledge-with-reason gate; stale or absent checks are advisory only.

**Edge cases:** a failed LLM call stores the failure and fabricates nothing; content changed since the check → advisory "stale check" warning, never a block; quoted assistant answers are data under review, not instructions; polish-severity findings never gate.

**Acceptance criteria:** the agent describes problems and never writes prospect-visible copy; no code path publishes or blocks on its say-so alone (`PRINCIPLES.md` #8).
## Perplexity Enrichment

**Purpose:** find contact emails and independently published production data for prospects via search-grounded research — cited, staged, and operator-approved, never silently trusted (`specs/079-perplexity-enrichment.md`).

**User flow:** Run research on a prospect (or sweep a launch) → ONE Perplexity call asks only for that prospect's missing fields → findings stage as proposals with citations → operator approves (materializes a contact or a properly-provenanced authority signal feeding magnitude-aware scoring) or rejects.

**Edge cases:** fully-known prospect costs zero calls; freshness window stops re-queries; a failed call stores a failure row; emails are `ai_inferred` and signals `publicly_sourced` — never `verified` from research alone (spec 074 owns that); missing API key fails closed.

**Acceptance criteria:** no auto-approval at any confidence; every call in the LLM ledger under the daily ceiling.

## Perplexity Prospect Discovery

**Purpose:** the first real discovery adapter — one search-grounded call proposes a market's notable teams as review candidates (`specs/080-perplexity-discovery.md`).

**User flow:** Prospects → Discover → pick perplexity + segment → candidates stage with citations and `ai_inferred` provenance in the existing review queue → approve to create prospects → run spec-079 enrichment on approved ones for emails/production.

**Edge cases:** a failed sweep is a failed run, never filled in; missing key fails closed; discovery never asks for emails (spec 079's job, with its validity gate); each sweep ledgers under `prospect-discovery-v1`.

**Acceptance criteria:** nothing becomes a prospect without operator approval; the mock stays guarded out of production.

## Buying-Signal Research

**Purpose:** wake the `buyingSignals` score component — Perplexity finds recent developments (brokerage moves, expansions, press) and stages them for approval, telling the operator *when* to reach out (`specs/081-buying-signal-research.md`).

**User flow:** rides the same single enrichment call (a `recentDevelopments` section appears when signal research is >30 days stale) → sourced developments stage as proposals → approval materializes via the existing buying-signals machinery with recency-decayed scoring. The worker's daily tick sweeps active launches; freshness windows make it self-limiting.

**Edge cases:** an unsourced development is a rumor — never staged; unknown kinds map to `other`, surfaced not dropped; undated finds record today as the observation date.

**Acceptance criteria:** approval remains the only path to a signal (`PRINCIPLES.md` #8); still one call per prospect, ever.

## Market-Pack Drafts

**Purpose:** open a new city in minutes — one research call drafts the pack (neighborhoods, brokerages, publications) for review; installing creates the market tree and opens the launch (`specs/082-market-pack-drafts.md`).

**User flow:** Prospects → Draft new market → city + state → review the drafted names with citations → Install & open launch (or Reject) → run discovery (spec 080) for teams → enrichment (079/081) per approved prospect.

**Edge cases:** a draft is never a market until installed; failures store failed drafts; registry packs share the same installer byte-identically; standard prompt templates ride along unchanged.

**Acceptance criteria:** install-through-review is the only path from research to markets.

## Mobile-Responsive Workspace

**Purpose:** the operator's weekly loop works from a phone — sidebar becomes a drawer behind a top bar below lg, same server-rendered nav in both frames (`specs/083-mobile-responsive-workspace.md`).

**User flow:** identical to desktop; at phone width the menu button opens the drawer, navigation closes it, tables scroll horizontally in place.

**Edge cases:** /audit/* keeps zero workspace chrome at every width; desktop layout is pixel-unchanged at lg+.

**Acceptance criteria:** a 390px Playwright fence asserts no horizontal page scroll on the key operator surfaces.
