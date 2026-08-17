/**
 * Absolute URLs for prospect-facing artifacts (plan 3.1). Built from APP_URL
 * because the operator's browser origin is localhost until deployed — a
 * copied link must be sendable, or it must not exist.
 */
/** Absolute audit-page URL, or null when APP_URL is not configured. Read
 * live (not through getEnv's boot-time cache) so a deploy-time change or a
 * test stub takes effect without a restart; the schema in lib/env.ts still
 * validates the value at boot. */
export function auditUrl(accessToken: string): string | null {
  const base = process.env.APP_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/audit/${accessToken}`;
}

/** Branded audit URL (spec 076): /audit/<slug>/<key>. Same APP_URL rules. */
export function brandedAuditUrl(slug: string, key: string): string | null {
  const base = process.env.APP_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/audit/${slug}/${key}`;
}
