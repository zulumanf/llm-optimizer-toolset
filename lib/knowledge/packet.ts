/**
 * Evidence packets (spec 018 Phase 2).
 *
 * The rule this module exists to enforce: **an agent never receives the
 * client's whole knowledge base.** It receives a packet assembled for one
 * task — approved claims only, privacy filtered at retrieval time, with the
 * known contradictions and required disclaimers attached.
 *
 * The packet is hashed and stored because reproducing a past agent decision
 * requires knowing exactly what it was shown (PRINCIPLES #2).
 */
import { createHash } from "node:crypto";
import { sql, type TransactionSql } from "@/db/client";
import { selectClaims } from "@/lib/knowledge/context/builder";
import { GENERIC_TEMPLATE } from "@/lib/knowledge/context/templates";

type Tx = TransactionSql | typeof sql;

/** Who the output is for; decides which privacy classes may be included. */
export type PacketAudience = "internal" | "client" | "public";

export const PRIVACY_ORDER = ["public", "client_only", "internal", "restricted"] as const;
export type PrivacyStatus = (typeof PRIVACY_ORDER)[number];

/**
 * Maximum privacy class an audience may see. `restricted` is never included
 * in any packet — restricted facts exist so that a human knows about them, not
 * so that a model can use them.
 */
const AUDIENCE_MAX_PRIVACY: Record<PacketAudience, PrivacyStatus[]> = {
  public: ["public"],
  client: ["public", "client_only"],
  internal: ["public", "client_only", "internal"],
};

export interface PacketClaim {
  id: string;
  key: string;
  text: string;
  value: unknown;
  predicate: string | null;
  category: string;
  asOf: string | null;
  effectiveDate: string | null;
  reviewDate: string | null;
  verificationStatus: string;
  confidence: number | null;
  privacyStatus: PrivacyStatus;
  allowedWording: string[];
  prohibitedWording: string[];
  evidenceIds: string[];
  /** True when review_date has passed — the agent must not state it as current. */
  stale: boolean;
}

export interface PacketSource {
  id: string;
  kind: string;
  note: string;
  url: string | null;
  createdAt: string;
  /** Days since capture — freshness is a fact the agent needs, not a footnote. */
  ageDays: number;
}

export interface PacketContradiction {
  claimId: string;
  severity: string;
  description: string;
  contradictingClaimId: string | null;
  externalSource: string | null;
}

export interface EvidencePacket {
  id: string | null;
  projectId: string;
  purpose: string;
  audience: PacketAudience;
  claims: PacketClaim[];
  sources: PacketSource[];
  contradictions: PacketContradiction[];
  withheldClaimIds: string[];
  requiredDisclaimers: string[];
  methodologyVersion: string | null;
  contentHash: string;
}

export interface BuildPacketInput {
  projectId: string;
  purpose: string;
  audience?: PacketAudience;
  /** Restrict to these claim categories; omit for every approved claim. */
  categories?: string[];
  /** Restrict to specific claim keys. */
  claimKeys?: string[];
  methodologyVersion?: string;
  workflowRunId?: string | null;
  nodeRunId?: string | null;
}

const STALE_DISCLAIMER =
  "One or more claims are past their review date and are stated as of their recorded date, not as current fact.";
const CONTRADICTION_DISCLAIMER =
  "An unresolved contradiction exists in the supporting facts; do not assert the disputed point.";
const NO_CLAIMS_DISCLAIMER =
  "No approved client facts were available for this task. Do not invent any.";

/**
 * Assemble the packet. Reads only APPROVED claims — a proposed or rejected
 * claim is not a fact the platform is allowed to believe.
 *
 * Since spec 022 this **delegates its claim selection** to
 * `lib/knowledge/context/builder.ts#selectClaims`, so privacy filtering,
 * freshness assessment and category rules have one implementation in this
 * codebase rather than two that can drift (CLAUDE.md: no duplicated logic).
 * What remains here is the legacy packet's own shape and rendering, which
 * several workflow templates still consume.
 */
