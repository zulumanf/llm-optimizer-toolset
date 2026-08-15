/**
 * RealTrends verified-production evidence (2026-08-15): turns one RealTrends
 * ranking row into structured, deduplicated authority signals, and formats
 * the prospect-facing "verified market performance" line.
 *
 * Rules this module enforces:
 * - The ranking scope is mandatory and travels with the rank everywhere: a
 *   category-specific #1 can never render as an overall-market #1
 *   (`scopeComparable: false` also keeps such ranks out of cross-company
 *   rank math in publishAudit).
 * - RealTrends reports closed SALES VOLUME, never commission income — no
 *   label produced here may use the word "commission".
 * - Volume ÷ sides is a DERIVED number ("average closed volume per side"),
 *   stored as its own signal with source_type 'derived' so the authority
 *   score excludes it (lib/prospects/authority.ts) and copy never presents
 *   it as an average home price.
 */
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { ClassifiedError } from "@/lib/errors";

export const REALTRENDS_RECORD_TYPE = "realtrends_production";
export const REALTRENDS_SOURCE_NAME = "RealTrends America's Best";

export interface RealTrendsRecord {
  entityType: "individual" | "team";
  /** Null when the rank's category could not be confidently determined —
   * volume/sides still ingest; no rank claim is ever made. */
  rank: number | null;
  /** Mandatory, exact scope of the ranking, e.g. "Jersey City, NJ — teams
   * by closed volume". */
  rankScope: string;
  /** True only for the overall city list for this entity type. Category
   * pages (team-size brackets) are NOT comparable across companies. */
  scopeComparable: boolean;
  city: string;
  state: string;
  brokerage: string;
  volumeUsd: number;
  sides: number;
  productionYear: number | null;
  publicationYear: number | null;
  sourceUrl: string;
  pageTitle: string;
  /** YYYY-MM-DD the operator captured/verified the page. */
  capturedOn: string;
}

/** Deterministic derived metric: average closed volume per side. */
export function avgVolumePerSide(volumeUsd: number, sides: number): number | null {
  if (!(volumeUsd > 0) || !(sides > 0)) return null;
  return Math.round(volumeUsd / sides);
}

export interface SignalDraft {
  kind: "ranking" | "transaction_volume" | "transaction_count" | "avg_deal_value";
  label: string;
  valueNumber: number;
  sourceType: "independent" | "derived";
  metadata: Record<string, unknown>;
}

function baseMetadata(record: RealTrendsRecord): Record<string, unknown> {
  return {
    record_type: REALTRENDS_RECORD_TYPE,
    entity_type: record.entityType,
    rank: record.rank,
    rank_scope: record.rankScope,
    scope_comparable: record.scopeComparable,
    city: record.city,
    state: record.state,
    brokerage: record.brokerage,
    volume_usd: record.volumeUsd,
    sides: record.sides,
    production_year: record.productionYear,
    publication_year: record.publicationYear,
    page_title: record.pageTitle,
    captured_on: record.capturedOn,
  };
}

function money(volumeUsd: number): string {
  return `$${(volumeUsd / 1_000_000).toFixed(2)}M`;
}

/** One RealTrends record → its signal rows. Pure; unit-tested. */
export function realTrendsSignalDrafts(record: RealTrendsRecord): SignalDraft[] {
  if (!record.rankScope.trim()) {
    throw new ClassifiedError(
      "validation",
      "A RealTrends record requires its exact ranking scope — a bare rank is unpublishable."
    );
  }
  const meta = baseMetadata(record);
  const drafts: SignalDraft[] = [];
  if (record.rank !== null) {
    drafts.push({
      kind: "ranking",
      label: `${REALTRENDS_SOURCE_NAME}: #${record.rank} — ${record.rankScope} (${money(record.volumeUsd)} closed sales volume)`,
      valueNumber: record.rank,
      sourceType: "independent",
      metadata: meta,
    });
  }
  drafts.push({
    kind: "transaction_volume",
    label: `${REALTRENDS_SOURCE_NAME}: ${money(record.volumeUsd)} closed sales volume — ${record.rankScope}`,
    valueNumber: record.volumeUsd,
    sourceType: "independent",
    metadata: meta,
  });
  drafts.push({
    kind: "transaction_count",
    label: `${REALTRENDS_SOURCE_NAME}: ${record.sides} sides — ${record.rankScope}`,
    valueNumber: record.sides,
    sourceType: "independent",
    metadata: meta,
  });
  const avg = avgVolumePerSide(record.volumeUsd, record.sides);
  if (avg !== null) {
    drafts.push({
      kind: "avg_deal_value",
      label: `Average closed volume per side ≈ ${money(avg)} — derived from RealTrends volume ÷ sides`,
      valueNumber: avg,
      sourceType: "derived",
      metadata: { ...meta, derived_from: "volume_usd / sides" },
    });
  }
  return drafts;
}

