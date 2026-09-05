/**
 * Verified lead-agent aliases (spec 130). A team company is credited when a
 * captured answer names the team's lead agent ONLY through a relationship
 * the licensed RealTrends record states (`realtrends_records.team_lead` on
 * a high-confidence/confirmed match). Aliases are derived deterministically
 * from that record — never from name similarity, never inferred at parse
 * time — and written through the registry's collision-checked path. The
 * same relationship becomes an identity fact for the mention classifier so
 * "Ryan Ogle" is judged the same entity as "Blu House Properties" instead
 * of "a person, not the company" (the 2026-09-05 undercount).
 */
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { upsertCompany } from "@/lib/companies/service";
import type { CurrentUser } from "@/lib/auth";

export const ENTITY_REVIEW_REQUIRED = "ENTITY_REVIEW_REQUIRED" as const;

const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
const LEADERSHIP_ROLE = /\b(owner|team lead(er)?|founder|principal|broker|lead|ceo|president)\b/i;

export interface LeadAgentRelationship {
  companyId: string;
  companyName: string;
  existingAliases: string[];
  /** RealTrends entity level of the matched record; null when unmatched. */
  entityType: "individual" | "team" | null;
  teamLead: string | null;
  realtrendsRecordId: string | null;
  productionYear: number | null;
  /** Primary leadership contact of a prospect linked to this company. */
  contactName: string | null;
  contactId: string | null;
}

export type AliasDerivation =
  | { status: "aliases"; aliases: string[]; provenance: { realtrendsRecordId: string; teamLead: string; contactId: string | null } }
  | { status: "none"; reason: string }
  | { status: typeof ENTITY_REVIEW_REQUIRED; reason: string };

function nameTokens(name: string): string[] {
  return name
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .filter((t) => !NAME_SUFFIXES.has(t.toLowerCase()));
}

/** "First Last" with middle names/initials and generational suffixes dropped;
 * null when fewer than two name tokens remain. */
export function firstLastName(name: string): string | null {
  const tokens = nameTokens(name);
  if (tokens.length < 2) return null;
  return `${tokens[0]} ${tokens[tokens.length - 1]}`;
}

function lastName(name: string): string | null {
  const tokens = nameTokens(name);
  return tokens.length >= 2 ? tokens[tokens.length - 1]!.toLowerCase() : null;
}

/**
 * Pure derivation. Only a RealTrends TEAM record with a multi-token team
 * lead yields aliases; individuals and brokerages get none (agent, team and
 * brokerage stay distinct entities); a single-token lead is ambiguous and
 * goes to review.
 */
export function deriveLeadAgentAliases(rel: LeadAgentRelationship): AliasDerivation {
  if (!rel.realtrendsRecordId || !rel.entityType) {
    return { status: "none", reason: "no verified RealTrends record linked to this company" };
  }
  if (rel.entityType !== "team") {
    return { status: "none", reason: `RealTrends entity level is "${rel.entityType}"; person aliases apply to teams only` };
  }
  if (!rel.teamLead || rel.teamLead.trim().length === 0) {
    return { status: ENTITY_REVIEW_REQUIRED, reason: "team record has no team lead on file" };
  }
  const full = nameTokens(rel.teamLead).join(" ");
  const firstLast = firstLastName(rel.teamLead);
  if (!firstLast) {
    return { status: ENTITY_REVIEW_REQUIRED, reason: `team lead "${rel.teamLead}" is a single name; cannot be an alias safely` };
  }
  const candidates = [full, firstLast];
  if (rel.contactName) {
    const contactFirstLast = firstLastName(rel.contactName);
    const sameFamily = contactFirstLast && lastName(rel.contactName) === lastName(rel.teamLead);
    if (contactFirstLast && sameFamily) candidates.push(contactFirstLast);
  }
  const seen = new Set<string>([rel.companyName.toLowerCase(), ...rel.existingAliases.map((a) => a.toLowerCase())]);
  const aliases: string[] = [];
  for (const c of candidates) {
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(c);
  }
  if (aliases.length === 0) {
    return { status: "none", reason: "team lead already covered by the company name or existing aliases" };
  }
  return {
    status: "aliases",
    aliases,
    provenance: { realtrendsRecordId: rel.realtrendsRecordId, teamLead: rel.teamLead, contactId: rel.contactId },
  };
}

/** One approved-fact line per team company for the classifier's identity
 * block. The relationship is stated as data; the prompt template is
 * unchanged, so the classifier version stays `mention-classifier-v2`. */
