/**
 * Source ingestion (spec 021).
 *
 * One entry point for every way material reaches this platform: a file upload,
 * a URL fetch, a connector payload, a webhook, or text the platform already
 * holds. The pipeline is:
 *
 *   validate scope → store bytes → hash → dedupe → sniff type → extract
 *   → normalize → emit source.ingested
 *
 * Two properties carry the design:
 *
 *  - **Idempotent on content.** The unique `(project_id, sha256)` index means
 *    re-ingesting identical bytes for one client returns the first artifact and
 *    creates nothing. That is what makes a retried upload or a re-run connector
 *    sync safe without a caller-supplied idempotency key.
 *  - **A failed parse never loses a source.** Extraction failure is recorded on
 *    the artifact and in `extraction_runs`; the bytes stay. "Raw data is
 *    sacred" (PRINCIPLES.md #3) means we keep what we cannot yet read.
 */
import { z } from "zod";
import { sql, type TransactionSql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { publishEvent } from "@/lib/events/bus";
import { log } from "@/lib/logger";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import {
  SOURCE_FETCH_TIMEOUT_MS,
  SOURCE_MAX_BYTES,
} from "@/lib/knowledge/constants";
import {
  resolveExtractor,
  runExtractor,
  getExtractor,
} from "@/lib/knowledge/sources/extractors";
import { safeFetch } from "@/lib/security/safe-fetch";
import { sniffMimeType, sourceTypeForMime } from "@/lib/knowledge/sources/mime";
import { readSourceBytes, storeSourceBytes } from "@/lib/knowledge/sources/storage";
import { normalizeSourceValues } from "@/lib/knowledge/sources/normalize-source";
import { estimateTokens } from "@/lib/knowledge/context/tokens";

export const SOURCE_TYPES = [
  "document",
  "pdf",
  "spreadsheet",
  "website",
  "crm_export",
  "analytics_export",
  "search_console_export",
  "transaction_file",
  "questionnaire",
  "transcript",
  "email",
  "llm_response",
  "screenshot",
  "ranking_record",
  "published_content",
  "api_response",
  "image",
  "other",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const PRIVACY_CLASSES = ["public", "client_only", "internal", "restricted"] as const;
export type PrivacyClass = (typeof PRIVACY_CLASSES)[number];

const ORIGINS = ["upload", "url_fetch", "connector", "webhook", "manual", "internal", "import"] as const;

export interface IngestionResult {
  sourceArtifactId: string;
  sha256: string;
  storageKey: string;
  mimeType: string;
  sourceType: SourceType;
  /** True when identical bytes were already held for this client. */
  duplicate: boolean;
  extractionStatus: string;
  extractedTextLength: number;
  spanCount: number;
  normalizations: number;
  extractionError: string | null;
}

const ingestSchema = z
  .object({
    projectId: z.string().uuid(),
    sourceType: z.enum(SOURCE_TYPES).optional(),
    origin: z.enum(ORIGINS).default("upload"),
    filename: z.string().max(500).optional(),
    url: z.string().url().optional(),
    provider: z.string().max(100).optional(),
    declaredMimeType: z.string().max(200).optional(),
    /** Raw bytes (upload), or text the platform already holds. */
    bytes: z.instanceof(Buffer).optional(),
    text: z.string().optional(),
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    privacy: z.enum(PRIVACY_CLASSES).default("client_only"),
    retentionClass: z.enum(["standard", "short", "legal_hold"]).default("standard"),
    supersedesId: z.string().uuid().optional(),
    workflowRunId: z.string().uuid().optional(),
  })
  .refine((v) => v.bytes !== undefined || v.text !== undefined || v.url !== undefined, {
    message: "Provide bytes, text, or a url to fetch.",
  });

export type IngestSourceInput = z.input<typeof ingestSchema>;

/**
 * Ingest one source. Returns the artifact whether it was newly stored or
 * already held — a caller retrying an upload wants the artifact, not an error.
 */
export async function ingestSource(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<IngestionResult>> {
  const parsed = ingestSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;

  try {
    assertCanWrite(user);
    const [project] = await sql`
      select id, status from projects where id = ${input.projectId}
    `;
    if (!project) throw new ClassifiedError("not_found", "Client not found.");
    if (project.status !== "active") {
      throw new ClassifiedError("conflict", "Client is not active.");
    }

    const fetched = await resolveBytes(input);
    if (fetched.bytes.length === 0) {
      throw new ClassifiedError("validation", "The source is empty.");
    }
    if (fetched.bytes.length > SOURCE_MAX_BYTES) {
      throw new ClassifiedError(
        "validation",
        `The source is ${fetched.bytes.length} bytes; the limit is ${SOURCE_MAX_BYTES}.`
      );
    }

    // The uploader's content type is a claim; the bytes decide.
    const mimeType = sniffMimeType({
      bytes: fetched.bytes,
      declared: fetched.declaredMimeType ?? input.declaredMimeType ?? null,
      filename: input.filename ?? fetched.filename ?? null,
    });
    const sourceType = (input.sourceType ?? sourceTypeForMime(mimeType)) as SourceType;

    const stored = await storeSourceBytes({
      projectId: input.projectId,
      bytes: fetched.bytes,
    });

    const existing = await sql`
      select id, storage_key, mime_type, source_type, extraction_status
      from source_artifacts
      where project_id = ${input.projectId} and sha256 = ${stored.sha256}
    `;
    if (existing.length > 0) {
      const row = existing[0]!;
      log("info", "knowledge.source.duplicate", {
        projectId: input.projectId,
        sourceArtifactId: row.id as string,
      });
      return ok({
        sourceArtifactId: row.id as string,
        sha256: stored.sha256,
        storageKey: row.storageKey as string,
        mimeType: row.mimeType as string,
        sourceType: row.sourceType as SourceType,
        duplicate: true,
        extractionStatus: row.extractionStatus as string,
        extractedTextLength: 0,
        spanCount: 0,
        normalizations: 0,
        extractionError: null,
      });
    }

    // A new version of a known URL supersedes its predecessor. Nothing is
    // deleted — the old artifact keeps its claims explicable.
    const predecessor = await findPredecessor(input);
    const version = predecessor ? (predecessor.version as number) + 1 : 1;

    const artifactId = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into source_artifacts (
          project_id, source_type, origin, original_filename, original_url,
          provider, mime_type, byte_size, sha256, storage_key, effective_date,
          published_at, privacy_classification, retention_class, version,
          supersedes_id, created_by, workflow_run_id
        ) values (
          ${input.projectId}, ${sourceType}, ${input.origin},
          ${input.filename ?? fetched.filename ?? null},
          ${fetched.url ?? input.url ?? null}, ${input.provider ?? null},
          ${mimeType}, ${fetched.bytes.length}, ${stored.sha256}, ${stored.storageKey},
          ${input.effectiveDate ?? null}, ${input.publishedAt ?? null},
          ${input.privacy}, ${input.retentionClass}, ${version},
          ${predecessor?.id ?? null}, ${user.id}, ${input.workflowRunId ?? null}
        )
        returning id
      `;
      const id = row!.id as string;
      if (predecessor) {
        await tx`
          update source_artifacts set superseded_at = now() where id = ${predecessor.id}
        `;
        await publishEvent(tx, {
          type: "source.superseded",
          projectId: input.projectId,
          payload: {
            sourceArtifactId: id,
            sourceType,
            mimeType,
            sha256: stored.sha256,
            supersedesId: predecessor.id as string,
          },
        });
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "knowledge.source.ingest",
        entity: "source_artifact",
        entityId: id,
        detail: { sourceType, mimeType, bytes: fetched.bytes.length, version },
      });
      return id;
    });

    const extraction = await extractAndStore({
      sourceArtifactId: artifactId,
      projectId: input.projectId,
      bytes: fetched.bytes,
      mimeType,
      filename: input.filename ?? fetched.filename ?? null,
    });

    const normalizations = await normalizeSourceValues({
      sourceArtifactId: artifactId,
      projectId: input.projectId,
      sourceType,
      url: fetched.url ?? input.url ?? null,
      text: extraction.text,
      structured: extraction.structured,
    });

    await sql.begin((tx) =>
      publishEvent(tx, {
        type: "source.ingested",
        projectId: input.projectId,
        payload: {
          sourceArtifactId: artifactId,
          sourceType,
          mimeType,
          sha256: stored.sha256,
        },
      })
    );

    return ok({
      sourceArtifactId: artifactId,
      sha256: stored.sha256,
      storageKey: stored.storageKey,
      mimeType,
      sourceType,
      duplicate: false,
      extractionStatus: extraction.status,
      extractedTextLength: extraction.text.length,
      spanCount: extraction.spanCount,
      normalizations,
      extractionError: extraction.error,
    });
  } catch (err) {
    return fail(err);
  }
}

/**
 * Re-run extraction against stored bytes with the current parser version.
 * Inserts a new `extracted_documents` row; prior parses stay readable so a
 * claim proposed from an older parse remains explicable.
 */
export async function reprocessSource(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<IngestionResult>> {
  const parsed = z.object({ sourceArtifactId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid source id."));
  }
  try {
    assertCanWrite(user);
    const [artifact] = await sql`
      select id, project_id, storage_key, mime_type, source_type, sha256,
        original_filename
      from source_artifacts where id = ${parsed.data.sourceArtifactId}
    `;
    if (!artifact) throw new ClassifiedError("not_found", "Source not found.");

    const bytes = await readSourceBytes(artifact.storageKey as string);
    const extraction = await extractAndStore({
      sourceArtifactId: artifact.id as string,
      projectId: artifact.projectId as string,
      bytes,
      mimeType: artifact.mimeType as string,
      filename: (artifact.originalFilename as string | null) ?? null,
    });

    await sql.begin((tx) =>
      writeAudit(tx, {
        userId: user.id,
        action: "knowledge.source.reprocess",
        entity: "source_artifact",
        entityId: artifact.id as string,
        detail: { status: extraction.status, extractor: extraction.extractorKey },
      })
    );

    return ok({
      sourceArtifactId: artifact.id as string,
      sha256: artifact.sha256 as string,
      storageKey: artifact.storageKey as string,
      mimeType: artifact.mimeType as string,
      sourceType: artifact.sourceType as SourceType,
      duplicate: false,
      extractionStatus: extraction.status,
      extractedTextLength: extraction.text.length,
      spanCount: extraction.spanCount,
      normalizations: 0,
      extractionError: extraction.error,
    });
  } catch (err) {
    return fail(err);
  }
}

// ------------------------------------------------------------------ internals

interface ExtractionOutcome {
  status: string;
  text: string;
  structured: unknown;
  spanCount: number;
  error: string | null;
  extractorKey: string;
}

async function extractAndStore(args: {
  sourceArtifactId: string;
  projectId: string;
  bytes: Buffer;
  mimeType: string;
  filename: string | null;
}): Promise<ExtractionOutcome> {
  const extractor = resolveExtractor({ mimeType: args.mimeType, filename: args.filename });
  const { result, durationMs } = await runExtractor(extractor, args.bytes);

  await sql.begin(async (tx) => {
    // The unique (artifact, extractor, version) index makes re-extraction with
    // an unchanged parser a no-op rather than a duplicate row.
    await tx`
      insert into extracted_documents (
        source_artifact_id, extractor_key, extractor_version, text, structured,
        spans, token_count, status, error
      ) values (
        ${args.sourceArtifactId}, ${extractor.key}, ${extractor.extractorVersion},
        ${result.text}, ${result.structured === null ? null : tx.json(result.structured as never)},
        ${tx.json(result.spans as never)}, ${estimateTokens(result.text)},
        ${result.status}, ${result.error ?? null}
      )
      on conflict (source_artifact_id, extractor_key, extractor_version) do nothing
    `;
    await tx`
      insert into extraction_runs (
        source_artifact_id, extractor_key, extractor_version, status,
        duration_ms, error
      ) values (
        ${args.sourceArtifactId}, ${extractor.key}, ${extractor.extractorVersion},
        ${result.status === "failed" ? "failed" : "succeeded"}, ${durationMs},
        ${result.error ?? null}
      )
    `;
    await tx`
      update source_artifacts
      set extraction_status = ${result.status},
        processing_status = ${result.status === "extracted" ? "normalized" : "pending"}
      where id = ${args.sourceArtifactId}
    `;

    if (result.status === "failed") {
      await publishEvent(tx, {
        type: "source.extraction_failed",
        projectId: args.projectId,
        payload: {
          sourceArtifactId: args.sourceArtifactId,
          sourceType: "",
          mimeType: args.mimeType,
          sha256: "",
          extractorKey: extractor.key,
          extractorVersion: extractor.extractorVersion,
          error: result.error ?? "unknown extraction failure",
        },
      });
    }
  });

  return {
    status: result.status,
    text: result.text,
    structured: result.structured,
    spanCount: result.spans.length,
    error: result.error ?? null,
    extractorKey: extractor.key,
  };
}

async function findPredecessor(
  input: z.output<typeof ingestSchema>
): Promise<{ id: string; version: number } | null> {
  if (input.supersedesId) {
    const [row] = await sql`
      select id, version, project_id from source_artifacts where id = ${input.supersedesId}
    `;
    if (!row) throw new ClassifiedError("not_found", "The superseded source does not exist.");
    if (row.projectId !== input.projectId) {
      // A client may not chain their source onto another client's.
      throw new ClassifiedError("forbidden", "That source belongs to a different client.");
    }
    return { id: row.id as string, version: row.version as number };
  }
  if (!input.url) return null;
  const [row] = await sql`
    select id, version from source_artifacts
    where project_id = ${input.projectId} and original_url = ${input.url}
      and superseded_at is null
    order by version desc limit 1
  `;
  return row ? { id: row.id as string, version: row.version as number } : null;
}

interface ResolvedBytes {
  bytes: Buffer;
  declaredMimeType: string | null;
  filename: string | null;
  url: string | null;
}

async function resolveBytes(input: z.output<typeof ingestSchema>): Promise<ResolvedBytes> {
  if (input.bytes) {
    return {
      bytes: input.bytes,
      declaredMimeType: input.declaredMimeType ?? null,
      filename: input.filename ?? null,
      url: input.url ?? null,
    };
  }
  if (input.text !== undefined) {
    return {
      bytes: Buffer.from(input.text, "utf8"),
      declaredMimeType: input.declaredMimeType ?? "text/plain",
      filename: input.filename ?? null,
      url: input.url ?? null,
    };
  }
  return fetchUrl(input.url!);
}

/**
 * Fetch a URL for ingestion through the central outbound-fetch policy
 * (lib/security/safe-fetch.ts): http(s) only, private hosts refused, every
 * redirect hop re-validated, response size capped while streaming.
 */
async function fetchUrl(url: string): Promise<ResolvedBytes> {
  const response = await safeFetch(url, {
    timeoutMs: SOURCE_FETCH_TIMEOUT_MS,
    maxBytes: SOURCE_MAX_BYTES,
  });
  if (!response.ok) {
    throw new ClassifiedError(
      "internal",
      `Fetching ${url} returned ${response.status} ${response.statusText}.`
    );
  }
  return {
    bytes: response.bytes,
    declaredMimeType: response.headers.get("content-type"),
    filename:
      new URL(response.finalUrl).pathname.split("/").filter(Boolean).pop() ?? null,
    url,
  };
}

export { isPrivateHost } from "@/lib/security/safe-fetch";

/** Read the current parse of a source, newest extractor version first. */
export async function latestExtraction(
  sourceArtifactId: string,
  tx: TransactionSql | typeof sql = sql
): Promise<{
  text: string;
  structured: unknown;
  spans: unknown;
  extractorKey: string;
  extractorVersion: string;
  status: string;
} | null> {
  const [row] = await tx`
    select text, structured, spans, extractor_key, extractor_version, status
    from extracted_documents
    where source_artifact_id = ${sourceArtifactId}
    order by created_at desc limit 1
  `;
  if (!row) return null;
  return {
    text: row.text as string,
    structured: row.structured ?? null,
    spans: row.spans ?? [],
    extractorKey: row.extractorKey as string,
    extractorVersion: row.extractorVersion as string,
    status: row.status as string,
  };
}

export { getExtractor };
