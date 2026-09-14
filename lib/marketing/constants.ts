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
export const MARKETING_PREFIXES = [
  "/home",
  "/methodology",
  "/sample-audit",
  "/citation-intelligence",
  "/research",
  "/about",
  "/faq",
  "/chatgpt-visibility-audit-for-real-estate",
  "/ai-search-optimization-for-real-estate-agents",
  "/best-ai-visibility-tools-for-real-estate",
  "/recommended-first-alternatives",
  "/recommended-first-vs-sorn-ai",
  "/recommended-first-vs-rankfender",
] as const;

/** Crawler-facing files served at the site root (robots, sitemap, llms.txt).
 * Public like the marketing pages: the auth middleware must never 307 a
 * crawler's robots.txt fetch to /login. */
export const MARKETING_PUBLIC_FILES = ["/robots.txt", "/sitemap.xml", "/llms.txt", "/research-data/"] as const;

/** Canonical origin of the public site when `MARKETING_HOST` is unset. The
 * first configured host wins otherwise, so canonical URLs, the sitemap and
 * llms.txt agree with whatever the deployment actually answers on. */
export const MARKETING_DEFAULT_ORIGIN = "https://recommendedfirst.com";

export function marketingOrigin(
  marketingHosts: string | undefined = process.env.MARKETING_HOST
): string {
  const first = marketingHosts
    ?.split(",")
    .map((h) => h.trim().toLowerCase())
    .find(Boolean);
  return first ? `https://${first}` : MARKETING_DEFAULT_ORIGIN;
}

/** Legal/contact facts printed on the public site. Anything not verified by
 * a person stays null and is rendered as "not published" — never guessed. */
export const MARKETING_CONTACT = {
  /** Set once the public inbox is confirmed working (spec 091 sender domain). */
  email: null as string | null,
  /** Registered legal entity name — needs human verification before publishing. */
  legalEntity: null as string | null,
  /** Postal address — not published until verified. */
  postalAddress: null as string | null,
  foundedYear: null as number | null,
  founder: "Francisco Zuluaga",
} as const;

export type MarketingPage = {
  path: (typeof MARKETING_PREFIXES)[number] | `${(typeof MARKETING_PREFIXES)[number]}/${string}`;
  title: string;
  description: string;
  /** ISO date of the last substantive content change; feeds sitemap + dates. */
  updated: string;
  /** Section the page belongs to for breadcrumbs and llms.txt grouping. */
  section: "core" | "research" | "trust" | "guides" | "compare";
};

/** Every public page, once. Consumed by the sitemap, llms.txt, breadcrumbs
 * and the research index — adding a page means adding it here. */
