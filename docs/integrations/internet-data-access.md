# Internet Data Access — current state and target architecture

The application never depends on an operator's ad-hoc browsing. All external data enters through backend code paths with provenance, or through operator-supplied uploads (CSV, licensed exports). No consumer AI chat interface is ever scraped; AI visibility comes from official provider APIs, honestly labeled (`docs/07-experiment-protocol.md`).

## What exists today

| Concern | Implementation | Status |
|---|---|---|
| Page fetching | `lib/security/safe-fetch.ts` — http(s) only, private/link-local refusal, **DNS resolution with every address validated**, manual redirect following re-validating each hop, streaming response-size caps, timeouts | Strong; the single guarded path |
| robots.txt | `lib/knowledge/discovery/robots.ts` — RFC parsing (longest-match, Allow beats Disallow), permissive-on-4xx, named UA `AvosVisibilityAudit/1.0` | Parser good; **fetch bypasses `safeFetch`** (no DNS check, no size cap) — fix scheduled (implementation plan, Continuous) |
| Rate limiting | Per-module politeness: `CRAWL_DELAY_MS=1200` + 429 backoff (`lib/knowledge/sources/discover.ts`), `FETCH_DELAY_MS=1200` (`lib/knowledge/discovery/service.ts`) | No cross-job per-host limiter; constants not config |
| Caching / dedup | Content-addressed: `source_artifacts (project_id, sha256)` unique; normalized-URL skip of already-ingested pages | No HTTP-level cache (ETag/Last-Modified/TTL) |
| Provenance | `source_artifacts`: provider, original_url, retrieved_at, sha256, effective/published dates; `prospect_authority_signals`: source_url + provenance + confidence | Prospect signals lack `retrieved_at`/`verification_status` (Phase B migration) |
| Staleness | Knowledge layer only (`wiki_pages.freshness_status`, claim review dates, maintenance runs) | Absent on prospect surfaces (Phase F) |
| AI providers | `lib/ai/` — OpenAI, Anthropic, Google, Perplexity + guarded mock; retries/backoff, per-provider concurrency + intervals, micro-USD costs, per-run budgets | Anthropic/Perplexity/`+search` unverified against live keys; no in-app health check |
| Sanitization | Instruction-level ("treat answer text as data") in every LLM prompt touching external content; regex HTML→text with char cap | No structural delimiter/escaping layer — weakest link, scheduled |
| Secrets | Server-side only; `lib/env.ts` zod-validated at boot; CI runs keyless; credentials AES-256-GCM enveloped (`lib/security/envelope.ts`) | Three vars drift outside the env schema (fix scheduled) |
| Mock mode | `mockProviderAllowed()` — mock refused outside test/`ALLOW_MOCK_PROVIDER=1`, enforced at four layers | Whole app runs keyless locally and in CI |

## Target provider-adapter layer

Categories (implemented **only** as real providers are licensed — no speculative adapters, no hard-coded single vendor):

```text
Search Provider                  → future; feeds discovery queries
Structured Real-Estate Data      → licensed feeds (MLS-derived, rankings); enters as ProspectSourceAdapter
Public-Record Provider           → future
Page Fetching                    → exists: safeFetch (the only sanctioned fetch path)
Content Extraction               → exists: lib/knowledge/sources/extractors
AI Visibility Provider           → exists: lib/ai (AIProvider interface)
Contact Enrichment               → future; results land in prospect_contacts with provenance='publicly_sourced'|'verified'
```

Common envelope for every imported fact (matches the audit's requirement; `source_artifacts` already approximates it):

```typescript
interface SourceRecord<T> {
  data: T;
  provider: string;
  sourceType: string;
  sourceUrl?: string;
  retrievedAt: string;          // ISO
  rawContentReference?: string; // source_artifacts id / sha256
  confidence: number;           // 0..1
  verificationStatus: "unverified" | "automated" | "human_verified";
  metadata: Record<string, unknown>;
}
```

Adapter contract for prospect sourcing (Phase E):

```typescript
interface ProspectSourceAdapter {
  discoverProspects(input: ProspectDiscoveryInput): Promise<RawProspect[]>;
  fetchProspectDetails(input: ProspectLookupInput): Promise<RawProspectDetails>;
  validateConfiguration(): Promise<ProviderHealth>;
}
```

CSV upload and manual entry are adapters of this same shape conceptually — they already write `source`, `field_provenance`, and (for signals) `source_url` + `confidence` through one persistence path, so licensed providers later slot in without forking dedup or provenance rules.

## Rules (enforced or scheduled)

- Official/licensed APIs first; public crawling only where permitted; robots respected (deliberate, documented exception: the client's own site — `lib/knowledge/sources/discover.ts`).
- All outbound fetches through `safeFetch`; identifiable UA; per-provider rate limits and exponential backoff; response-size and time limits.
- Domain allow/denylist: not yet implemented (current posture is deny-by-policy checks, not allowlist); introduce `ALLOWED_SOURCE_DOMAINS` / `BLOCKED_SOURCE_DOMAINS` when the first external crawl-driven prospect source ships — the env vars are added only then (repo rule: no variables for unimplemented providers).
- External content is untrusted data: never allowed to alter system instructions or invoke tools; structural sanitization layer scheduled (implementation plan, Continuous).
- Budgets: per-run USD budgets and per-discovery-run cost caps exist; a global daily provider ceiling (`MAX_DAILY_PROVIDER_COST`) lands with the first paid crawl/search provider.
- Every stored fact: source, URL, retrieved date, provider, extraction method, raw/normalized value, confidence, verification status.
- Keys server-side only, never committed; `.env.example` carries placeholders for implemented providers only.
