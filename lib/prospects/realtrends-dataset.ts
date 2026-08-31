/**
 * Purchased RealTrends verified dataset (spec 124 data pass, 2026-08-30).
 * The licensed workbook ("2026 RealTrends Verified Agent Team Download with
 * City") becomes structured internal production evidence in
 * `realtrends_records`, resolved deterministically onto the canonical
 * companies layer — so a comparison team no longer needs to be an outreach
 * prospect, only a tracked company in the same market with benchmark
 * coverage. Pure parsing/normalization/matching cores + DB assemblers; no
 * LLM anywhere. Licensed data stays internal: rows are never rendered to
 * prospects, and the raw workbook never enters the repo.
 */
import { createHash } from "node:crypto";
import { sql } from "@/db/client";
import type { TransactionSql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { ClassifiedError } from "@/lib/errors";
import { scoreNameMatch } from "@/lib/knowledge/normalize";
import type { ProductionEvidence } from "@/lib/prospects/realtrends";

export const REALTRENDS_DATASET_NAME =
  "2026 RealTrends Verified Agent Team Download with City";
/** Non-URL source reference for evidence rows — the receipt is the licensed
 * workbook itself, which has no public URL and must not be linked. */
export const REALTRENDS_DATASET_SOURCE_REF = "licensed:realtrends-verified-2026";

/** Full state name → USPS code, for city_prospecting_pipelines geography. */
export const STATE_CODES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
  "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX",
  utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "district of columbia": "DC",
};

export function stateCode(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return STATE_CODES[trimmed.toLowerCase()] ?? null;
}

// ------------------------------------------------------------ workbook parse

export interface DatasetRow {
  fingerprint: string;
  entityType: "individual" | "team";
  entityName: string;
  teamLead: string | null;
  brokerage: string | null;
  city: string;
  state: string;
  volumeUsd: number | null;
  sides: number | null;
  productionYear: number;
  publicationYear: number | null;
  sourceSheet: string;
  sourceRow: number;
}

export interface ParsedSheetJson {
  sheet: string;
  header: string[];
  rows: { row: number; values: unknown[] }[];
}

export interface ParseResult {
  records: DatasetRow[];
  rejected: Record<string, number>;
}

/** "$47,200,000" / "47.2M" / 47200000 → canonical number; null when not a
 * usable non-negative number. Comparisons never use formatted strings. */
export function normalizeVolume(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0 ? raw : null;
  }
  const text = String(raw).trim().replace(/^\$/, "").replace(/,/g, "");
  const millions = text.match(/^(\d+(?:\.\d+)?)\s*[mM]$/);
  const value = millions ? Number(millions[1]) * 1_000_000 : Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Sides normalize the same way (RealTrends reports fractional sides). */
export function normalizeSides(raw: unknown): number | null {
  return normalizeVolume(raw);
}

const clean = (v: unknown): string =>
  v === null || v === undefined ? "" : String(v).trim();

/** Deterministic row identity (the workbook has no stable RealTrends id):
 * dataset + sheet + entity identity + geography + period. Values are
 * excluded so re-importing the same workbook is a no-op, and a future
 * year's workbook (different period) never collides. */
export function rowFingerprint(r: Omit<DatasetRow, "fingerprint">): string {
  return createHash("sha256")
    .update(
      [
        REALTRENDS_DATASET_NAME,
        r.sourceSheet,
        r.entityType,
        r.entityName.toLowerCase(),
        (r.brokerage ?? "").toLowerCase(),
        r.city.toLowerCase(),
        r.state.toUpperCase(),
        String(r.productionYear),
      ].join("|")
    )
    .digest("hex");
}

function headerIndex(header: string[], pattern: RegExp): number {
  return header.findIndex((h) => pattern.test(h));
}

/** Reporting period comes from the workbook's own column headers
 * ("2025 Volume (2026 Rankings)") — never inferred from the product name. */
