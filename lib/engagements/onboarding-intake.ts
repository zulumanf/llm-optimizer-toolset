/**
 * Onboarding intake (spec 140): the minimal set of facts a client engagement
 * needs before delivery starts, prefilled from the prospect/company/contact
 * records so the client never retypes what is already verified. Completing
 * the intake writes canonical rows only (engagement fields, market
 * definition, context items) — nothing here starts benchmark work or sends
 * anything.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { addContextItem, confirmMarketDefinition, getEngagement, listContextItems } from "@/lib/engagements/service";

import { ENTITY_TYPES, type EntityType, type OnboardingPrefill } from "@/lib/engagements/constants";
export { ENTITY_TYPES, type EntityType, type OnboardingPrefill };

/** Known facts first: prospect row, canonical company, primary contact. */
export async function onboardingPrefill(engagementId: string): Promise<OnboardingPrefill | null> {
  const e = await getEngagement(engagementId);
  if (!e) return null;
  const [p] = e.prospectId
    ? await sql`
        select p.business_name, p.prospect_type, p.team_leader, p.brokerage_affiliation, p.website, p.email, p.socials,
          c.name as company_name, c.domain, c.aliases
        from prospects p left join companies c on c.id = p.company_id where p.id = ${e.prospectId}`
    : [];
  const [contact] = e.primaryContactId
    ? await sql`select name, email from prospect_contacts where id = ${e.primaryContactId}`
    : e.prospectId
      ? await sql`select name, email from prospect_contacts where prospect_id = ${e.prospectId} and archived_at is null order by is_primary desc, created_at asc limit 1`
      : [];
  const [proj] = await sql`select name from projects where id = ${e.projectId}`;
  const socials = (p?.socials as Record<string, string> | null) ?? {};
  const prefilled: string[] = [];
  const pick = <T,>(key: string, v: T | null | undefined, fallback: T): T => {
    if (v !== null && v !== undefined && v !== "") {
      prefilled.push(key);
      return v;
    }
    return fallback;
  };
  const prospectType = (p?.prospectType as string | undefined) ?? "team";
  const website = (p?.website as string | null) ?? ((p?.domain as string | null) ? `https://${p!.domain as string}` : null);
  return {
    engagementId: e.id,
    legalName: pick("legalName", e.clientLegalName || null, (p?.businessName as string | undefined) ?? (proj?.name as string | undefined) ?? ""),
    brandName: pick("brandName", (p?.companyName as string | null) ?? (p?.businessName as string | null), (proj?.name as string | undefined) ?? ""),
    entityType: pick("entityType", (ENTITY_TYPES as readonly string[]).includes(prospectType) ? (prospectType as EntityType) : null, "team"),
    teamLead: pick("teamLead", (p?.teamLeader as string | null) ?? null, ""),
    brokerage: pick("brokerage", (p?.brokerageAffiliation as string | null) ?? null, ""),
    website: pick("website", website, ""),
    profileUrls: Object.values(socials).filter((u) => typeof u === "string" && u.length > 0),
    primaryContactName: pick("primaryContactName", e.primaryContactName || (contact?.name as string | null) || null, ""),
    contactEmail: pick("contactEmail", (contact?.email as string | null) ?? (p?.email as string | null) ?? null, ""),
    marketName: e.marketName,
    marketDefinition: pick("marketDefinition", e.marketDefinition, ""),
    marketDefinitionConfirmed: Boolean(e.marketDefinitionConfirmedAt),
    aliases: ((p?.aliases as string[] | null) ?? []).filter(Boolean),
    prefilled,
  };
}

/** Fields that must be present before delivery can begin. */
export const INTAKE_REQUIRED_FIELDS = [
  "legalName",
  "brandName",
  "primaryContactName",
  "contactEmail",
  "website",
  "marketDefinition",
  "priorities",
  "websiteControl",
] as const;

const intakeSchema = z.object({
  engagementId: z.string().uuid(),
  legalName: z.string().trim().min(1).max(300),
  brandName: z.string().trim().min(1).max(200),
  entityType: z.enum(ENTITY_TYPES).default("team"),
  teamLead: z.string().trim().max(200).default(""),
  brokerage: z.string().trim().max(200).default(""),
  website: z.string().trim().url().max(500),
  profileUrls: z.array(z.string().trim().url().max(500)).max(20).default([]),
  primaryContactName: z.string().trim().min(1).max(200),
  contactEmail: z.string().trim().email().max(320),
  implementationContact: z.string().trim().max(300).default(""),
  /** Market boundary in words (city vs metro vs county; in / out). */
  marketDefinition: z.string().trim().min(20).max(2000),
  serviceAreaConfirmed: z.boolean().default(true),
  /** At least one client-stated priority (area or focus). */
  priorities: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
  /** Who controls the website/content and whether we get delegated access. */
  websiteControl: z.enum(["client_can_delegate", "client_applies_changes", "third_party_vendor"]),
  weCanChangeDirectly: z.string().trim().max(1000).default(""),
  requiresClientApproval: z.string().trim().max(1000).default(""),
  terminology: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  competitorsConfirmed: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
});
export type OnboardingIntake = z.infer<typeof intakeSchema>;

