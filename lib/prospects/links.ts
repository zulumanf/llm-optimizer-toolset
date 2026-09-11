/**
 * Branded audit links (spec 076): /audit/<slug>/<key>.
 *
 * The slug is cosmetic — the prospect's name, kebab-cased, so the first
 * thing a recipient reads is themselves. The key is the credential: 16
 * base64url characters (96 bits), globally unique, resolving to the
 * prospect's CURRENT published audit through the same getAuditByToken path
 * as legacy links (one implementation of "show an audit", two front doors).
 * A wrong slug with a valid key redirects to the canonical slug; a valid
 * slug with a wrong key grants nothing.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { sql } from "@/db/client";
import type { Sql, TransactionSql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";

/** 12 random bytes → 16 base64url chars ≈ 96 bits. Short enough to read as
 * deliberate, long enough that online guessing is infeasible. */
const KEY_BYTES = 12;
const SLUG_MAX = 80;

/** Kebab-case a business name for the URL. Pure; known-answer tested. */
export function slugifyBusinessName(name: string): string {
  const slug = name
    .normalize("NFKD")
    // Strip diacritics: é → e, not é → -.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "audit";
}

export function newLinkKey(): string {
  return randomBytes(KEY_BYTES).toString("base64url");
}

/** Smallest human-readable disambiguation (spec 134): base, base-<market>,
 * then base-2, base-3 … Pure; known-answer tested. */
export function disambiguateSlug(base: string, marketSlug: string | null, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  if (marketSlug && marketSlug !== base) {
    const withMarket = `${base}-${marketSlug}`.slice(0, SLUG_MAX).replace(/-+$/g, "");
    if (!taken.has(withMarket)) return withMarket;
  }
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${randomBytes(3).toString("hex")}`;
}

/**
 * The prospect's clean report slug (prospects.report_slug), assigned once and
 * never changed: the URL a prospect has seen must keep working. Presentation
 * only — the audit's identity is its id/token, never the slug.
 */
export async function ensureReportSlug(
  tx: Sql | TransactionSql,
  prospectId: string,
  businessName: string
): Promise<string> {
  const [p] = await tx`
    select p.report_slug, m.name as market_name from prospects p
    join market_launches ml on ml.id = p.launch_id
    join markets m on m.id = ml.market_id
    where p.id = ${prospectId}`;
  if (p?.reportSlug) return p.reportSlug as string;
  const base = slugifyBusinessName(businessName);
  const marketSlug = p?.marketName ? slugifyBusinessName(String(p.marketName).split(",")[0] ?? "") : null;
  const rows = await tx`select report_slug from prospects where report_slug like ${`${base}%`}`;
  const taken = new Set(rows.map((r) => r.reportSlug as string));
  const slug = disambiguateSlug(base, marketSlug, taken);
  await tx`update prospects set report_slug = ${slug} where id = ${prospectId} and report_slug is null`;
  const [after] = await tx`select report_slug from prospects where id = ${prospectId}`;
  return (after?.reportSlug as string | null) ?? slug;
}

export interface AuditLink {
  slug: string;
  key: string;
}

/** The prospect's active branded link, or null. */
export async function auditLinkForProspect(
  prospectId: string,
  tx: Sql | TransactionSql = sql
): Promise<AuditLink | null> {
  const [row] = await tx`
    select slug, key from prospect_audit_links
    where prospect_id = ${prospectId} and revoked_at is null
  `;
  return row ? { slug: row.slug as string, key: row.key as string } : null;
}

/**
 * Resolve a branded key to the underlying legacy token. Returns null for
 * unknown/revoked keys and for prospects with no currently-published audit
 * (revoked or expired-and-not-republished) — the branded route then 404s
 * exactly like a bad legacy token.
 */
export async function resolveAuditLink(
  key: string
): Promise<{ token: string; canonicalSlug: string } | null> {
  // Length guard: not security (uniqueness is), just an early exit that
  // keeps obviously-legacy 43-char tokens off this code path.
  if (key.length < 8 || key.length > 32) return null;
  const [row] = await sql`
    select l.slug, a.access_token
    from prospect_audit_links l
    join prospect_audits a
      on a.prospect_id = l.prospect_id and a.status = 'published'
    where l.key = ${key} and l.revoked_at is null
  `;
  if (!row?.accessToken) return null;
  return { token: row.accessToken as string, canonicalSlug: row.slug as string };
}

/**
 * Mint (or re-mint) the branded link for a prospect with a published audit.
 * Re-minting revokes the prior link — one live branded credential per
 * prospect, always.
 */
export async function mintAuditLink(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ slug: string; key: string }>> {
  const parsed = z.object({ prospectId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid prospect id."));
  }
  const { prospectId } = parsed.data;
  try {
    assertCanWrite(user);
    const result = await sql.begin(async (tx) => {
      const [prospect] = await tx`
        select business_name from prospects
        where id = ${prospectId} and archived_at is null
      `;
      if (!prospect) throw new ClassifiedError("not_found", "Prospect not found.");
      const [published] = await tx`
        select 1 from prospect_audits
        where prospect_id = ${prospectId} and status = 'published'
      `;
      if (!published) {
        throw new ClassifiedError(
          "validation",
          "No published audit — publish first, then mint the branded link."
        );
      }
      await tx`
        update prospect_audit_links set revoked_at = now()
        where prospect_id = ${prospectId} and revoked_at is null
      `;
      const slug = await ensureReportSlug(tx, prospectId, prospect.businessName as string);
      const key = newLinkKey();
      await tx`
        insert into prospect_audit_links (prospect_id, slug, key, created_by)
        values (${prospectId}, ${slug}, ${key}, ${user.id})
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.audit_link_mint",
        entity: "prospect",
        entityId: prospectId,
        detail: { slug },
      });
      return { slug, key };
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}

/**
 * Auto-mint on first publication (called from publishAudit, isolated there
 * so a mint failure never fails a publish). System-context variant without
 * the ActionResult wrapper; same rules.
 */
export async function ensureAuditLink(
  tx: TransactionSql,
  userId: string | null,
  prospectId: string,
  businessName: string
): Promise<void> {
  const [existing] = await tx`
    select 1 from prospect_audit_links
    where prospect_id = ${prospectId} and revoked_at is null
  `;
  if (existing) return;
  const slug = await ensureReportSlug(tx, prospectId, businessName);
  await tx`
    insert into prospect_audit_links (prospect_id, slug, key, created_by)
    values (${prospectId}, ${slug}, ${newLinkKey()}, ${userId})
  `;
}

/** Burn the prospect's active branded links (rides revokeAudit's
 * transaction): a burned audit must be unreachable under BOTH formats, and
 * a later republish must not resurrect the old branded key. */
export async function revokeAuditLinks(
  tx: TransactionSql,
  prospectId: string
): Promise<void> {
  await tx`
    update prospect_audit_links set revoked_at = now()
    where prospect_id = ${prospectId} and revoked_at is null
  `;
}