export function periodFromHeader(header: string[]): {
  productionYear: number | null;
  publicationYear: number | null;
} {
  const joined = header.join(" · ");
  const production = joined.match(/(\d{4})\s+(?:Sides|Volume)/i);
  const publication = joined.match(/\((\d{4})\s+Rankings?\)?/i);
  return {
    productionYear: production ? Number(production[1]) : null,
    publicationYear: publication ? Number(publication[1]) : null,
  };
}

/** One sheet → validated records + rejection tally. One malformed row never
 * fails the sheet; licensed values are never echoed in the reasons. */
export function parseSheet(input: ParsedSheetJson): ParseResult {
  const header = input.header;
  const isTeams = headerIndex(header, /^team name$/i) >= 0;
  const idx = {
    teamName: headerIndex(header, /^team name$/i),
    teamLead: headerIndex(header, /team lead first name/i),
    firstName: headerIndex(header, /^first ?name$/i),
    lastName: headerIndex(header, /^last ?name$/i),
    company: headerIndex(header, /^company$/i),
    city: headerIndex(header, /^city$/i),
    state: headerIndex(header, /^state$/i),
    sides: headerIndex(header, /sides/i),
    volume: headerIndex(header, /volume/i),
  };
  const period = periodFromHeader(header);
  const rejected: Record<string, number> = {};
  const reject = (reason: string): void => {
    rejected[reason] = (rejected[reason] ?? 0) + 1;
  };
  const records: DatasetRow[] = [];
  if (period.productionYear === null) {
    return { records, rejected: { NO_PRODUCTION_YEAR_IN_HEADER: input.rows.length } };
  }
  for (const row of input.rows) {
    const v = row.values;
    const entityName = isTeams
      ? clean(v[idx.teamName])
      : [clean(v[idx.firstName]), clean(v[idx.lastName])].filter(Boolean).join(" ");
    if (!entityName) {
      reject("MISSING_NAME");
      continue;
    }
    const city = clean(v[idx.city]);
    const state = stateCode(clean(v[idx.state]) ?? "");
    if (!city || !state) {
      reject("MISSING_LOCATION");
      continue;
    }
    const volumeUsd = idx.volume >= 0 ? normalizeVolume(v[idx.volume]) : null;
    const sides = idx.sides >= 0 ? normalizeSides(v[idx.sides]) : null;
    if (volumeUsd === null && sides === null) {
      reject("NO_USABLE_PRODUCTION");
      continue;
    }
    const base: Omit<DatasetRow, "fingerprint"> = {
      entityType: isTeams ? "team" : "individual",
      entityName,
      teamLead: isTeams && idx.teamLead >= 0 ? clean(v[idx.teamLead]) || null : null,
      brokerage: idx.company >= 0 ? clean(v[idx.company]) || null : null,
      city,
      state,
      volumeUsd,
      sides,
      productionYear: period.productionYear,
      publicationYear: period.publicationYear,
      sourceSheet: input.sheet,
      sourceRow: row.row,
    };
    records.push({ ...base, fingerprint: rowFingerprint(base) });
  }
  return { records, rejected };
}

// --------------------------------------------------------------- matching

export type DatasetMatchStatus =
  | "unmatched"
  | "high_confidence"
  | "review_required"
  | "conflict"
  | "confirmed"
  | "rejected";

export interface MatchCandidateCompany {
  id: string;
  name: string;
  aliases: string[];
  /** prospect_type values of prospects linked to this company (may be empty
   * for benchmark-only companies). */
  prospectTypes: string[];
}

export interface MatchVerdict {
  status: Extract<DatasetMatchStatus, "unmatched" | "high_confidence" | "review_required" | "conflict">;
  companyId: string | null;
  confidence: number | null;
  detail: {
    reason: string;
    candidates: { companyId: string; name: string; matchStatus: string; confidence: number }[];
  };
}

