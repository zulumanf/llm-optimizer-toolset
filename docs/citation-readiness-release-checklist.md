# Citation-readiness release checklist (spec 141)

Branch `feat/141-citation-readiness`. Ticks are updated as each gate is verified; a gate is never ticked from memory.

| # | Gate | Command / evidence | Status |
|---|---|---|---|
| 1 | Branch and unrelated work preserved | `git status`; other session's supply-engine / contact-discovery files untouched | done |
| 2 | Parser regression investigated at row level | `docs/parser_revision_comparison.md` | done |
| 3 | Revision 3 (versioned adjudication) written for affected runs only | `scripts/mention-revision-3.ts`, migration 116 | done (offline adjudication; classifier had no credits) |
| 4 | Precedence rule explicit: verified > directional; needs_manual_review excluded | `db/mentions.ts` `PUBLIC_REVISION`, docs | done |
| 5 | Verifier fails on unverified / manual-review / denominator / dataset / wording drift | `npx tsx scripts/marketing-claims-verify.ts --check` exit 0 | done — exits 1 on staging: 85 pairs in manual review |
| 6 | Regression tests added | `tests/unit/classification-precedence.test.ts`, `tests/unit/marketing-claims.test.ts` | done |
| 7 | Registry regenerated from revision 3 | verifier PASS on every claim | done on staging; provisional until applied to production |
| 8 | Dataset v1.0.1 regenerated + changelog | `scripts/public-dataset-export.ts --version 1.0.1` | done (v1.0.1) |
| 9 | Wording: instrument label + explanation on benchmark pages; sample audit labelled | static wording test | done |
| 10 | Human gates documented | `docs/human-verification-gates.md` | done |
| 11 | Migration 115 idempotent + rollback verified | `docs/citation-map-usage.md` | done |
| 12 | Typecheck, lint, targeted tests, full suite, build | recorded in final report | pending |
| 13 | Route QA (200, one H1, canonical, index, JSON-LD, tables, links) | dev-server sweep | pending |
| 14 | Focused commits, no unrelated files | `git log` | pending |
| 15 | Deploy / migrate / upload / send | **not performed**; commands documented | blocked on human |
