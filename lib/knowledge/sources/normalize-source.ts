/**
 * Persisting normalization for an ingested source (spec 021 Part 5).
 *
 * Every normalized value is written with its original, its confidence and its
 * match status. The point is not to clean the data — it is to record what we
 * *think* a value means and how sure we are, so a `probable` entity match
 * reaches a human instead of quietly becoming a fact.
 */
import { sql } from "@/db/client";
import { extractUrls } from "@/lib/parsing/prepass";
import {
  bestMatch,
  normalizeDate,
  normalizeDomain,
  normalizeUrl,
  type MatchStatus,
} from "@/lib/knowledge/normalize";

interface NormalizeArgs {
  sourceArtifactId: string;
  projectId: string;
  sourceType: string;
  url: string | null;
  text: string;
  structured: unknown;
}

interface PendingNormalization {
  field: string;
  originalValue: string;
  normalizedValue: string;
  entityId: string | null;
  confidence: number | null;
  matchStatus: MatchStatus;
  requiresReview: boolean;
}

/** How many distinct URLs from one document are worth recording. */
const MAX_URL_NORMALIZATIONS = 50;
/** Candidate entity names sampled from a document's text. */
const MAX_NAME_CANDIDATES = 40;

export async function normalizeSourceValues(args: NormalizeArgs): Promise<number> {
  const pending: PendingNormalization[] = [];

  if (args.url) {
    pending.push(exact("source_url", args.url, normalizeUrl(args.url)));
    pending.push(exact("source_domain", args.url, normalizeDomain(args.url)));
  }

  for (const url of extractUrls(args.text).slice(0, MAX_URL_NORMALIZATIONS)) {
    pending.push(exact("referenced_url", url, normalizeUrl(url)));
  }

  for (const raw of candidateDates(args.text)) {
    const iso = normalizeDate(raw);
    if (iso) pending.push(exact("date", raw, iso));
  }

  // Entity matching runs against this client's entities plus the shared ones.
  const entities = await sql`
    select e.id, e.canonical_name
    from knowledge_entities e
    where (e.project_id = ${args.projectId} or e.project_id is null)
      and e.status = 'active'
  `;
  if (entities.length > 0) {
    const known = entities.map((row) => ({
      id: row.id as string,
      name: row.canonicalName as string,
    }));
    for (const candidate of candidateNames(args.text)) {
      const { entityId, match } = bestMatch(candidate, known);
      if (match.matchStatus === "unmatched") continue;
      pending.push({
        field: "entity_name",
        originalValue: match.originalValue,
        normalizedValue: match.normalizedValue,
        entityId,
        confidence: match.matchConfidence,
        matchStatus: match.matchStatus,
        requiresReview: match.requiresReview,
      });
    }
  }

  const deduped = dedupe(pending);
  if (deduped.length === 0) return 0;

  await sql.begin(async (tx) => {
    for (const item of deduped) {
      await tx`
        insert into source_normalizations (
          source_artifact_id, field, original_value, normalized_value,
          normalized_entity_id, match_confidence, match_status, requires_review
        ) values (
          ${args.sourceArtifactId}, ${item.field}, ${item.originalValue},
          ${item.normalizedValue}, ${item.entityId}, ${item.confidence},
          ${item.matchStatus}, ${item.requiresReview}
        )
      `;
    }
  });
  return deduped.length;
}

function exact(field: string, original: string, normalized: string): PendingNormalization {
  return {
    field,
    originalValue: original,
    normalizedValue: normalized,
    entityId: null,
    confidence: 1,
    matchStatus: "exact",
    requiresReview: false,
  };
}

function dedupe(items: PendingNormalization[]): PendingNormalization[] {
  const seen = new Set<string>();
  const out: PendingNormalization[] = [];
  for (const item of items) {
    const key = `${item.field}|${item.originalValue}|${item.normalizedValue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

const DATE_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/gi,
  /\bQ[1-4]\s+\d{4}\b/g,
];

function candidateDates(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of DATE_PATTERNS) {
    for (const match of text.matchAll(pattern)) found.add(match[0]);
  }
  return [...found];
}

/**
 * Capitalised multi-word runs — the shape a proper noun takes in prose. A
 * deliberately cheap heuristic: its output is *candidates* for matching against
 * known entities, and an unmatched candidate is discarded rather than recorded.
 */
function candidateNames(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b([A-Z][\w&'-]*(?:\s+(?:of|the|and|&|[A-Z][\w&'-]*)){1,4})\b/g)) {
    const value = match[1]!.trim();
    if (value.length < 4 || value.length > 80) continue;
    found.add(value);
    if (found.size >= MAX_NAME_CANDIDATES) break;
  }
  return [...found];
}