/**
 * Deterministic record → company classification. The caller passes ONLY
 * companies already geo-scoped to the record's city/state market, so name
 * evidence decides within the market and geography can never be crossed.
 * Conservative by design: only a unique exact name match with a compatible
 * entity level auto-verifies; everything weaker waits for a human.
 */
export function classifyDatasetMatch(
  record: Pick<DatasetRow, "entityName" | "entityType">,
  companies: MatchCandidateCompany[]
): MatchVerdict {
  const scored = companies
    .map((c) => {
      const best = [c.name, ...c.aliases]
        .map((n) => scoreNameMatch(record.entityName, n))
        .sort((x, y) => y.matchConfidence - x.matchConfidence)[0]!;
      return { company: c, best };
    })
    .filter((s) => s.best.matchStatus === "exact" || s.best.matchStatus === "probable")
    .sort((a, b) => b.best.matchConfidence - a.best.matchConfidence);
  const detail = {
    candidates: scored.slice(0, 5).map((s) => ({
      companyId: s.company.id,
      name: s.company.name,
      matchStatus: s.best.matchStatus,
      confidence: s.best.matchConfidence,
    })),
  };
  if (scored.length === 0) {
    return {
      status: "unmatched",
      companyId: null,
      confidence: null,
      detail: { reason: "no name match in this market", ...detail },
    };
  }
  const exact = scored.filter((s) => s.best.matchStatus === "exact");
  if (exact.length > 1) {
    return {
      status: "conflict",
      companyId: null,
      confidence: exact[0]!.best.matchConfidence,
      detail: { reason: "multiple exact-name companies in this market", ...detail },
    };
  }
  const top = scored[0]!;
  if (exact.length === 1) {
    const types = top.company.prospectTypes;
    const levelConflict =
      types.length > 0 &&
      ((record.entityType === "team" && types.every((t) => t === "individual_agent")) ||
        (record.entityType === "individual" && types.every((t) => t === "team")));
    if (levelConflict) {
      return {
        status: "review_required",
        companyId: top.company.id,
        confidence: top.best.matchConfidence,
        detail: {
          reason: `entity level differs: workbook says ${record.entityType}, prospect record says ${types.join("/")}`,
          ...detail,
        },
      };
    }
    return {
      status: "high_confidence",
      companyId: top.company.id,
      confidence: top.best.matchConfidence,
      detail: { reason: "unique exact name match in market", ...detail },
    };
  }
  return {
    status: "review_required",
    companyId: top.company.id,
    confidence: top.best.matchConfidence,
    detail: { reason: "probable (partial) name match — needs a human", ...detail },
  };
}

// ---------------------------------------------------------- market geography

export interface LaunchGeo {
  launchId: string;
  city: string;
  state: string | null;
  stateSource: string;
}

/**
 * City + state per active launch, from strongest available evidence:
 * city-pipeline records (operator-entered state), else existing structured
 * RealTrends signal metadata on the launch's prospects. No state on file →
 * state stays null and the launch is EXCLUDED from automatic dataset
 * matching (same city name in two states — the Wilmington lesson,
 * 2026-08-21 — must never cross-match).
 */
