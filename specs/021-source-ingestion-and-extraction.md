# Spec 021 — Source Ingestion & Extraction

> Status: in-progress
> Depends on: specs/020, specs/llm-evidence-capture-and-audit-trail, docs/10
> Branch: feat/018-graph-execution-control-plane

## Goal

Give the canonical knowledge graph an intake. A document, export, page or
transcript arrives once, is stored immutably and content-addressed, is parsed
by a versioned extractor, and becomes the evidence behind proposed claims —
without a human retyping anything, and without the original ever being altered.

## Existing capabilities

| Capability | State | Where |
|---|---|---|
| Content-addressed byte storage + sha256 + immutable row | ✅ | `lib/evidence/storage.ts`, `evidence_artifacts` |
| Immutability trigger | ✅ | `forbid_mutation()` |
| Connector adapters incl. CSV, local file store, manual, GA4, Search Console, CRM, CMS | ✅ | `lib/connectors/` |
| Durable queue for slow work | ✅ | `db/jobs.ts` |
| Domain events | ✅ | `lib/events/` |

## Gaps

`evidence_artifacts` cannot serve as the raw source layer: it is keyed to a
`response_id` (an LLM capture), its `kind` check enumerates capture kinds only,
and it has no project scope, source type, effective date, privacy class,
retention class, extraction status or version chain. Widening it with twenty
nullable columns for a different lifecycle would make one table mean two things.
A sibling table is the honest model; the *byte-storage primitive* is shared.

## Data model (migration `021_knowledge_sources.sql`)

```sql
source_artifacts(
  id, project_id → projects, source_type, origin,
  original_filename, original_url, provider, mime_type,
  byte_size, sha256, storage_key,
  retrieved_at, effective_date, published_at,
  privacy_classification, retention_class,
  version, supersedes_id → source_artifacts, superseded_at,
  extraction_status, processing_status,
  created_by, workflow_run_id, created_at)
  -- forbid_mutation() except the two status columns, which move forward
  -- through a guarded update path (see "Status columns" below)

extracted_documents(
  id, source_artifact_id, extractor_key, extractor_version,
  text, structured jsonb, spans jsonb, token_count,
  status, error, created_at)                       -- insert-only

extraction_runs(
  id, source_artifact_id, extractor_key, extractor_version,
  status, attempt, duration_ms, error, created_at)  -- insert-only

source_normalizations(
  id, source_artifact_id, field, original_value, normalized_value,
  normalized_entity_id → knowledge_entities, match_confidence,
  match_status, requires_review, created_at)
```

**Status columns.** `source_artifacts` is insert-only for content. Extraction and
processing status must advance, so the immutability trigger permits an update
that changes *only* `extraction_status`, `processing_status`, `superseded_at` or
`supersedes_id`, and refuses any statement touching content, hash or storage key.
The guard lives in the trigger function, not in application convention.

`source_type` ∈ `document | pdf | spreadsheet | website | crm_export |
analytics_export | search_console_export | transaction_file | questionnaire |
transcript | email | llm_response | screenshot | ranking_record |
published_content | api_response | image | other`.

`privacy_classification` reuses the existing `PRIVACY_ORDER` vocabulary —
`public | client_only | internal | restricted` — so one privacy model governs
sources, claims and packets.

`retention_class` ∈ `standard | short | legal_hold`. Enforcement of deletion
schedules is deferred to spec 025; the classification is recorded now so nothing
is retro-fitted later.

## Ingestion pipeline

```
input arrives
→ validate project scope and privacy class
→ store bytes content-addressed under var/knowledge/<project>/<sha256[0:2]>/<sha256>
→ hash (sha256, computed at write)
→ duplicate check on (project_id, sha256)
     hit  → return the existing artifact, record nothing new, emit no event
     miss → insert source_artifacts row
→ resolve extractor by mime type + source type
→ extract text + structured content + spans (queued for slow parsers)
→ normalize URLs, domains, dates, currency, entity names
→ classify privacy (inherit from input; never downgrade automatically)
→ emit source.ingested
```

Every step is idempotent. Re-ingesting identical bytes for the same client is a
no-op that returns the first artifact — this is what makes a retried connector
sync or a double-clicked upload safe.

**Re-extraction.** `reprocess(artifactId)` runs the current extractor version
against the stored bytes and inserts a *new* `extracted_documents` row. Prior
extractions stay readable, so a claim proposed from an old parse remains
explicable. The raw bytes are never re-fetched or re-written.

**Supersession.** Ingesting a source that declares the same `original_url` (or an
explicit `supersedesId`) with different bytes creates a new artifact whose
`supersedes_id` points at the predecessor and sets the predecessor's
`superseded_at`. Nothing is deleted.

## Extractors