export const MARKETING_PAGES: readonly MarketingPage[] = [
  {
    path: "/home",
    title: "AI Recommendation Intelligence for Real Estate",
    description:
      "Measure how AI assistants recommend real estate agents and teams, diagnose competitive visibility gaps, and engineer evidence-backed improvements.",
    updated: "2026-09-13",
    section: "core",
  },
  {
    path: "/methodology",
    title: "How We Measure AI Visibility",
    description:
      "Versioned prompt sets, repeated sampling, immutable raw capture, recommendation classification, citation capture, confidence labels and known limitations.",
    updated: "2026-09-13",
    section: "core",
  },
  {
    path: "/citation-intelligence",
    title: "Citation Intelligence",
    description:
      "What we record about the sources AI answers cite: fields captured, source taxonomy, competitor source mapping, entity clarity, gap scoring and source priority.",
    updated: "2026-09-13",
    section: "core",
  },
  {
    path: "/sample-audit",
    title: "Sample AI Visibility Audit",
    description:
      "An illustrative audit layout: recommendation share, prompt-level results, competitor analysis, source coverage and prioritized actions, with confidence labels.",
    updated: "2026-09-13",
    section: "core",
  },
  {
    path: "/research",
    title: "Research",
    description:
      "Published benchmark findings on how AI assistants recommend real estate professionals, with denominators, dates and limitations stated on every page.",
    updated: "2026-09-14",
    section: "research",
  },
  {
    path: "/research/jersey-city-ai-visibility-report",
    title: "Jersey City AI Visibility Report",
    description:
      "Aggregate results from a 128-answer benchmark of the OpenAI web-search API instrument and Perplexity asked who to hire in Jersey City, NJ: recommendation concentration and cited sources.",
    updated: "2026-09-14",
    section: "research",
  },
  {
    path: "/research/ai-citation-sources-real-estate",
    title: "AI Citation Sources in Real Estate",
    description:
      "Which domains search-enabled AI assistants cite when asked to recommend real estate agents, counted across 87,900 answer-domain pairs in 17 U.S. markets.",
    updated: "2026-09-14",
    section: "research",
  },
  {
    path: "/research/real-estate-ai-recommendation-statistics",
    title: "AI Recommendation Statistics for Real Estate",
    description:
      "Statistics from our own captured answers, not consumer search logs: how often AI assistants name a specific agent, how concentrated recommendations are per market, and how often answers carry citations.",
    updated: "2026-09-14",
    section: "research",
  },
  {
    path: "/research/chatgpt-real-estate-visibility-benchmark",
    title: "ChatGPT Real Estate Visibility Benchmark",
    description:
      "The flagship benchmark of how the OpenAI web-search API instrument and Perplexity answer who-to-hire questions in 17 U.S. real-estate markets: definitions, chart-ready tables, methodology, limitations and citation format.",
    updated: "2026-09-14",
    section: "research",
  },
  {
    path: "/research/real-estate-ai-visibility-index",
    title: "Real Estate AI Visibility Index",
    description:
      "Status and method of a per-market index of AI recommendation coverage for real estate: what is measured today, the coverage table for completed markets, and why no composite ranking is published yet.",
    updated: "2026-09-14",
    section: "research",
  },
  {
    path: "/faq",
    title: "Frequently Asked Questions",
    description:
      "Direct answers on what Recommended First measures, what it cannot promise, which platforms are tested, how retesting works and how engagements are scoped.",
    updated: "2026-09-13",
    section: "trust",
  },
  {
    path: "/chatgpt-visibility-audit-for-real-estate",
    title: "ChatGPT Visibility Audit for Real Estate",
    description:
      "What a Recommended First visibility audit measures with the OpenAI web-search API instrument and Perplexity, what it delivers, what it cannot show, and how to request one.",
    updated: "2026-09-14",
    section: "guides",
  },
  {
    path: "/ai-search-optimization-for-real-estate-agents",
    title: "AI Search Optimization for Real Estate Agents",
    description:
      "What changes after a measurement: entity clarity, citation sources, authority signals and remeasurement, with the evidence rules that stop unsupported causal claims.",
    updated: "2026-09-14",
    section: "guides",
  },
  {
    path: "/best-ai-visibility-tools-for-real-estate",
    title: "Best AI Visibility Tools for Real Estate",
    description:
      "How to evaluate an AI visibility tool for a real estate team: eight questions, Recommended First's verified answers, and vendor self-descriptions with retrieval dates instead of rankings.",
    updated: "2026-09-14",
    section: "guides",
  },
  {
    path: "/recommended-first-alternatives",
    title: "Recommended First Alternatives",
    description:
      "When Recommended First is not the right fit, which kinds of tools to consider instead, and what to verify before choosing any AI visibility vendor.",
    updated: "2026-09-14",
    section: "compare",
  },
  {
    path: "/recommended-first-vs-sorn-ai",
    title: "Recommended First vs Sorn AI",
    description:
      "A side-by-side of Recommended First's verified measurement approach and Sorn AI's self-described monitoring product, with every competitor statement sourced and dated.",
    updated: "2026-09-14",
    section: "compare",
  },
  {
    path: "/recommended-first-vs-rankfender",
    title: "Recommended First vs Rankfender",
    description:
      "A side-by-side of Recommended First's verified measurement approach and Rankfender's self-described AI visibility platform, with every competitor statement sourced and dated.",
    updated: "2026-09-14",
    section: "compare",
  },
  {
    path: "/about",
    title: "About Recommended First",
    description:
      "Who runs Recommended First, what the platform is, what is and is not published, and how to reach us.",
    updated: "2026-09-13",
    section: "trust",
  },
];

export function marketingPage(path: string): MarketingPage {
  const page = MARKETING_PAGES.find((p) => p.path === path);
  if (!page) throw new Error(`Unregistered marketing page: ${path}`);
  return page;
}

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
