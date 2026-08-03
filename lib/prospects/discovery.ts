/**
 * Prospect discovery flow (spec 041): adapter → candidates → human review →
 * prospect. Candidates carry the full SourceRecord envelope and their raw
 * payload; approval persists through createProspect — the one path — so
 * dedup, audit, and provenance rules cannot fork. Runs execute inline today
 * (the only adapter is the instant mock); a network adapter moves this onto
 * the jobs queue (spec 041, deferral note).
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { getProspectSource } from "@/lib/prospects/providers/registry";
import type { RawProspect, SourceRecord } from "@/lib/prospects/providers/types";
import {
  resolveProspectCompany,
  type CompanyRef,
  type CompanyResolution,
} from "@/lib/prospects/resolve";
import { createProspect, updateProspect } from "@/lib/prospects/service";
import { normalizeEntityName, normalizeDomain } from "@/lib/knowledge/normalize";

const MAX_DISCOVERY_LIMIT = 50;

async function trackedCompanies(): Promise<CompanyRef[]> {
  const rows = await sql`
    select id, name, aliases, domain from companies where archived_at is null
  `;
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    aliases: (r.aliases as string[]) ?? [],
    domain: (r.domain as string | null) ?? null,
  }));
}

export async function runProspectDiscovery(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ runId: string; candidateCount: number }>> {
  const parsed = z
    .object({
      launchId: z.string().uuid(),
      provider: z.string().min(1),
      segment: z.string().trim().max(120).optional(),
      limit: z.number().int().positive().max(MAX_DISCOVERY_LIMIT).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid discovery request."));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const adapter = getProspectSource(input.provider); // throws for guarded mock
    const [launch] = await sql`
      select l.id, m.name as market_name from market_launches l
      join markets m on m.id = l.market_id
      where l.id = ${input.launchId} and l.archived_at is null
    `;
    if (!launch) return fail(new ClassifiedError("not_found", "Launch not found."));

    const [run] = await sql`
      insert into prospect_discovery_runs (launch_id, provider, params, status, started_by)
      values (${input.launchId}, ${input.provider},
        ${sql.json({ segment: input.segment ?? null, limit: input.limit ?? null } as never)},
        'running', ${user.id})
      returning id
    `;
    const runId = run?.id as string;

    let records: SourceRecord<RawProspect>[];
    try {
      records = await adapter.discoverProspects({
        marketName: launch.marketName as string,
        segment: input.segment,
        limit: input.limit,
      });
    } catch (err) {
      // A failed run is recorded as failed, never filled in.
      await sql`
        update prospect_discovery_runs
        set status = 'failed', error = ${err instanceof Error ? err.message : String(err)},
          completed_at = now()
        where id = ${runId}
      `;
      return fail(new ClassifiedError("internal", "The discovery provider failed; the run is recorded as failed."));
    }

    await sql.begin(async (tx) => {
      for (const record of records) {
        await tx`
          insert into prospect_discovery_candidates
            (discovery_run_id, launch_id, business_name, payload, provider,
             source_type, source_url, retrieved_at, confidence, provenance)
          values (${runId}, ${input.launchId}, ${record.data.businessName},
            ${tx.json(record.data as never)}, ${record.provider},
            ${record.sourceType}, ${record.sourceUrl ?? null},
            ${record.retrievedAt}, ${record.confidence}, ${record.provenance})
        `;
      }
      await tx`
        update prospect_discovery_runs
        set status = 'completed', candidate_count = ${records.length}, completed_at = now()
        where id = ${runId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.discovery_run",
        entity: "market_launch",
        entityId: input.launchId,
        detail: { provider: input.provider, candidates: records.length },
      });
    });
    return ok({ runId, candidateCount: records.length });
  } catch (err) {
    return fail(err);
  }
}

export interface DiscoveryCandidateRow {
  id: string;
  launchId: string;
  launchName: string;
  businessName: string;
  payload: RawProspect;
  provider: string;
  sourceType: string;
  sourceUrl: string | null;
  retrievedAt: Date;
  confidence: number;
  provenance: string;
  status: string;
  resolution: CompanyResolution | null;
}

export async function listDiscoveryCandidates(
  options: { launchId?: string; status?: string; limit?: number } = {}
): Promise<DiscoveryCandidateRow[]> {
  const rows = await sql`
    select c.id, c.launch_id, l.name as launch_name, c.business_name, c.payload,
      c.provider, c.source_type, c.source_url, c.retrieved_at, c.confidence,
      c.provenance, c.status, c.resolution
    from prospect_discovery_candidates c
    join market_launches l on l.id = c.launch_id
    where (${options.launchId ?? null}::uuid is null or c.launch_id = ${options.launchId ?? null})
      and (${options.status ?? null}::text is null or c.status = ${options.status ?? null})
    order by (c.status = 'pending') desc, c.created_at desc
    limit ${Math.min(options.limit ?? 50, 200)}
  `;
  return rows.map((r) => ({
    id: r.id as string,
    launchId: r.launchId as string,
    launchName: r.launchName as string,
    businessName: r.businessName as string,
    payload: r.payload as RawProspect,
    provider: r.provider as string,
    sourceType: r.sourceType as string,
    sourceUrl: (r.sourceUrl as string | null) ?? null,
    retrievedAt: r.retrievedAt as Date,
    confidence: Number(r.confidence),
    provenance: r.provenance as string,
    status: r.status as string,
    resolution: (r.resolution as CompanyResolution | null) ?? null,
  }));
}

/**
 * Approve or dismiss a pending candidate. Approval resolves the company
 * (match auto-links; possible stays a suggestion), then persists through
 * createProspect with every populated fact labeled by the record's
 * provenance. A same-name conflict records the candidate as 'duplicate'.
 */