Registry in `lib/knowledge/sources/extractors/`, mirroring
`lib/connectors/registry.ts`. Each declares `key`, `extractorVersion`, the mime
types it claims, and returns `{text, structured, spans, tokenCount}`.

| Extractor | Formats | Dependency |
|---|---|---|
| `text` | `text/plain` | none |
| `markdown` | `text/markdown` | none |
| `html` | `text/html` — tag stripping, script/style removal, title and meta capture | none |
| `csv` | `text/csv` — RFC 4180 parse, header detection, row spans | none |
| `json` | `application/json` — flattening with path spans | none |
| `pdf` | `application/pdf` — per-page text with page spans | new |
| `xlsx` | Excel workbooks — per-sheet rows with sheet/row spans | new |
| `unsupported` | images, video, unknown binaries | — |

`spans` anchor an evidence excerpt to a location (page, sheet+row, CSV row, JSON
path, character offset), so a claim can cite *where* in a 200-page document its
support lives rather than citing the whole file.

Images and scanned PDFs are **stored and hashed** with
`extraction_status = 'unsupported'`. No OCR is built; the UI says so plainly.

## Normalization

`lib/knowledge/normalize.ts`, reusing the URL/domain helpers already in
`lib/parsing/` rather than writing a second normalizer:

- URLs → scheme lowered, tracking params stripped, trailing slash removed
- Domains → punycode-normalized, `www.` stripped
- Dates → ISO 8601, with the original preserved
- Currency/numeric → minor units + declared currency, original preserved
- Entity names → casefolded, punctuation-normalized, matched against
  `knowledge_entities` + `entity_aliases`

Ambiguity is never discarded. Every normalization writes a
`source_normalizations` row carrying `original_value`, `normalized_value`,
`match_confidence`, `match_status` and `requires_review`. A `probable` or
`ambiguous` match is surfaced for review; it does not silently become a fact.

## API

```typescript
interface SourceIngestionService {
  ingest(input: IngestSourceInput): Promise<IngestionResult>;
  reprocess(sourceArtifactId: string): Promise<IngestionResult>;
}
```

`IngestSourceInput` accepts bytes + filename, or a URL to fetch, or already-held
text (for `llm_response` and connector payloads), plus project, source type,
privacy class, effective date and optional workflow run. Server actions in
`app/knowledge/actions.ts`; the fetch path is queued, not inline.

## Validation rules

- Project must exist and be active; a source with no project is rejected.
- Bytes must be non-empty and under a declared size cap (`lib/knowledge/constants.ts`).
- Mime type is sniffed, not trusted from the client.
- `privacy_classification` may be raised on re-ingest, never lowered automatically.
- A URL fetch must be http(s); no file:// or internal-network addresses.
- Extraction failure records the failure and leaves the artifact stored — a
  parse we cannot do is not a source we throw away.

## Edge cases

| Case | Behaviour |
|---|---|
| Same bytes, same client, twice | returns existing artifact; `duplicate: true`; no event |
| Same bytes, different client | separate artifact — clients never share rows |
| Same URL, new bytes | new version, `supersedes_id` set, predecessor kept |
| Unsupported type | stored, `extraction_status = 'unsupported'`, no error |
| Corrupt file | stored, `extraction_status = 'failed'`, error recorded, artifact retained |
| Extractor times out | `extraction_runs` records the attempt; retried by the queue up to the standard limit |
| Extractor version changed | new `extracted_documents` row; old parse retained |
| Empty extraction result | `status = 'empty'`; no claims proposed |

## Acceptance criteria

- [ ] Bytes are written content-addressed and never overwritten (`flag: "wx"`).
- [ ] A duplicate ingest returns the original and creates no second row.
- [ ] Extraction is stored separately from bytes and records its parser version.
- [ ] Re-extraction adds a row and preserves prior parses.
- [ ] Supersession links versions and deletes nothing.
- [ ] Normalization records confidence and match status, preserving originals.
- [ ] Unsupported and corrupt inputs are retained, labelled, and do not fail ingest.
- [ ] `source.ingested` is emitted exactly once per genuinely new artifact.
- [ ] A client cannot read another client's artifact through any code path.

## Test cases

Unit: hashing, dedupe key, storage-key traversal refusal, mime sniffing, each
extractor against a fixture, span anchoring, URL/date/currency normalization,
entity match confidence banding.
Integration: file ingest → extract → normalize; URL ingest; duplicate ingest;
supersession; reprocess after a version bump; corrupt file; unsupported type.
Security: cross-client artifact read, path traversal via storage key, privacy
downgrade attempt.

## Definition of done

All acceptance criteria pass · tests green · `npm run lint` and `npm run typecheck`
clean · migration applies and rolls back · new dependencies recorded in
`DECISIONS.md` with the alternatives rejected · `docs/03-database-schema.md` updated.
