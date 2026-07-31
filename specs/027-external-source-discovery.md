# Spec 027 — External Source Discovery

> Status: done (2026-07-30) — service layer; see "Not built" below
> Depends on: specs/008 (claims), specs/021 (source ingestion), specs/022 (packets), docs/12, docs/13
> Branch: `feat/018-graph-execution-control-plane`

## Goal

Find the pages on the open web that carry facts about a client, capture them as
immutable sources, and let the existing extraction pipeline propose claims from
them — so enriching a client is a repeatable operation instead of a
hand-written script.

## The actual gap

Almost all of this already exists and is not being rebuilt:

| Capability | State | Where |
|---|---|---|
| Crawl the client's **own** site | ✅ | `lib/knowledge/sources/discover.ts` |
| Ingest a URL as an immutable, hashed artifact | ✅ | `ingestSource` |
| Extract text from HTML/PDF/XLSX | ✅ | `lib/knowledge/extraction/` |
| Propose claims with verbatim quotes | ✅ `claim_extraction` agent | `lib/knowledge/extraction/claims.ts` |
| Human approval, evidence, supersession | ✅ | `lib/claims/service.ts` |
| Contradiction rows | ✅ | `claim_contradictions` |
| Search-enabled model with real citations | ✅ | `lib/ai/openai.ts` `+search`, `lib/ai/citations.ts` |
| **Deciding which external URLs are worth ingesting** | ❌ | nothing |

`scripts/jc-enrich.ts` is the proof of the gap: a hand-written, client-specific
file listing five URLs an operator found by hand. It produced good claims and is
unrepeatable. This spec replaces the *finding* step and hands the rest to
machinery that already works.

Discovery is therefore the whole feature. Everything after the URL is existing
code called in order.

## Design decisions

**Search results are a lead list, never evidence.** A search tells us a page
might exist and might be relevant. Nothing may cite a search result. A claim
cites a `source_artifact` — the captured bytes, hashed, retrievable — so the
pipeline is: search → filter → **ingest** → extract → propose. A page that
cannot be fetched and stored produces no claim, however promising the snippet.

**Queries are templated and versioned, not agent-invented.** An agent that
writes its own searches produces a different corpus every run, and two
enrichments of the same client stop being comparable. Query templates live in
`docs/13-prompts.md` as `EXTERNAL_DISCOVERY_V1`, filled deterministically from
client identity: name, aliases, domain, principals, markets. The set of queries
run is recorded on the discovery run, so any claim traces back to the question
that surfaced it.

**Third-party pages are attributed, never adopted.** A press article is
evidence that a publication *stated* something — not that it is true. Claims
proposed from a third-party source carry `allowed_wording` phrased as
attribution ("Jersey Digs reports that…") and the publisher as the subject of
the attribution. This is the system-of-record rule from
`docs/architecture/build-vs-borrow-boundaries.md` applied to journalism: an
external system is an input, never the authority. Only the client's own domain
and client-confirmed material yield unattributed claims.

**The client's own domain is excluded.** `discover.ts` already crawls it, and
double-ingesting it would duplicate artifacts and inflate the corpus.

