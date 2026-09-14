# Spec 141 — Citation readiness and evidence distribution

Status: implemented on `feat/141-citation-readiness`; release blocked on human gates (`docs/human-verification-gates.md`).

## Goal
Make Recommended First's benchmark evidence citable by search and AI systems without any claim that the raw data cannot support.

## Scope
1. Approved-claims registry (`lib/marketing/approved-claims.json`) as the only source of public numbers; verifier (`scripts/marketing-claims-verify.ts --check`) as the release gate.
2. Classification precedence for public numbers (`lib/parsing/precedence.ts`, `db/mentions.ts` `PUBLIC_REVISION`/`PUBLIC_BLOCKED_PAIR`), revision-3 adjudication (`scripts/mention-revision-3.ts`, migration 116).
3. Public research pages, flagship benchmark, index v0, guides and sourced comparison pages; robots, sitemap, llms.txt, JSON-LD.
4. Public dataset v1.0.x (`scripts/public-dataset-export.ts`, `data/public/`), served at `/research-data/`.
5. Citation map (`citation_map_targets`, migration 115; `lib/citations/citation-map.ts`) and intervention controls.
6. Outreach, entity footprint, external submission and consumer-benchmark assessments as documents only; nothing sent or uploaded.

## Acceptance criteria
- `npx tsx scripts/marketing-claims-verify.ts --check` exits 0 against production after migrations 115–116 and the revision-3 artifact are applied and the manual-review queue is empty.
- Every public number resolves to an approved claim with denominator, date, market and instrument; unit tests enforce wording, market separation and dataset agreement.
- Raw answers and prior revisions unchanged (immutable triggers); every new classification row versioned with method, reason and status.
- All public routes 200, one H1, canonical, index/follow, JSON-LD; no "ChatGPT recommended/cited" wording for API captures.