export async function reviewDiscoveryCandidate(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ candidateId: string; outcome: string; prospectId: string | null }>> {
  const parsed = z
    .object({
      candidateId: z.string().uuid(),
      decision: z.enum(["approve", "dismiss"]),
      companyId: z.string().uuid().optional(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid review request."));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const [candidate] = await sql`
      select id, launch_id, business_name, payload, provenance, status
      from prospect_discovery_candidates where id = ${input.candidateId}
    `;
    if (!candidate) return fail(new ClassifiedError("not_found", "Candidate not found."));
    if (candidate.status !== "pending") {
      return fail(new ClassifiedError("conflict", `Candidate is already ${candidate.status}.`));
    }

    if (input.decision === "dismiss") {
      await sql.begin(async (tx) => {
        await tx`
          update prospect_discovery_candidates
          set status = 'dismissed', reviewed_by = ${user.id}, reviewed_at = now()
          where id = ${candidate.id}
        `;
        await writeAudit(tx, {
          userId: user.id,
          action: "prospect.discovery_dismiss",
          entity: "prospect_discovery_candidate",
          entityId: candidate.id as string,
          detail: { businessName: candidate.businessName },
        });
      });
      return ok({ candidateId: candidate.id as string, outcome: "dismissed", prospectId: null });
    }

    const payload = candidate.payload as RawProspect;
    const resolution = resolveProspectCompany(
      {
        businessName: payload.businessName,
        website: payload.website ?? null,
        brokerageAffiliation: payload.brokerageAffiliation ?? null,
        teamLeader: payload.teamLeader ?? null,
      },
      await trackedCompanies()
    );
    const companyId =
      input.companyId ?? (resolution.verdict === "match" ? resolution.companyId : null);

    const provenance = candidate.provenance as string;
    const facts: Record<string, string | undefined> = {
      businessName: payload.businessName,
      brokerageAffiliation: payload.brokerageAffiliation,
      teamLeader: payload.teamLeader,
      website: payload.website,
      email: payload.email,
      phone: payload.phone,
      priceSegment: payload.priceSegment,
    };
    const fieldProvenance = Object.fromEntries(
      Object.entries(facts)
        .filter(([, v]) => v)
        .map(([k]) => [k, provenance])
    );

    const created = await createProspect(user, {
      launchId: candidate.launchId,
      businessName: payload.businessName,
      prospectType: payload.prospectType ?? "team",
      companyId,
      brokerageAffiliation: payload.brokerageAffiliation,
      teamLeader: payload.teamLeader,
      website: payload.website,
      email: payload.email,
      phone: payload.phone,
      neighborhoods: payload.neighborhoods ?? [],
      specialties: payload.specialties ?? [],
      priceSegment: payload.priceSegment,
      source: "research",
      fieldProvenance,
    });

    const outcome = created.ok ? "approved" : created.error.kind === "conflict" ? "duplicate" : null;
    if (outcome === null) return fail(new ClassifiedError("internal", created.ok ? "" : created.error.message));

    await sql.begin(async (tx) => {
      await tx`
        update prospect_discovery_candidates
        set status = ${outcome},
          resolution = ${tx.json(resolution as never)},
          created_prospect_id = ${created.ok ? created.data.prospectId : null},
          reviewed_by = ${user.id}, reviewed_at = now()
        where id = ${candidate.id}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.discovery_review",
        entity: "prospect_discovery_candidate",
        entityId: candidate.id as string,
        detail: {
          outcome,
          resolutionVerdict: resolution.verdict,
          companyId: companyId ?? null,
        },
      });
    });
    return ok({
      candidateId: candidate.id as string,
      outcome,
      prospectId: created.ok ? created.data.prospectId : null,
    });
  } catch (err) {
    return fail(err);
  }
}