export async function launchGeographies(
  db: TransactionSql | typeof sql = sql
): Promise<LaunchGeo[]> {
  const launches = await db`
    select l.id, l.name as launch_name, m.name as market_name, m.state_code
    from market_launches l join markets m on m.id = l.market_id
    where l.archived_at is null
  `;
  const pipelines = await db`
    select distinct city_name, state_name from city_prospecting_pipelines
  `;
  const pipelineState = new Map<string, string>();
  for (const p of pipelines) {
    const code = stateCode(p.stateName as string);
    if (code) pipelineState.set((p.cityName as string).toLowerCase(), code);
  }
  const signalStates = await db`
    select p.launch_id, upper(s.metadata->>'state') as state, count(*)::int as n
    from prospect_authority_signals s
    join prospects p on p.id = s.prospect_id
    where s.metadata->>'record_type' = 'realtrends_production'
      and s.metadata->>'state' is not null
    group by p.launch_id, upper(s.metadata->>'state')
    order by n desc
  `;
  const signalState = new Map<string, string>();
  for (const r of signalStates) {
    if (!signalState.has(r.launchId as string) && /^[A-Z]{2}$/.test(r.state as string)) {
      signalState.set(r.launchId as string, r.state as string);
    }
  }
  return launches.map((l) => {
    // Market name is the city; a non-alphabetic market name (a zip code
    // market) falls back to the launch name's city part.
    const marketName = l.marketName as string;
    const city = /[a-z]/i.test(marketName)
      ? marketName.split(",")[0]!.trim()
      : (l.launchName as string).split(/[—–-]/)[0]!.trim();
    const declared = (l.stateCode as string | null) ?? null;
    const fromPipeline = pipelineState.get(city.toLowerCase()) ?? null;
    const fromSignals = signalState.get(l.id as string) ?? null;
    return {
      launchId: l.id as string,
      city,
      state: declared ?? fromPipeline ?? fromSignals,
      stateSource: declared
        ? "market_state_code"
        : fromPipeline
          ? "city_pipeline"
          : fromSignals
            ? "rt_signals"
            : "none",
    };
  });
}

/** Operator declaration of a market's state (audited). The single knob that
 * unlocks dataset matching for markets predating the city pipelines. */
export async function setMarketState(
  user: CurrentUser,
  input: { marketName: string; state: string }
): Promise<ActionResult<{ marketId: string; state: string }>> {
  try {
    assertCanWrite(user);
    const code = stateCode(input.state);
    if (!code) throw new ClassifiedError("validation", `Unknown state "${input.state}".`);
    const result = await sql.begin(async (tx) => {
      const [market] = await tx`
        select id from markets where lower(name) = ${input.marketName.toLowerCase()}
      `;
      if (!market) throw new ClassifiedError("not_found", "Market not found.");
      await tx`update markets set state_code = ${code} where id = ${market.id}`;
      await writeAudit(tx, {
        userId: user.id,
        action: "market.state_declare",
        entity: "market",
        entityId: market.id as string,
        detail: { marketName: input.marketName, state: code },
      });
      return { marketId: market.id as string, state: code };
    });
    return ok(result);
  } catch (err) {
    if (err instanceof ClassifiedError) return fail(err);
    return fail(new ClassifiedError("internal", (err as Error).message));
  }
}

// -------------------------------------------------------------- DB assemblers

export interface ImportCounts {
  parsed: number;
  imported: number;
  duplicates: number;
  rejected: Record<string, number>;
}

/** Idempotent import: identical rows (fingerprint) are skipped, never
 * duplicated. History is preserved — imports only insert. */
export async function importDatasetRows(
  user: CurrentUser,
  sheets: ParsedSheetJson[]
): Promise<ActionResult<ImportCounts>> {
  try {
    assertCanWrite(user);
    const rejected: Record<string, number> = {};
    const all: DatasetRow[] = [];
    for (const sheet of sheets) {
      const parsed = parseSheet(sheet);
      all.push(...parsed.records);
      for (const [reason, n] of Object.entries(parsed.rejected)) {
        rejected[reason] = (rejected[reason] ?? 0) + n;
      }
    }
    let imported = 0;
    await sql.begin(async (tx) => {
      for (let i = 0; i < all.length; i += 500) {
        const batch = all.slice(i, i + 500);
        const rows = batch.map((r) => ({
          fingerprint: r.fingerprint,
          dataset_name: REALTRENDS_DATASET_NAME,
          entity_type: r.entityType,
          entity_name: r.entityName,
          team_lead: r.teamLead,
          brokerage: r.brokerage,
          city: r.city,
          state: r.state,
          volume_usd: r.volumeUsd,
          sides: r.sides,
          production_year: r.productionYear,
          publication_year: r.publicationYear,
          source_sheet: r.sourceSheet,
          source_row: r.sourceRow,
          created_by: user.id,
        }));
        const inserted = await tx`
          insert into realtrends_records ${tx(rows)}
          on conflict (fingerprint) do nothing
          returning id
        `;
        imported += inserted.length;
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "realtrends.dataset_import",
        entity: "realtrends_records",
        entityId: null,
        detail: { dataset: REALTRENDS_DATASET_NAME, parsed: all.length, imported, rejected },
      });
    });
    return ok({
      parsed: all.length,
      imported,
      duplicates: all.length - imported,
      rejected,
    });
  } catch (err) {
    if (err instanceof ClassifiedError) return fail(err);
    return fail(new ClassifiedError("internal", (err as Error).message));
  }
}