export function identityFactFor(rel: LeadAgentRelationship): string | null {
  const d = deriveLeadAgentAliases(rel);
  if (d.status !== "aliases" && !(d.status === "none" && rel.entityType === "team" && rel.teamLead)) return null;
  const lead = firstLastName(rel.teamLead ?? "") ?? rel.teamLead;
  if (!lead) return null;
  const year = rel.productionYear ? ` ${rel.productionYear}` : "";
  return `Real-estate team led by ${lead} (RealTrends${year}, licensed dataset record). An answer that names ${lead} as an agent refers to this team.`;
}

/** Relationships for a set of companies, read from the licensed dataset and
 * the primary leadership contact of any prospect linked to the company. */
export async function leadAgentRelationships(companyIds: string[]): Promise<LeadAgentRelationship[]> {
  if (companyIds.length === 0) return [];
  const rows = await sql`
    select c.id, c.name, c.aliases,
      rr.id as rt_id, rr.entity_type, rr.team_lead, rr.production_year,
      pc.id as contact_id, pc.name as contact_name, pc.role as contact_role
    from companies c
    left join lateral (
      select id, entity_type, team_lead, production_year from realtrends_records r
      where r.company_id = c.id and r.match_status in ('high_confidence', 'confirmed')
      order by production_year desc nulls last, matched_at desc nulls last limit 1
    ) rr on true
    left join lateral (
      select pc.id, pc.name, pc.role from prospect_contacts pc
      join prospects p on p.id = pc.prospect_id
      where p.company_id = c.id and p.archived_at is null and pc.archived_at is null and pc.is_primary
      order by pc.created_at asc limit 1
    ) pc on true
    where c.id = any(${companyIds}::uuid[]) and c.archived_at is null
  `;
  return rows.map((r) => {
    const role = (r.contactRole as string | null) ?? "";
    const leadership = LEADERSHIP_ROLE.test(role);
    return {
      companyId: r.id as string,
      companyName: r.name as string,
      existingAliases: (r.aliases as string[]) ?? [],
      entityType: (r.entityType as "individual" | "team" | null) ?? null,
      teamLead: (r.teamLead as string | null) ?? null,
      realtrendsRecordId: (r.rtId as string | null) ?? null,
      productionYear: r.productionYear === null || r.productionYear === undefined ? null : Number(r.productionYear),
      contactName: leadership ? ((r.contactName as string | null) ?? null) : null,
      contactId: leadership ? ((r.contactId as string | null) ?? null) : null,
    };
  });
}

/** Identity facts keyed by company id for `classifyResponseLlm`'s
 * identityContext. Companies without a verified team relationship get none. */
export async function identityFactsFor(companyIds: string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const rel of await leadAgentRelationships(companyIds)) {
    const fact = identityFactFor(rel);
    if (fact) out[rel.companyId] = [fact];
  }
  return out;
}

export interface ApplyAliasResult {
  companyId: string;
  companyName: string;
  derivation: AliasDerivation;
  /** Aliases newly written (empty when nothing changed or refused). */
  added: string[];
  /** Collision or registry refusal text, when the write was refused. */
  refused: string | null;
}

/** Write derived aliases through the registry (collision-checked, audited
 * with provenance). Never removes an alias; a refusal becomes review. */
export async function applyVerifiedAliases(user: CurrentUser, companyId: string): Promise<ApplyAliasResult> {
  const [rel] = await leadAgentRelationships([companyId]);
  if (!rel) throw new Error(`Company ${companyId} not found.`);
  const derivation = deriveLeadAgentAliases(rel);
  const base = { companyId, companyName: rel.companyName, derivation, added: [] as string[], refused: null as string | null };
  if (derivation.status !== "aliases") return base;
  const [c] = await sql`select name, aliases, domain, market_id from companies where id = ${companyId}`;
  if (!c) throw new Error(`Company ${companyId} not found.`);
  const merged = [...((c.aliases as string[]) ?? []), ...derivation.aliases];
  const res = await upsertCompany(user, {
    id: companyId,
    name: c.name as string,
    aliases: merged,
    ...(c.domain ? { domain: c.domain as string } : {}),
    marketId: (c.marketId as string | null) ?? null,
  });
  if (!res.ok) {
    return { ...base, derivation: { status: ENTITY_REVIEW_REQUIRED, reason: res.error.message }, refused: res.error.message };
  }
  await sql.begin(async (tx) => {
    await writeAudit(tx, {
      userId: user.id,
      action: "company.alias_verified",
      entity: "company",
      entityId: companyId,
      detail: { aliases: derivation.aliases, provenance: derivation.provenance, spec: 130 },
    });
  });
  return { ...base, added: derivation.aliases };
}