export async function buildEvidencePacket(
  input: BuildPacketInput
): Promise<EvidencePacket> {
  const audience = input.audience ?? "internal";
  const allowed = AUDIENCE_MAX_PRIVACY[audience];

  const today = new Date();
  const { claims: selected, withheld } = await selectClaims({
    projectId: input.projectId,
    // A synthetic template that reproduces the legacy contract exactly:
    // audience-based privacy, every category, and no freshness exclusion —
    // this packet has always *disclosed* staleness rather than dropping it.
    template: {
      ...GENERIC_TEMPLATE,
      audience,
      allowedPrivacy: allowed,
      minFreshness: "unknown",
    },
    categories: input.categories ?? [],
    claimKeys: input.claimKeys,
    now: today,
  });

  const claims: PacketClaim[] = selected.map((claim) => ({
    id: claim.id,
    key: claim.key,
    text: claim.text,
    value: claim.value,
    predicate: claim.predicate,
    category: claim.category,
    asOf: claim.asOf,
    effectiveDate: claim.effectiveDate,
    reviewDate: claim.reviewDate,
    verificationStatus: claim.verificationStatus,
    confidence: claim.confidence,
    privacyStatus: claim.privacyStatus,
    allowedWording: claim.allowedWording,
    prohibitedWording: claim.prohibitedWording,
    evidenceIds: claim.evidenceIds,
    // The legacy field means "past its review date". The richer freshness model
    // is a superset, so it is derived rather than recomputed.
    stale: claim.freshness === "stale" || claim.freshness === "expired",
  }));

  const evidenceIds = [...new Set(claims.flatMap((c) => c.evidenceIds))];
  const sources: PacketSource[] = [];
  if (evidenceIds.length > 0) {
    const evidenceRows = await sql`
      select id, kind, note, url, created_at from evidence where id = any(${evidenceIds})
    `;
    for (const row of evidenceRows) {
      const createdAt = row.createdAt as Date;
      sources.push({
        id: row.id as string,
        kind: row.kind as string,
        note: row.note as string,
        url: (row.url as string | null) ?? null,
        createdAt: createdAt.toISOString(),
        ageDays: Math.floor((today.getTime() - createdAt.getTime()) / 86_400_000),
      });
    }
  }

  const claimIds = claims.map((c) => c.id);
  const contradictions: PacketContradiction[] = [];
  if (claimIds.length > 0) {
    const rows2 = await sql`
      select claim_id, severity, description, contradicting_claim_id, external_source
      from claim_contradictions
      where project_id = ${input.projectId} and status = 'open'
        and claim_id = any(${claimIds})
    `;
    for (const row of rows2) {
      contradictions.push({
        claimId: row.claimId as string,
        severity: row.severity as string,
        description: row.description as string,
        contradictingClaimId: (row.contradictingClaimId as string | null) ?? null,
        externalSource: (row.externalSource as string | null) ?? null,
      });
    }
  }

  const disclaimers: string[] = [];
  if (claims.some((c) => c.stale)) disclaimers.push(STALE_DISCLAIMER);
  if (contradictions.length > 0) disclaimers.push(CONTRADICTION_DISCLAIMER);
  if (claims.length === 0) disclaimers.push(NO_CLAIMS_DISCLAIMER);

  const content = {
    purpose: input.purpose,
    audience,
    claims,
    sources,
    contradictions,
    requiredDisclaimers: disclaimers,
    methodologyVersion: input.methodologyVersion ?? null,
  };
  const contentHash = createHash("sha256").update(JSON.stringify(content)).digest("hex");

  return {
    id: null,
    projectId: input.projectId,
    purpose: input.purpose,
    audience,
    claims,
    sources,
    contradictions,
    withheldClaimIds: withheld,
    requiredDisclaimers: disclaimers,
    methodologyVersion: input.methodologyVersion ?? null,
    contentHash,
  };
}

/** Persist the packet so the agent's inputs stay reproducible. */
export async function recordPacket(
  tx: Tx,
  packet: EvidencePacket,
  refs: { workflowRunId?: string | null; nodeRunId?: string | null }
): Promise<string> {
  const [row] = await tx`
    insert into evidence_packets (
      project_id, workflow_run_id, node_run_id, purpose, claim_ids, evidence_ids,
      withheld_claim_ids, contradictions, required_disclaimers, methodology_version,
      content, content_hash
    ) values (
      ${packet.projectId}, ${refs.workflowRunId ?? null}, ${refs.nodeRunId ?? null},
      ${packet.purpose}, ${packet.claims.map((c) => c.id)},
      ${packet.sources.map((s) => s.id)}, ${packet.withheldClaimIds},
      ${tx.json(packet.contradictions as never)}, ${packet.requiredDisclaimers},
      ${packet.methodologyVersion}, ${tx.json({
        claims: packet.claims,
        sources: packet.sources,
        audience: packet.audience,
      } as never)},
      ${packet.contentHash}
    )
    returning id
  `;
  return row!.id as string;
}

/**
 * Render the packet as the text an agent actually sees. Deliberately terse and
 * explicit: allowed wording, prohibited wording, and staleness are stated per
 * claim so a drafting agent has no excuse for inventing phrasing.
 */
export function renderPacket(packet: EvidencePacket): string {
  const lines: string[] = [`# Approved client facts (purpose: ${packet.purpose})`];
  if (packet.claims.length === 0) {
    lines.push("(none — you must not state any client fact in this task)");
  }
  for (const claim of packet.claims) {
    lines.push(`- [${claim.id}] ${claim.text}`);
    const meta: string[] = [];
    if (claim.asOf) meta.push(`as of ${claim.asOf}`);
    if (claim.stale) meta.push("PAST REVIEW DATE — state as historical, not current");
    if (claim.verificationStatus !== "verified") meta.push(`verification: ${claim.verificationStatus}`);
    if (claim.allowedWording.length > 0) meta.push(`use wording: ${claim.allowedWording.join(" | ")}`);
    if (claim.prohibitedWording.length > 0) meta.push(`never say: ${claim.prohibitedWording.join(" | ")}`);
    if (meta.length > 0) lines.push(`  (${meta.join("; ")})`);
  }
  if (packet.contradictions.length > 0) {
    lines.push("", "# Unresolved contradictions — do not assert these points");
    for (const c of packet.contradictions) {
      lines.push(`- [${c.severity}] ${c.description}`);
    }
  }
  if (packet.sources.length > 0) {
    lines.push("", "# Sources");
    for (const s of packet.sources) {
      lines.push(`- [${s.id}] ${s.note}${s.url ? ` (${s.url})` : ""} — ${s.ageDays}d old`);
    }
  }
  if (packet.requiredDisclaimers.length > 0) {
    lines.push("", "# Required disclaimers");
    for (const d of packet.requiredDisclaimers) lines.push(`- ${d}`);
  }
  return lines.join("\n");
}
