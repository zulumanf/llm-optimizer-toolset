# Spec 025 — Knowledge Maintenance, Evaluation & Hardening

> Status: **ready — not implemented in this branch**
> Depends on: specs/020, 021, 022, 023, 024
> Branch: (future) `feat/025-knowledge-maintenance`

## Why this is a separate spec

Specs 020–024 build the layer. This one keeps it honest over time. It is written
now so nothing is retro-fitted, and deferred so that what ships in the current
branch is fully verified rather than broadly sketched. Everything here is named
as a known limitation in the 020 deliverable.

## Scope

### Daily reconciliation workflow

A `workflow_definitions` row driven by the existing automation heartbeat
(`app/api/cron/automation/route.ts`) — no new scheduler.

```
detect failed ingestions
→ detect stale pages older than their SLA
→ detect expired claims
→ detect broken evidence links
→ detect orphaned claims (no evidence, or evidence deleted)
→ detect dependency mismatches (declared vs actually read)
→ verify page content hashes against stored bodies
→ retry failed builds within the attempt budget
→ rebuild affected hot files
→ refresh retrieval indexes
→ write a knowledge exception report
```

It reconciles; it does not regenerate everything. A daily job that rebuilds the
world hides the staleness it exists to detect.

### Weekly deeper review

Contradiction scan across all open claims · duplicate-entity review ·
weak-evidence review (claims whose only support is a single low-quality source) ·
source-quality review · oversized-page review · retrieval-quality evaluation ·
unused-page review · wiki-versus-canonical consistency audit · hot-file
usefulness (selection rate per packet) · context-packet human-override rate ·
stale instruction review · privacy-policy compliance sweep.

### `knowledge_exceptions`

Mirrors `workflow_exceptions`: kind, severity, subject, detail, recommended
action, status, resolved_by. Surfaced on the existing Today feed rather than in
a new inbox.

### Retrieval evaluation suite

Fixture-based queries per task type (content drafting, classification, executive
reporting, outreach, meeting preparation, reputation correction, attribution
analysis, action prioritization), asserting the packet **includes** required
approved facts, correct dates, relevant evidence, correct instructions and
necessary contradictions — and **excludes** irrelevant documents, stale claims,
prohibited private information, other clients' information, unsupported claims
and duplicated text. Scored as recall/precision per fixture with a CI gate,
following the `tests/unit/parser-accuracy.test.ts` precedent.

### Live agent-quality experiments

The offline token counter shipped in spec 020 measures token deltas only. This
spec adds an opt-in live harness that runs the same task under four context
modes against a real provider and measures accuracy, unsupported-claim rate,
completion rate, human-correction time, cost and latency. It requires a
provider key and spends real money, so it is operator-triggered, never scheduled.

### Quality metrics

Ingestion (sources, duplicate rate, extraction failure rate, reprocessing rate,
time to canonical availability) · canonical (approved/proposed counts,
contradiction rate, expired claims, human correction rate, evidence coverage) ·
compilation (pages, incremental vs full share, failure rate, no-op share,
duration, cost) · retrieval (packet tokens, build latency, failure rate,
missing-required-context rate, human override rate, cross-client leakage rate,
stale-inclusion rate) · agent (task success, fact-verification failure,
unsupported-claim rate, correction time, cost per accepted output, tokens per
workflow, latency, retry rate).

### Hardening

Security review · client-isolation load testing · retention and deletion
enforcement by `retention_class` · legal-hold support · client deletion workflow ·
signed-URL artifact access when object storage lands.

## Acceptance criteria

- [ ] Daily and weekly workflows run on the existing heartbeat and are idempotent.
- [ ] Neither job regenerates unaffected pages.
- [ ] Exceptions appear on the Today feed with a recommended action.
- [ ] Retrieval evaluations produce scored, gated fixtures.
- [ ] Live experiments are opt-in and never scheduled.
- [ ] Retention classes are enforced, with legal hold honoured.
