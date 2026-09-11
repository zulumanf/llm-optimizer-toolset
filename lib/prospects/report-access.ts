/**
 * Private report access (spec 134): invitation → authorized session → clean
 * URL. The invitation is the existing branded key (or a legacy audit token);
 * the session is a random 256-bit token held in an HttpOnly cookie and stored
 * only as a SHA-256 hash; the clean URL is /report/<slug>, which renders for
 * a valid session of THAT prospect and nothing else. No password, no
 * fingerprint: a "device" is simply an independently authorized browser.
 */
import { createHash, randomBytes } from "node:crypto";
import { sql } from "@/db/client";
import type { Sql, TransactionSql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { logActivity } from "@/lib/prospects/shared";
import { ensureAuditLink, ensureReportSlug, revokeAuditLinks } from "@/lib/prospects/links";
import { REPORT_DELIVERY_TEMPLATE_VERSION } from "@/lib/prospects/constants";
import { z } from "zod";

/** Independently authorized browsers one invitation may activate. Env
 * REPORT_SESSION_ALLOWANCE sets the default for newly minted links; the
 * per-link column (prospect_audit_links.session_allowance) wins. */
export const DEFAULT_SESSION_ALLOWANCE = 5;
/** Days an activated session stays valid. */
export const DEFAULT_SESSION_TTL_DAYS = 30;
/** A session that never reaches the report (mail scanner following the
 * redirect without cookies) evaporates this fast and never counts. */
export const PENDING_SESSION_MINUTES = 15;
/** Session cookie: one per report slug so two reports in one browser never
 * collide and one cookie is never sent to another report's path. */
export const SESSION_COOKIE_PREFIX = "rfr_";
const SESSION_TOKEN_BYTES = 32;
const LEGACY_TOKEN_MIN = 33;
const KEY_MIN = 8;
const KEY_MAX = 100;
const LAST_SEEN_THROTTLE_MINUTES = 5;
/** Sub-pages the exchange may land on. */
export const REPORT_NEXT = ["answers", "walkthrough"] as const;
export type ReportNext = (typeof REPORT_NEXT)[number];

/** Script/bot user agents that must never activate a session (mirrors the
 * dashboard's human-view filter). Empty and bare "Mozilla/5.0" agents count
 * as scanners too (spec 099 open-signal classes). */
export const SCANNER_UA_PATTERN =
  "(curl|wget|python|node|undici|go-http|okhttp|bot|crawler|spider|headless|monitor|preview|slack|facebookexternalhit|whatsapp|telegram|claude|chatgpt|openai|anthropic|perplexity|gptbot|linkcheck|httpclient|java/|axios)";
export const SCANNER_UA = new RegExp(SCANNER_UA_PATTERN, "i");

export function isScannerUserAgent(ua: string | null | undefined): boolean {
  const s = (ua ?? "").trim();
  return s === "" || s === "Mozilla/5.0" || SCANNER_UA.test(s);
}

export function sessionAllowanceDefault(): number {
  const n = Number(process.env.REPORT_SESSION_ALLOWANCE);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SESSION_ALLOWANCE;
}

export function sessionTtlDays(): number {
  const n = Number(process.env.REPORT_SESSION_TTL_DAYS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SESSION_TTL_DAYS;
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

export function sessionCookieName(slug: string): string {
  return `${SESSION_COOKIE_PREFIX}${slug}`;
}

/** Session cookie values the browser presented. With a slug, only cookies
 * whose slug prefixes it (cookie paths prefix-match, so the browser sends
 * those); without one — the exchange, where the slug is not yet known —
 * every rfr_* cookie. Each value is verified against the resolved prospect
 * by hash, so over-presenting can never grant anything. */
export function presentedTokensFromCookies(
  cookieList: ReadonlyArray<{ name: string; value: string }>,
  slug: string | null
): string[] {
  return cookieList
    .filter((c) => c.name.startsWith(SESSION_COOKIE_PREFIX))
    .filter((c) => slug === null || slug.startsWith(c.name.slice(SESSION_COOKIE_PREFIX.length)))
    .map((c) => c.value);
}

/** Slug segment as it may appear in a URL: lowercase, URL-safe, bounded. */
export function isReportSlug(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(value);
}

export function parseReportNext(value: string | null | undefined): ReportNext | null {
  return (REPORT_NEXT as readonly string[]).includes(value ?? "") ? (value as ReportNext) : null;
}

export function operatorIps(): string[] {
  return (process.env.INTERNAL_VIEW_IPS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
}

export interface ResolvedInvitation {
  prospectId: string;
  auditId: string;
  accessToken: string;
  linkId: string;
  slug: string;
  allowance: number;
}

/**
 * Resolve an invitation credential — a branded key or a legacy audit token —
 * to the prospect's CURRENT published, unexpired audit. Unknown, revoked and
 * expired credentials are indistinguishable (null). A legacy token is
 * attributed to the prospect's active branded link (minting one if a
 * pre-076 prospect has none) so the allowance is one number per prospect.
 */
export async function resolveInvitation(credential: string): Promise<ResolvedInvitation | null> {
  if (credential.length < KEY_MIN || credential.length > KEY_MAX) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(credential)) return null;
  const isLegacy = credential.length >= LEGACY_TOKEN_MIN;
  const rows = isLegacy
    ? await sql`
        select a.id as audit_id, a.prospect_id, a.access_token, p.business_name, p.report_slug
        from prospect_audits a join prospects p on p.id = a.prospect_id
        where a.access_token = ${credential} and a.status = 'published'
          and (a.expires_at is null or a.expires_at > now()) and p.archived_at is null`
    : await sql`
        select a.id as audit_id, a.prospect_id, a.access_token, p.business_name, p.report_slug
        from prospect_audit_links l
        join prospect_audits a on a.prospect_id = l.prospect_id and a.status = 'published'
        join prospects p on p.id = a.prospect_id
        where l.key = ${credential} and l.revoked_at is null
          and (a.expires_at is null or a.expires_at > now()) and p.archived_at is null`;
  const row = rows[0];
  if (!row) return null;
  const prospectId = row.prospectId as string;
  return sql.begin(async (tx) => {
    const slug = (row.reportSlug as string | null) ?? (await ensureReportSlug(tx, prospectId, row.businessName as string));
    let [link] = await tx`
      select id, session_allowance from prospect_audit_links
      where prospect_id = ${prospectId} and revoked_at is null`;
    if (!link) {
      await ensureAuditLink(tx, null, prospectId, row.businessName as string);
      [link] = await tx`
        select id, session_allowance from prospect_audit_links
        where prospect_id = ${prospectId} and revoked_at is null`;
    }
    if (!link) return null;
    return {
      prospectId,
      auditId: row.auditId as string,
      accessToken: row.accessToken as string,
      linkId: link.id as string,
      slug,
      allowance: Number(link.sessionAllowance),
    };
  });
}

export interface ExchangeMeta {
  ip: string | null;
  userAgent: string | null;
  /** A signed-in staff member is exchanging — the session is internal. */
  staff: boolean;
  /** Session tokens the browser already presented for this slug (cookie
   * values) — a repeat click must reuse, never spend another activation. */
  presentedTokens: string[];
}

export type ExchangeResult =
  | { kind: "granted"; slug: string; sessionToken: string | null; reused: boolean }
  | { kind: "scanner"; slug: string }
  | { kind: "limit"; slug: string }
  | { kind: "invalid" };

/** Log one access event (insert-only ledger). */
async function recordEvent(
  tx: Sql | TransactionSql,
  e: {
    prospectId: string;
    auditId?: string | null;
    linkId?: string | null;
    sessionId?: string | null;
    kind: "invitation_opened" | "access_granted" | "session_created" | "access_refused";
    internal: boolean;
    detail?: Record<string, unknown>;
  }
): Promise<void> {
  await tx`
    insert into prospect_report_access_events
      (prospect_id, audit_id, link_id, session_id, kind, is_internal, detail)
    values (${e.prospectId}, ${e.auditId ?? null}, ${e.linkId ?? null}, ${e.sessionId ?? null},
      ${e.kind}, ${e.internal}, ${tx.json((e.detail ?? {}) as never)})`;
}

/** Count of sessions that reached the report and are still valid. */
async function usedSessionCount(tx: TransactionSql, linkId: string): Promise<number> {
  const [r] = await tx`
    select count(*)::int as n from prospect_report_sessions
    where link_id = ${linkId} and revoked_at is null and expires_at > now()
      and first_used_at is not null and not is_internal`;
  return Number(r?.n ?? 0);
}

/**
 * The credential exchange. Validates the invitation and the audit, refuses
 * scanners and over-allowance activations, reuses a session the browser
 * already holds, otherwise mints one (pending until first use). Every
 * outcome that names a prospect is logged.
 */
export async function exchangeInvitation(credential: string, meta: ExchangeMeta): Promise<ExchangeResult> {
  const inv = await resolveInvitation(credential);
  if (!inv) return { kind: "invalid" };
  const internal = meta.staff || (meta.ip != null && operatorIps().includes(meta.ip));
  const base = { prospectId: inv.prospectId, auditId: inv.auditId, linkId: inv.linkId, internal };
  const existing = await findSessionForProspect(inv.prospectId, meta.presentedTokens);
  return sql.begin(async (tx) => {
    await recordEvent(tx, { ...base, kind: "invitation_opened", detail: { legacy: credential.length >= LEGACY_TOKEN_MIN } });
    if (existing) {
      await recordEvent(tx, { ...base, sessionId: existing.id, kind: "access_granted", detail: { reused: true } });
      return { kind: "granted", slug: inv.slug, sessionToken: null, reused: true };
    }
    if (isScannerUserAgent(meta.userAgent)) {
      await recordEvent(tx, { ...base, kind: "access_refused", detail: { reason: "scanner", userAgent: meta.userAgent?.slice(0, 200) ?? null } });
      return { kind: "scanner", slug: inv.slug };
    }
    if (!internal && (await usedSessionCount(tx, inv.linkId)) >= inv.allowance) {
      await recordEvent(tx, { ...base, kind: "access_refused", detail: { reason: "session_limit", allowance: inv.allowance } });
      return { kind: "limit", slug: inv.slug };
    }
    const token = newSessionToken();
    const [session] = await tx`
      insert into prospect_report_sessions
        (prospect_id, audit_id, link_id, token_hash, is_internal, user_agent, expires_at)
      values (${inv.prospectId}, ${inv.auditId}, ${inv.linkId}, ${hashSessionToken(token)}, ${internal},
        ${meta.userAgent?.slice(0, 500) ?? null}, now() + make_interval(mins => ${PENDING_SESSION_MINUTES}))
      returning id`;
    const sessionId = session!.id as string;
    await recordEvent(tx, { ...base, sessionId, kind: "session_created" });
    await recordEvent(tx, { ...base, sessionId, kind: "access_granted", detail: { reused: false } });
    if (!internal) await logActivity(tx, inv.prospectId, "report_access_granted", { sessionId, auditId: inv.auditId }, null);
    return { kind: "granted", slug: inv.slug, sessionToken: token, reused: false };
  });
}

export interface ReportSession {
  id: string;
  prospectId: string;
  auditId: string;
  linkId: string | null;
  slug: string;
  isInternal: boolean;
}

/** A valid session among the presented tokens for this prospect, or null. */
async function findSessionForProspect(prospectId: string, tokens: string[]): Promise<{ id: string } | null> {
  const hashes = tokens.filter((t) => t.length > 0 && t.length <= 200).map(hashSessionToken);
  if (hashes.length === 0) return null;
  const [row] = await sql`
    select id from prospect_report_sessions
    where prospect_id = ${prospectId} and token_hash = any(${hashes}::text[])
      and revoked_at is null and expires_at > now()`;
  return row ? { id: row.id as string } : null;
}

/**
 * Authorize a clean-URL request: the slug must name a prospect with a
 * published, unexpired audit, and one of the presented cookie tokens must be
 * a live session of THAT prospect. First use activates the session (full
 * TTL); later uses refresh last_seen_at at most every few minutes.
 */
export async function authorizeReportRequest(slug: string, presentedTokens: string[]): Promise<ReportSession | null> {
  if (!isReportSlug(slug)) return null;
  const hashes = presentedTokens.filter((t) => t.length > 0 && t.length <= 200).map(hashSessionToken);
  if (hashes.length === 0) return null;
  const [row] = await sql`
    select s.id, s.prospect_id, s.audit_id, s.link_id, s.is_internal, s.first_used_at, s.last_seen_at,
      p.report_slug
    from prospect_report_sessions s
    join prospects p on p.id = s.prospect_id
    join prospect_audits a on a.id = s.audit_id
    where p.report_slug = ${slug} and s.token_hash = any(${hashes}::text[])
      and s.revoked_at is null and s.expires_at > now()
      and a.status = 'published' and (a.expires_at is null or a.expires_at > now())
      and p.archived_at is null
      and (s.link_id is null or exists (select 1 from prospect_audit_links l where l.id = s.link_id and l.revoked_at is null))
    limit 1`;
  if (!row) return null;
  await touchSession(row.id as string, row.firstUsedAt as Date | null, row.lastSeenAt as Date | null);
  return {
    id: row.id as string,
    prospectId: row.prospectId as string,
    auditId: row.auditId as string,
    linkId: (row.linkId as string | null) ?? null,
    slug: row.reportSlug as string,
    isInternal: Boolean(row.isInternal),
  };
}

async function touchSession(id: string, firstUsedAt: Date | null, lastSeenAt: Date | null): Promise<void> {
  if (!firstUsedAt) {
    await sql`
      update prospect_report_sessions
      set first_used_at = now(), last_seen_at = now(),
          expires_at = now() + make_interval(days => ${sessionTtlDays()})
      where id = ${id} and first_used_at is null`;
    return;
  }
  const stale = !lastSeenAt || Date.now() - lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MINUTES * 60_000;
  if (stale) await sql`update prospect_report_sessions set last_seen_at = now() where id = ${id}`;
}

/** Revoke every session of a prospect (rides revokeAudit's transaction or
 * the standalone revoke-access action). */
export async function revokeReportSessions(tx: Sql | TransactionSql, prospectId: string): Promise<number> {
  const rows = await tx`
    update prospect_report_sessions set revoked_at = now()
    where prospect_id = ${prospectId} and revoked_at is null
    returning id`;
  return rows.length;
}

/**
 * Operator action: burn the invitation and every session without revoking
 * the audit itself — the report stays published so a fresh invitation can
 * be minted (mintAuditLink) and delivered.
 */
export async function revokeReportAccess(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ sessionsRevoked: number }>> {
  const parsed = z.object({ prospectId: z.string().uuid(), reason: z.string().trim().min(1).max(1000) }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", "A revocation needs a prospect and a reason."));
  const { prospectId, reason } = parsed.data;
  try {
    assertCanWrite(user);
    const sessionsRevoked = await sql.begin(async (tx) => {
      const [p] = await tx`select id from prospects where id = ${prospectId} and archived_at is null`;
      if (!p) throw new ClassifiedError("not_found", "Prospect not found.");
      await revokeAuditLinks(tx, prospectId);
      const n = await revokeReportSessions(tx, prospectId);
      await writeAudit(tx, { userId: user.id, action: "prospect.report_access_revoke", entity: "prospect", entityId: prospectId, detail: { reason, sessionsRevoked: n } });
      await logActivity(tx, prospectId, "report_access_revoked", { reason, sessionsRevoked: n }, user.id);
      return n;
    });
    return ok({ sessionsRevoked });
  } catch (err) {
    return fail(err);
  }
}

export interface ReportAccessMetrics {
  reportDeliveredAt: Date | null;
  firstExternalAccessAt: Date | null;
  firstExternalViewAt: Date | null;
  externalSessionCount: number;
  totalExternalViews: number;
  lastExternalViewAt: Date | null;
}

/** Canonical per-prospect access metrics: external = a non-internal session
 * that reached the report; views = audit view rows stamped with such a
 * session (redirects, HEADs, scanner hits and operator QA never qualify). */
export async function reportAccessMetrics(prospectId: string): Promise<ReportAccessMetrics> {
  const [r] = await sql`
    select
      (select min(d.sent_recorded_at) from outreach_drafts d
        where d.prospect_id = ${prospectId} and d.prompt_version = ${REPORT_DELIVERY_TEMPLATE_VERSION}
          and d.sent_recorded_at is not null) as delivered_at,
      (select min(s.first_used_at) from prospect_report_sessions s
        where s.prospect_id = ${prospectId} and not s.is_internal and s.first_used_at is not null) as first_access_at,
      (select count(*)::int from prospect_report_sessions s
        where s.prospect_id = ${prospectId} and not s.is_internal and s.first_used_at is not null) as sessions,
      (select min(v.viewed_at) from prospect_audit_views v join prospect_report_sessions s on s.id = v.session_id
        where s.prospect_id = ${prospectId} and not s.is_internal and not v.is_internal) as first_view_at,
      (select max(v.viewed_at) from prospect_audit_views v join prospect_report_sessions s on s.id = v.session_id
        where s.prospect_id = ${prospectId} and not s.is_internal and not v.is_internal) as last_view_at,
      (select count(*)::int from prospect_audit_views v join prospect_report_sessions s on s.id = v.session_id
        where s.prospect_id = ${prospectId} and not s.is_internal and not v.is_internal) as views`;
  return {
    reportDeliveredAt: (r?.deliveredAt as Date | null) ?? null,
    firstExternalAccessAt: (r?.firstAccessAt as Date | null) ?? null,
    firstExternalViewAt: (r?.firstViewAt as Date | null) ?? null,
    externalSessionCount: Number(r?.sessions ?? 0),
    totalExternalViews: Number(r?.views ?? 0),
    lastExternalViewAt: (r?.lastViewAt as Date | null) ?? null,
  };
}

export interface ReportAccessSummary {
  reportsDelivered: number;
  reportsViewed: number;
  firstExternalViewAt: Date | null;
  authorizedExternalSessions: number;
}

/** Portfolio-level counts for the dashboard (fixture launches excluded by
 * the caller's prefix). */
export async function reportAccessSummary(fixturePrefix: string): Promise<ReportAccessSummary> {
  const fixture = `${fixturePrefix}%`;
  const [r] = await sql`
    with live as (
      select p.id from prospects p join market_launches l on l.id = p.launch_id
      where p.archived_at is null and l.name not like ${fixture}
    )
    select
      (select count(distinct d.prospect_id)::int from outreach_drafts d
        where d.prompt_version = ${REPORT_DELIVERY_TEMPLATE_VERSION} and d.sent_recorded_at is not null
          and d.prospect_id in (select id from live)) as delivered,
      (select count(distinct s.prospect_id)::int from prospect_audit_views v
        join prospect_report_sessions s on s.id = v.session_id
        where not s.is_internal and not v.is_internal and s.prospect_id in (select id from live)) as viewed,
      (select min(v.viewed_at) from prospect_audit_views v
        join prospect_report_sessions s on s.id = v.session_id
        where not s.is_internal and not v.is_internal and s.prospect_id in (select id from live)) as first_view,
      (select count(*)::int from prospect_report_sessions s
        where not s.is_internal and s.first_used_at is not null and s.revoked_at is null and s.expires_at > now()
          and s.prospect_id in (select id from live)) as sessions`;
  return {
    reportsDelivered: Number(r?.delivered ?? 0),
    reportsViewed: Number(r?.viewed ?? 0),
    firstExternalViewAt: (r?.firstView as Date | null) ?? null,
    authorizedExternalSessions: Number(r?.sessions ?? 0),
  };
}

/** Invitation URLs in an outbound body, labeled for the HTML part. Matches
 * only /report/<slug>/<key> — legacy /audit links and every other URL are
 * left as plain text. */
export function invitationLinkLabels(body: string, businessName: string): { url: string; label: string }[] {
  const base = process.env.APP_URL?.replace(/\/$/, "");
  if (!base) return [];
  const re = new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/report/[a-z0-9-]+/[A-Za-z0-9_-]{8,}`, "g");
  const seen = new Set<string>();
  const out: { url: string; label: string }[] = [];
  for (const m of body.match(re) ?? []) {
    if (seen.has(m)) continue;
    seen.add(m);
    out.push({ url: m, label: `Private report for ${businessName}` });
  }
  return out;
}