export interface MatchCounts {
  consideredRecords: number;
  highConfidence: number;
  reviewRequired: number;
  conflict: number;
  unmatched: number;
  launchesWithoutState: string[];
}

/**
 * Resolve imported records onto canonical companies, one market at a time.
 * A record is only ever compared against companies ASSOCIATED with a launch
 * whose city+state equal the record's — association via prospects or via
 * benchmark mentions (a tracked competitor without a prospect row still
 * counts; that's the whole point). Operator-resolved rows (confirmed /
 * rejected) are never overwritten.
 */
export async function matchDatasetRecords(
  user: CurrentUser
): Promise<ActionResult<MatchCounts>> {
  try {
    assertCanWrite(user);
    const geos = await launchGeographies();
    const usable = geos.filter((g) => g.state !== null);
    const companyRows = await sql`
      select c.id, c.name, c.aliases,
        coalesce(array_agg(distinct l.prospect_type) filter (where l.prospect_type is not null), '{}') as prospect_types,
        array_agg(distinct l.launch_id) as launch_ids
      from companies c
      join (
        select company_id, launch_id, prospect_type from prospects
        where archived_at is null and company_id is not null
        union
        select m.company_id, p.launch_id, null as prospect_type
        from mentions m
        join responses r on r.id = m.response_id
        join prospect_benchmarks pb on pb.run_id = r.run_id
        join prospects p on p.id = pb.prospect_id
        where p.archived_at is null
      ) l on l.company_id = c.id
      where c.archived_at is null and c.merged_into is null
      group by c.id, c.name, c.aliases
    `;
    const byLaunch = new Map<string, MatchCandidateCompany[]>();
    for (const row of companyRows) {
      const candidate: MatchCandidateCompany = {
        id: row.id as string,
        name: row.name as string,
        aliases: (row.aliases as string[]) ?? [],
        prospectTypes: (row.prospectTypes as string[]) ?? [],
      };
      for (const launchId of (row.launchIds as string[]) ?? []) {
        const list = byLaunch.get(launchId) ?? [];
        list.push(candidate);
        byLaunch.set(launchId, list);
      }
    }
    const counts: MatchCounts = {
      consideredRecords: 0,
      highConfidence: 0,
      reviewRequired: 0,
      conflict: 0,
      unmatched: 0,
      launchesWithoutState: geos.filter((g) => g.state === null).map((g) => g.city),
    };
    await sql.begin(async (tx) => {
      for (const geo of usable) {
        const companies = byLaunch.get(geo.launchId) ?? [];
        if (companies.length === 0) continue;
        const records = await tx`
          select id, entity_name, entity_type from realtrends_records
          where lower(city) = ${geo.city.toLowerCase()} and state = ${geo.state}
            and match_status not in ('confirmed', 'rejected')
        `;
        for (const record of records) {
          counts.consideredRecords += 1;
          const verdict = classifyDatasetMatch(
            {
              entityName: record.entityName as string,
              entityType: record.entityType as "individual" | "team",
            },
            companies
          );
          if (verdict.status === "high_confidence") counts.highConfidence += 1;
          else if (verdict.status === "review_required") counts.reviewRequired += 1;
          else if (verdict.status === "conflict") counts.conflict += 1;
          else counts.unmatched += 1;
          await tx`
            update realtrends_records
            set company_id = ${verdict.companyId},
              match_status = ${verdict.status},
              match_confidence = ${verdict.confidence},
              match_detail = ${tx.json(verdict.detail as never)},
              matched_at = now()
            where id = ${record.id}
          `;
        }
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "realtrends.dataset_match",
        entity: "realtrends_records",
        entityId: null,
        detail: { ...counts },
      });
    });
    return ok(counts);
  } catch (err) {
    if (err instanceof ClassifiedError) return fail(err);
    return fail(new ClassifiedError("internal", (err as Error).message));
  }
}