/** Company suggestion for a prospect with no canonical link (detail page). */
export async function suggestCompanyForProspect(
  prospectId: string
): Promise<CompanyResolution | null> {
  const [prospect] = await sql`
    select business_name, website, brokerage_affiliation, team_leader, company_id
    from prospects where id = ${prospectId} and archived_at is null
  `;
  if (!prospect || prospect.companyId) return null;
  return resolveProspectCompany(
    {
      businessName: prospect.businessName as string,
      website: (prospect.website as string | null) ?? null,
      brokerageAffiliation: (prospect.brokerageAffiliation as string | null) ?? null,
      teamLeader: (prospect.teamLeader as string | null) ?? null,
    },
    await trackedCompanies()
  );
}

/** Confirm a suggested link — thin wrapper over the audited updateProspect. */
export async function confirmCompanyLink(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ prospectId: string }>> {
  const parsed = z
    .object({ prospectId: z.string().uuid(), companyId: z.string().uuid() })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid link request."));
  }
  return updateProspect(user, parsed.data);
}

export interface ProspectDuplicatePair {
  reason: "same_name" | "same_domain" | "same_company";
  detail: string;
  a: { id: string; businessName: string; launchName: string };
  b: { id: string; businessName: string; launchName: string };
}

/** Cross-launch duplicate candidates: same normalized name, website domain,
 * or canonical company. Read-only — merging is linking both to one company. */
export async function listProspectDuplicates(): Promise<ProspectDuplicatePair[]> {
  const rows = await sql`
    select p.id, p.business_name, p.website, p.company_id, p.launch_id,
      l.name as launch_name
    from prospects p join market_launches l on l.id = p.launch_id
    where p.archived_at is null
  `;
  const prospects = rows.map((r) => ({
    id: r.id as string,
    businessName: r.businessName as string,
    website: (r.website as string | null) ?? null,
    companyId: (r.companyId as string | null) ?? null,
    launchId: r.launchId as string,
    launchName: r.launchName as string,
  }));
  const pairs: ProspectDuplicatePair[] = [];
  const seen = new Set<string>();
  const add = (
    reason: ProspectDuplicatePair["reason"],
    detail: string,
    a: (typeof prospects)[number],
    b: (typeof prospects)[number]
  ) => {
    const key = [reason, ...[a.id, b.id].sort()].join(":");
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({
      reason,
      detail,
      a: { id: a.id, businessName: a.businessName, launchName: a.launchName },
      b: { id: b.id, businessName: b.businessName, launchName: b.launchName },
    });
  };
  for (let i = 0; i < prospects.length; i += 1) {
    for (let j = i + 1; j < prospects.length; j += 1) {
      const a = prospects[i]!;
      const b = prospects[j]!;
      if (a.launchId === b.launchId) continue; // in-launch dedup is the unique index
      if (normalizeEntityName(a.businessName) === normalizeEntityName(b.businessName)) {
        add("same_name", `Both normalize to "${normalizeEntityName(a.businessName)}"`, a, b);
      }
      if (a.website && b.website && normalizeDomain(a.website) === normalizeDomain(b.website)) {
        add("same_domain", `Both use ${normalizeDomain(a.website)}`, a, b);
      }
      if (a.companyId && a.companyId === b.companyId) {
        add("same_company", "Both link to the same canonical company", a, b);
      }
    }
  }
  return pairs;
}