/** Prospect-facing "verified market performance" copy. Pure; the rank line
 * exists ONLY together with its exact scope. */
export interface VerifiedProduction {
  source: string;
  rank: number | null;
  rankScope: string;
  scopeComparable: boolean;
  volumeUsd: number;
  sides: number;
  avgPerSideUsd: number | null;
  productionYear: number | null;
  sourceUrl: string;
  retrievedOn: string;
}

export function formatVerifiedProduction(vp: VerifiedProduction): {
  headline: string;
  detail: string;
} {
  const parts = [
    `${money(vp.volumeUsd)} closed sales volume`,
    `${vp.sides} sides`,
    ...(vp.avgPerSideUsd !== null
      ? [`≈ ${money(vp.avgPerSideUsd)} average closed volume per side`]
      : []),
  ];
  return {
    headline:
      vp.rank !== null
        ? `${vp.source}: #${vp.rank} — ${vp.rankScope}`
        : `${vp.source}: ${vp.rankScope}`,
    detail: parts.join(" · "),
  };
}

/**
 * Idempotent ingestion: skips a draft when an identical RealTrends fact for
 * this prospect already exists (same kind + source URL + scope + value), so
 * re-running an import can never inflate the evidence base.
 */
export async function ingestRealTrendsRecord(
  user: CurrentUser,
  input: { prospectId: string; record: RealTrendsRecord }
): Promise<ActionResult<{ inserted: number; skippedDuplicates: number }>> {
  try {
    assertCanWrite(user);
    const drafts = realTrendsSignalDrafts(input.record);
    const result = await sql.begin(async (tx) => {
      let inserted = 0;
      let skipped = 0;
      for (const draft of drafts) {
        const [dup] = await tx`
          select id from prospect_authority_signals
          where prospect_id = ${input.prospectId}
            and kind = ${draft.kind}
            and metadata->>'record_type' = ${REALTRENDS_RECORD_TYPE}
            and source_url = ${input.record.sourceUrl}
            and metadata->>'rank_scope' = ${input.record.rankScope}
            and value_number = ${draft.valueNumber}
        `;
        if (dup) {
          skipped += 1;
          continue;
        }
        await tx`
          insert into prospect_authority_signals
            (prospect_id, kind, label, value_number, source_url, provenance,
             scope, retrieved_at, source_type, metadata, created_by)
          values (${input.prospectId}, ${draft.kind}, ${draft.label},
            ${draft.valueNumber}, ${input.record.sourceUrl},
            ${draft.sourceType === "independent" ? "verified" : "estimated"},
            'local', ${input.record.capturedOn}, ${draft.sourceType},
            ${tx.json(draft.metadata as never)}, ${user.id})
        `;
        inserted += 1;
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.realtrends_ingest",
        entity: "prospect",
        entityId: input.prospectId,
        detail: {
          sourceUrl: input.record.sourceUrl,
          rankScope: input.record.rankScope,
          inserted,
          skippedDuplicates: skipped,
        },
      });
      return { inserted, skippedDuplicates: skipped };
    });
    return ok(result);
  } catch (err) {
    if (err instanceof ClassifiedError) return fail(err);
    return fail(new ClassifiedError("internal", (err as Error).message));
  }
}

/** Newest RealTrends production record for a prospect, shaped for the audit
 * snapshot; null when none ingested. */
export async function latestVerifiedProduction(
  prospectId: string
): Promise<VerifiedProduction | null> {
  const [row] = await sql`
    select metadata, source_url, retrieved_at
    from prospect_authority_signals
    where prospect_id = ${prospectId}
      and metadata->>'record_type' = ${REALTRENDS_RECORD_TYPE}
      and kind = 'transaction_volume'
    order by created_at desc
    limit 1
  `;
  if (!row) return null;
  const m = row.metadata as Record<string, unknown>;
  const volumeUsd = Number(m.volumeUsd ?? m["volume_usd"]);
  const sides = Number(m.sides);
  return {
    source: REALTRENDS_SOURCE_NAME,
    rank: m.rank === null || m.rank === undefined ? null : Number(m.rank),
    rankScope: String(m.rankScope ?? m["rank_scope"] ?? ""),
    scopeComparable: Boolean(m.scopeComparable ?? m["scope_comparable"]),
    volumeUsd,
    sides,
    avgPerSideUsd: avgVolumePerSide(volumeUsd, sides),
    productionYear:
      m.productionYear ?? m["production_year"]
        ? Number(m.productionYear ?? m["production_year"])
        : null,
    sourceUrl: row.sourceUrl as string,
    retrievedOn: String(m.capturedOn ?? m["captured_on"] ?? ""),
  };
}