**Nothing is approved by this feature.** Every claim lands `proposed`. The
existing review UI is the gate (PRINCIPLES #8). A discovery run that proposes
forty claims has produced forty decisions for a human, and says so.

**Contradictions surface, they do not resolve.** A proposed claim whose
normalized predicate matches an approved claim with a different value writes a
`claim_contradictions` row and is flagged in the run summary. Superseding an
approved claim stays a human act.

## Scope boundaries

Deliberately not built:

- **No crawling from search results.** One page per result, no link-following.
  Following links off a search hit is how a client audit becomes a crawl of the
  open web.
- **No social media scraping.** Platform terms and login walls make it a
  different problem with a different legal posture.
- **No paywalled content.** A paywall is a refusal; it is recorded as one.
- **No people-search or data-broker sources.** The feature looks for what a
  business publishes about itself and what publications say about it, not
  personal records about individuals.
- **No JavaScript rendering**, matching `discover.ts`. A thin page is reported
  thin.

## Behaviour

```
runExternalDiscovery(projectId, options)
  1. build queries          deterministic, from client identity + templates
  2. execute searches       search-enabled provider; capture raw payloads
  3. extract candidates     lib/ai/citations.ts → {url, title, query}
  4. filter                 dedupe by normalized URL · drop own domain
                            · drop already-ingested · drop private hosts
                            · robots.txt · cap per run
  5. ingest each survivor   ingestSource(url) → immutable artifact
  6. extract claims         existing claim_extraction agent, per artifact
  7. contradiction check    against approved claims
  8. summarise              queries run, pages found//ingested/skipped+reason,
                            claims proposed, contradictions raised, cost
```

Every skip carries a reason. "We searched and found nothing" and "we found
eleven pages and could not fetch nine of them" are different outcomes and must
not render identically.

## Database changes

Migration `028_external_discovery.sql`:

- `discovery_runs` — project, status, queries jsonb, provider/model, counters,
  cost, started/completed, error. Mutable status while running.
- `discovery_candidates` — one row per URL considered: run, url, normalized url,
  source query, title, decision (`ingested` / `skipped`), skip reason,
  resulting `source_artifact_id`. **IMMUTABLE** — the record of what was
  considered and rejected is the audit trail for corpus selection.

`source_artifacts` gains nothing: `origin` already distinguishes `url_fetch`,
and the artifact links to its candidate row, not the reverse.

## Security & safety

- Robots.txt honoured. **Corrected during implementation:** the draft said this
  was reused from `discover.ts`, which does not implement it at all. For the
  client's own site that omission is defensible — an operator has permission to
  read it. Discovery fetches third-party sites nobody asked, so it is
  implemented here (`lib/knowledge/discovery/robots.ts`). The user agent and the
  1.2s politeness delay *are* shared, so a webmaster sees one identity.
- `isPrivateHost()` blocks SSRF to internal addresses — already written and
  tested for `ingestSource`.
- Per-run cost cap, checked before each search and each extraction agent call.
- Discovery is tenant-scoped: candidates and artifacts carry `project_id`, and
  a run for one client can never write an artifact for another.
- Ingested third-party pages default to `privacy_classification = 'public'`,
  since they were publicly retrievable — but retention follows the client's
  class.

## Testing

**Unit** (no network, no DB): query construction from identity; candidate
filtering (own domain, duplicates, private hosts, already-ingested); skip-reason
assignment; attribution wording for third-party sources; contradiction
detection against a fixture claim set; cost-cap arithmetic.

**Integration** (test DB, injected search + agent callers): a full run over
canned search payloads produces artifacts, proposed claims quoting them
verbatim, and a summary whose counts reconcile; a run where every fetch fails
proposes nothing and reports why; a second run over the same corpus ingests
nothing new (idempotent on `(project_id, sha256)`); a proposed claim conflicting
with an approved one raises a contradiction rather than superseding it;
cross-client isolation.

No test performs a live search — the provider caller is injected, matching how
`lib/ai/agent.ts` is already tested.

## Acceptance criteria

- [x] A discovery run is started per client and produces a summary reconciling
      queries → candidates → artifacts → claims.
- [x] Every proposed claim cites a `source_artifact` whose bytes are stored and
      hashed; no claim cites a search result.
- [x] Every quoted span is a verbatim substring of the extracted text —
      enforced by `verifyDraft`, which the integration suite relies on rather
      than works around.
- [x] Third-party claims carry attribution wording; only the client's own domain
      yields unattributed claims.
- [x] Every skipped candidate records a reason, and the summary distinguishes
      "found nothing" from "found and could not fetch".
- [x] The client's own domain is never re-ingested by discovery.
- [x] Re-running produces no duplicate artifacts.
- [x] A contradiction with an approved claim is raised, never auto-resolved.
- [x] Nothing reaches `approved` without a human.
- [x] Cost cap stops a run safely, with partial results retained and disclosed.
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass (1000 tests);
      migration 028 applies and reverses.

## Not built (2026-07-30)

- **No UI.** Deliberate, and the same order spec 026 took: run it, look at what
  it surfaces, then decide whether a review surface earns its keep. Claims it
  proposes are already approvable in `/projects/[id]/knowledge`, so nothing is
  stranded.
- **`attributionPrefix` is written and tested but not yet applied at write
  time.** The extractor composes its own wording, and threading attribution
  into it means changing `claim_extraction`'s prompt and its evaluation
  fixtures — a change to a shipped agent that deserves its own pass rather than
  a rider on this one. Until then, third-party claims are proposed with the
  extractor's wording and a human sees the source domain before approving. The
  helper is the contract that pass will implement.
- **No live provider run.** Every test injects the search caller. The feature
  has never executed a real search, and stays unverified against live payload
  shapes until it does.
- **Not wired to a workflow.** Runs as a service call, per the open question
  below.

## Open questions

- **Which provider executes the search?** OpenAI's Responses API + `web_search`
  is the only one live-verified here (DECISIONS, 2026-07-28). Perplexity is
  arguably better suited and its adapter is `implemented_unverified`. Start with
  OpenAI; revisit once a second provider is verified.
- **Should discovery become a workflow template?** It is a natural
  `agent_task` + gate graph. Deferred: shipping it as a service first keeps the
  first version inspectable, and spec 018's engine can wrap it later without
  changing the service.
