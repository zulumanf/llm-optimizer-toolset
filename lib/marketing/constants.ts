/**
 * Marketing site constants (spec 061). The marketing pages are a declared
 * audience surface: prospect, anonymous, indexable. These prefixes are the
 * single source of truth consumed by middleware (public access) and the app
 * shell (no workspace chrome) — adding a marketing page means adding it here,
 * nowhere else.
 */

export const BRAND_NAME = "Recommended First";

/** One-line descriptor used in metadata and the footer. */
export const BRAND_DESCRIPTOR =
  "AI Recommendation Intelligence and Visibility Engineering for real estate.";

/** Route prefixes of the public marketing site. */
export const MARKETING_PREFIXES = ["/home", "/methodology", "/sample-audit"] as const;

export function isMarketingPath(pathname: string): boolean {
  return MARKETING_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

/**
 * Apex-host rewrite (spec 061): the marketing domain serves the homepage at
 * `/`, while the app host keeps `/` as the operator dashboard. Pure so the
 * middleware behavior is unit-testable without a request object.
 *
 * `MARKETING_HOST` env holds comma-separated hosts (e.g.
 * "recommendedfirst.com,www.recommendedfirst.com"). Unset = no rewrite,
 * which keeps every existing deployment's behavior unchanged.
 */
export function marketingRewriteTarget(
  host: string | null,
  pathname: string,
  marketingHosts: string | undefined = process.env.MARKETING_HOST
): string | null {
  if (!marketingHosts || !host || pathname !== "/") return null;
  const bare = host.split(":")[0]?.toLowerCase() ?? "";
  const matches = marketingHosts
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
    .includes(bare);
  return matches ? "/home" : null;
}

/** Field length caps for the public audit-request form: the only anonymous
 * write surface on the platform, so inputs are bounded server-side. */
export const AUDIT_REQUEST_FIELD_MAX = 200;
export const AUDIT_REQUEST_EMAIL_MAX = 254;
