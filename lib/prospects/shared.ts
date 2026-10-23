/**
 * Prospect-domain shared internals (split 2026-08-17): the helpers every
 * prospect module leans on — row locking, activity logging, the canonical
 * prospect read, the primary-finding load. Internal to lib/prospects/*;
 * nothing here is a public service API.
 */
import { sql } from "@/db/client";
import type { Sql, TransactionSql } from "@/db/client";
import { ClassifiedError } from "@/lib/errors";
import { detectConflicts, type MarketNode } from "@/lib/exclusivity/detect";
import { loadAgreementInputs } from "@/lib/exclusivity/service";
import {
  isSendReadyProvenance,
  SEND_READY_CONTACT_PROVENANCE,
  todayIso,
  type ConflictStatus,
  type ProspectStage,
} from "@/lib/prospects/constants";

// ---------------------------------------------------------------------------
// Shared helpers

export async function logActivity(
  tx: TransactionSql,
  prospectId: string,
  kind: string,
  detail: Record<string, unknown>,
  actorId: string | null
): Promise<void> {
  await tx`
    insert into prospect_activities (prospect_id, kind, detail, actor_id)
    values (${prospectId}, ${kind}, ${tx.json(detail as never)}, ${actorId})
  `;
}

export interface ProspectRow {
  id: string;
  launchId: string;
  businessName: string;
  companyId: string | null;
  teamLeader: string | null;
  stage: ProspectStage;
  conflictStatus: ConflictStatus;
  doNotContact: boolean;
  brokerageAffiliation: string | null;
  email: string | null;
  phone: string | null;
  archivedAt: Date | null;
}

/** One column list and one not-found/archived rule for the two prospect
 * readers below — a column added to one but not the other is a latent
 * drift bug (simplify pass 2026-08-14). */
const PROSPECT_COLUMNS = sql`id, launch_id, business_name, company_id,
  team_leader, stage, conflict_status, do_not_contact, brokerage_affiliation,
  email, phone, archived_at`;

export function requireProspect(row: ProspectRow | undefined): ProspectRow {
  if (!row || row.archivedAt) {
    throw new ClassifiedError("not_found", "Prospect not found.");
  }
  return row;
}

export async function lockProspect(tx: TransactionSql, prospectId: string): Promise<ProspectRow> {
  const rows = await tx`
    select ${PROSPECT_COLUMNS} from prospects where id = ${prospectId} for update
  `;
  return requireProspect(rows[0] as ProspectRow | undefined);
}

export interface ResolvedRecipient {
  email: string | null;
  phone: string | null;
  /** Provenance of the email the send would actually use — the contact's
   * own when the contact carries the email, else the prospect's
   * field_provenance.email. Null when unknown. */
  emailProvenance: string | null;
  /** Set when the draft's contact cannot be used at all. */
  contactBlocked: string | null;
}

/**
 * The one recipient resolution for every outreach gate (spec 148): approval,
 * schedule, record-sent and transmission read the SAME address and the SAME
 * provenance. A contact that does not belong to this prospect is blocked —
 * another prospect's verified contact can never satisfy this one.
 */
export async function resolveRecipient(
  tx: TransactionSql,
  prospect: ProspectRow,
  contactId: string | null
): Promise<ResolvedRecipient> {
  let email = prospect.email;
  let phone = prospect.phone;
  let emailProvenance: string | null = null;
  if (email) {
    const [row] = await tx`
      select field_provenance->>'email' as provenance from prospects where id = ${prospect.id}
    `;
    emailProvenance = (row?.provenance as string | null) ?? null;
  }
  if (contactId) {
    const [contact] = await tx`
      select prospect_id, name, email, phone, provenance, do_not_contact, archived_at
      from prospect_contacts where id = ${contactId}
    `;
    if (contact && contact.prospectId !== prospect.id) {
      return { email, phone, emailProvenance, contactBlocked: "The draft's contact belongs to a different prospect." };
    }
    if (!contact || contact.archivedAt) {
      return { email, phone, emailProvenance, contactBlocked: "The draft's contact has been removed." };
    }
    if (contact.doNotContact) {
      return { email, phone, emailProvenance, contactBlocked: `Contact "${contact.name}" is flagged do-not-contact.` };
    }
    if (contact.email) {
      email = contact.email as string;
      emailProvenance = (contact.provenance as string | null) ?? null;
    }
    phone = (contact.phone as string | null) ?? phone;
  }
  return { email, phone, emailProvenance, contactBlocked: null };
}

