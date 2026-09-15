/**
 * robots.txt for the whole deployment (marketing host and app host share
 * one Next.js app). Public marketing and research pages are crawlable by
 * every well-behaved crawler, including AI search crawlers; private and
 * operator surfaces are disallowed. Nothing is hidden per user-agent.
 */
import type { MetadataRoute } from "next";
import { marketingOrigin } from "@/lib/marketing/constants";

/** Surfaces that are never for crawlers: auth, APIs, private reports,
 * prospect audit links, the client portal and the operator workspace root. */
export const ROBOTS_DISALLOW = [
  "/api/",
  "/auth/",
  "/login",
  "/audit/",
  "/report/",
  "/portal/",
  "/mcp",
  "/healthz",
  "/_next/",
] as const;

export default function robots(): MetadataRoute.Robots {
  const origin = marketingOrigin();
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: [...ROBOTS_DISALLOW] }],
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