/** Which required fields an intake draft still lacks (pure). */
export function intakeMissing(draft: Partial<OnboardingIntake>): string[] {
  const missing: string[] = [];
  for (const f of INTAKE_REQUIRED_FIELDS) {
    const v = draft[f as keyof OnboardingIntake];
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) missing.push(f);
  }
  return missing;
}

/**
 * Complete the intake: writes the engagement's legal name and contact,
 * confirms the market definition (once), and records context items with
 * client provenance. Idempotent per item (kind + label); optional fields never
 * block. Does not change stage — "Start onboarding" / "Mark active" remain
 * the gated transitions.
 */
export async function completeOnboardingIntake(user: CurrentUser, raw: unknown): Promise<ActionResult<{ engagementId: string; itemsCreated: number; missing: string[] }>> {
  const parsed = intakeSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    const e = await getEngagement(i.engagementId);
    if (!e) throw new ClassifiedError("not_found", "Engagement not found.");
    if (!(e.stage === "signed" || e.stage === "onboarding")) throw new ClassifiedError("conflict", `Engagement is ${e.stage}; the intake belongs to signing/onboarding.`);
    await sql.begin(async (tx) => {
      await tx`update client_engagements set client_legal_name = ${i.legalName}, primary_contact_name = ${i.primaryContactName}, updated_at = now() where id = ${e.id}`;
      await writeAudit(tx, { userId: user.id, action: "engagement.onboarding_intake", entity: "client_engagement", entityId: e.id, projectId: e.projectId, detail: { legalName: i.legalName, brandName: i.brandName, entityType: i.entityType, websiteControl: i.websiteControl, priorities: i.priorities.length, terminology: i.terminology.length } });
    });
    if (!e.marketDefinitionConfirmedAt) {
      const md = await confirmMarketDefinition(user, { engagementId: e.id, definition: i.marketDefinition });
      if (!md.ok) return md;
    }
    const existing = await listContextItems(e.id);
    const have = (kind: string, label: string) => existing.some((x) => x.kind === kind && x.label.toLowerCase() === label.toLowerCase());
    let created = 0;
    const add = async (item: { kind: string; label: string; provenance: "client_confirmed" | "client_priority"; value?: Record<string, unknown>; accessStatus?: string; sourceRef?: string }) => {
      if (have(item.kind, item.label)) return;
      const r = await addContextItem(user, { engagementId: e.id, ...item });
      if (!r.ok) throw new ClassifiedError("validation", r.error.message);
      created += 1;
    };
    await add({ kind: "identity", label: `${i.brandName} (${i.entityType.replace(/_/g, " ")})`, provenance: "client_confirmed", value: { legalName: i.legalName, entityType: i.entityType, teamLead: i.teamLead || null, brokerage: i.brokerage || null, contactEmail: i.contactEmail } });
    if (i.brokerage) await add({ kind: "identity", label: `Brokerage: ${i.brokerage}`, provenance: "client_confirmed" });
    if (i.teamLead) await add({ kind: "identity", label: `Team lead: ${i.teamLead}`, provenance: "client_confirmed" });
    await add({ kind: "asset", label: i.website, provenance: "client_confirmed", sourceRef: i.website });
    for (const u of i.profileUrls) await add({ kind: "asset", label: u, provenance: "client_confirmed", sourceRef: u });
    for (const p of i.priorities) await add({ kind: "priority_area", label: p, provenance: "client_priority" });
    for (const c of i.competitorsConfirmed) await add({ kind: "competitor", label: c, provenance: "client_confirmed" });
    const accessStatus = i.websiteControl === "client_can_delegate" ? "requested" : i.websiteControl === "client_applies_changes" ? "not_needed" : "requested";
    await add({ kind: "access", label: "Website / content (delegated editor)", provenance: "client_confirmed", accessStatus, value: { control: i.websiteControl, weCanChangeDirectly: i.weCanChangeDirectly || null, requiresClientApproval: i.requiresClientApproval || null, implementationContact: i.implementationContact || null } });
    if (i.terminology.length > 0) await add({ kind: "note", label: `Key terminology: ${i.terminology.join(", ")}`, provenance: "client_confirmed", value: { terminology: i.terminology } });
    return ok({ engagementId: e.id, itemsCreated: created, missing: [] });
  } catch (err) {
    return fail(err);
  }
}