/** Spec 148 verdict: a recipient email must carry send-ready provenance.
 * No email means nothing to be wrong about — the channel's own
 * recipient_email check decides whether one is needed. Fails closed on
 * ai_inferred, estimated, manual, null and any unknown label. */
export function recipientEmailProvenanceVerdict(
  r: Pick<ResolvedRecipient, "email" | "emailProvenance">
): { passed: boolean; detail: string } {
  if (!r.email) return { passed: true, detail: "no recipient email to verify" };
  if (isSendReadyProvenance(r.emailProvenance)) {
    return { passed: true, detail: `recipient email provenance "${r.emailProvenance}"` };
  }
  return {
    passed: false,
    detail: `Verify this contact before sending — the recipient email's provenance is "${r.emailProvenance ?? "unknown"}"; only ${SEND_READY_CONTACT_PROVENANCE.join(" or ")} addresses can be approved or sent.`,
  };
}

/** Non-locking twin of lockProspect for read-only assembly phases that run
 * OUTSIDE a transaction (correctness audit 2026-08-04: reads holding no
 * locks must not pretend to). */
export async function readProspect(prospectId: string): Promise<ProspectRow> {
  const rows = await sql`
    select ${PROSPECT_COLUMNS} from prospects where id = ${prospectId}
  `;
  return requireProspect(rows[0] as ProspectRow | undefined);
}

/**
 * Territory detection for a launch (spec 052, audit 10.7): the stage gate
 * and the send-time re-check are deliberately the SAME policy — this
 * helper is what keeps them from drifting. Agreements load through the
 * exclusivity service's one AgreementInput adapter.
 */
export async function detectLaunchConflicts(
  db: TransactionSql | typeof sql,
  launch: { marketId: string; serviceCategory: string | null; priceSegment: string | null },
  opts: {
    /** Agreements owned by this project do not conflict — the client's own
     * promoted prospect record is not a competitor of the client (spec 131). */
    exceptProjectId?: string | null;
    today?: string;
  } = {}
) {
  const markets = await db<MarketNode[]>`select id, name, parent_id from markets`;
  const agreements = (await loadAgreementInputs()).filter(
    (a) => !opts.exceptProjectId || a.projectId !== opts.exceptProjectId
  );
  return detectConflicts(
    {
      marketId: launch.marketId,
      serviceCategory: launch.serviceCategory ?? null,
      segment: launch.priceSegment ?? null,
    },
    agreements,
    markets,
    opts.today ?? todayIso()
  );
}

/** The launch's market display name — this join was previously inlined
 * three times. Fallback is caller-supplied because the audit page says
 * "your market" while operator surfaces say "the market". */
export async function launchMarketName(
  db: TransactionSql | typeof sql,
  launchId: string,
  fallback = "the market"
): Promise<string> {
  const [row] = await db`
    select m.name as market_name from market_launches l
    join markets m on m.id = l.market_id
    where l.id = ${launchId}
  `;
  return (row?.marketName as string | undefined) ?? fallback;
}


export interface PrimaryFindingRow {
  id: string;
  prospectId: string;
  benchmarkId: string;
  kind: string;
  title: string;
  explanation: string;
  metrics: Record<string, unknown>;
  responseIds: string[];
  competitorCompanyIds: string[];
}

export async function getPrimaryFinding(
  tx: Sql | TransactionSql,
  prospectId: string
): Promise<PrimaryFindingRow> {
  const rows = await tx`
    select id, prospect_id, benchmark_id, kind, title, explanation, metrics,
      response_ids, competitor_company_ids
    from prospect_findings
    where prospect_id = ${prospectId} and is_primary and status = 'approved'
  `;
  const row = rows[0] as unknown as PrimaryFindingRow | undefined;
  if (!row) {
    throw new ClassifiedError(
      "validation",
      "No primary approved finding — review and approve one first."
    );
  }
  return row;
}
