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

/** Open-tracking pixel URL (spec 092): /api/open/<token>. Same APP_URL
 * rules — null means the send goes out untracked, never blocked. */
export function openPixelUrl(token: string): string | null {
  const base = process.env.APP_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/api/open/${token}`;
}

/** Private-report invitation (spec 134): /report/<slug>/<key>. The key is the
 * credential; after the exchange the browser shows only /report/<slug>. */
export function reportInvitationUrl(slug: string, key: string): string | null {
  const base = process.env.APP_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/report/${slug}/${key}`;
}

/** Clean report URL (spec 134) — not a credential; rendered only for an
 * authorized session. */
export function reportUrl(slug: string): string | null {
  const base = process.env.APP_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/report/${slug}`;
}
