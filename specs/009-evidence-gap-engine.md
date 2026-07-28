# Spec 009 — Evidence-Gap Engine

> Status: draft (ready after 008)
> Depends on: specs/008 · docs/15 (agent contract)

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
