# Spec 009 — Evidence-Gap Engine

> Status: done (2026-07-28) — v1, deterministic
> Depends on: specs/008 · docs/15 (agent contract)
> Branch: feat/009-evidence-gap-engine
>
> Implementation notes: v1 ships the deterministic layer only (gap-detector-v1)
> — six typed detectors (entity, branded_recognition, recommendation,
> citation, category_share, source_target) computed from scored-run data with
> the blueprint's 30/25/20/15/10 opportunity weights; findings are idempotent
> per (run, type, category) and become evidence-backed suggested tasks via
> the existing approval machinery. The LLM competitor-evidence agent (web
> enrichment via the OpenAI Responses search tool) lands as detector v2 —
> same versioned-upgrade path as the parser. Known limitation surfaced by
> live data: the heuristic parser counts the Sanskrit word "parva" (in the
> Mahabharata answer) as a brand mention, so branded_recognition under-fires
> for name-collision clients — an LLM parser version fixes detection; the
> entity gap still fires correctly. Also shipped: the client-portfolio view
> on the projects list (subject, authority, open gaps, last run per client).

## Goal
Answer *why* the client is or isn't retrieved, per prompt: competitor
evidence profiles ("what signals likely support the brands that appeared"),
typed gap findings for the client, and a deterministic opportunity score that
ranks recommended actions. This is the blueprint's Competitor Evidence +
Evidence Gap + Action Prioritization trio — the most commercially valuable
layer.

## Shape
- **Competitor evidence agent** (LLM, yellow): given a prompt's responses,
  citations, and the competitor's public signals (search API results), draft
  a signal profile: rankings present, owned content, press, marketplace
  profiles, review mass. Output per docs/15 contract with evidence ids;
  `needs_review` when signals are thin.
- **Gap agent** (LLM, yellow): compare the client's knowledge base + citation
  record against the winners' profiles → typed findings:
  `entity | content | third_party_authority | attribution | freshness |
  technical | market_association | ranking_data`. Every finding carries
  evidence ids and one or more recommended actions.
- **Opportunity scoring** (deterministic, green): the agent supplies
  assessments (impact, severity, attainability, speed, execution
  likelihood); code computes the score with published weights (30/25/20/15/10
  per the blueprint) and writes suggested tasks through the existing
  specs/007 task machinery — evidence attached, human approval required.

## Database sketch
`gap_findings` (project, prompt_id, type, finding, evidence_ids, agent
version, confidence, status), `competitor_profiles` (project, company,
signals jsonb, as_of, agent version). Both append-only with revisions, like
mentions.

## Acceptance sketch
Findings only from approved claims + immutable captures + fetched sources
(each fetch recorded as evidence with URL); no finding without evidence;
scores reproducible from stored assessments; suggested tasks flow through
the existing approval gates.

## Open questions (resolve before implementation)
- Search/fetch provider for competitor signals (approved-domains allowlist).
- Whether Perplexity's citation payloads (already in raw_payload) seed the
  citation-evidence graph before any new fetching is built.