/** Operator resolution of an ambiguous match. Confirm binds a company (it
 * must have been a listed candidate or is explicitly forced); reject parks
 * the record. Every resolution is audited. */
export async function confirmDatasetMatch(
  user: CurrentUser,
  input: { recordId: string; companyId: string | null }
): Promise<ActionResult<{ recordId: string; status: DatasetMatchStatus }>> {
  try {
    assertCanWrite(user);
    const status: DatasetMatchStatus = input.companyId ? "confirmed" : "rejected";
    await sql.begin(async (tx) => {
      const [record] = await tx`
        select id from realtrends_records where id = ${input.recordId}
      `;
      if (!record) throw new ClassifiedError("not_found", "RealTrends record not found.");
      if (input.companyId) {
        const [company] = await tx`
          select id from companies where id = ${input.companyId} and archived_at is null
        `;
        if (!company) throw new ClassifiedError("not_found", "Company not found.");
      }
      await tx`
        update realtrends_records
        set company_id = ${input.companyId}, match_status = ${status},
          matched_at = now(), matched_by = ${user.id}
        where id = ${input.recordId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "realtrends.match_resolve",
        entity: "realtrends_records",
        entityId: input.recordId,
        detail: { companyId: input.companyId, status },
      });
    });
    return ok({ recordId: input.recordId, status });
  } catch (err) {
    if (err instanceof ClassifiedError) return fail(err);
    return fail(new ClassifiedError("internal", (err as Error).message));
  }
}

/**
 * Verified dataset production per company — the canonical evidence the
 * mismatch engine prefers (licensed dataset beats a hand-captured signal
 * for the same fact). Only high_confidence/confirmed resolutions qualify;
 * a company with both a team and an individual row keeps the team row.
 */
export async function datasetProductionByCompany(
  companyIds: string[],
  db: TransactionSql | typeof sql = sql
): Promise<Map<string, ProductionEvidence>> {
  const out = new Map<string, ProductionEvidence>();
  if (companyIds.length === 0) return out;
  const rows = await db`
    select distinct on (company_id)
      id, company_id, entity_type, entity_name, volume_usd, sides,
      production_year, imported_at
    from realtrends_records
    where company_id = any(${companyIds}::uuid[])
      and match_status in ('high_confidence', 'confirmed')
    order by company_id,
      (match_status = 'confirmed') desc,
      (entity_type = 'team') desc,
      volume_usd desc nulls last
  `;
  for (const r of rows) {
    const volumeUsd = r.volumeUsd === null ? 0 : Number(r.volumeUsd);
    const sides = r.sides === null ? 0 : Math.round(Number(r.sides));
    out.set(r.companyId as string, {
      signalId: r.id as string,
      prospectId: null,
      entityType: r.entityType as "individual" | "team",
      source: "RealTrends verified dataset",
      rank: null,
      rankScope: REALTRENDS_DATASET_NAME,
      scopeComparable: true,
      volumeUsd,
      sides,
      avgPerSideUsd: volumeUsd > 0 && sides > 0 ? Math.round(volumeUsd / sides) : null,
      productionYear: Number(r.productionYear),
      sourceUrl: REALTRENDS_DATASET_SOURCE_REF,
      retrievedOn: new Date(r.importedAt as Date).toISOString().slice(0, 10),
    });
  }
  return out;
}
