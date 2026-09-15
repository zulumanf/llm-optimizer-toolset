/**
 * Public-site SEO helpers: one metadata builder and the JSON-LD shapes the
 * marketing pages emit. Everything resolves from the page registry in
 * `constants.ts`, so a canonical URL, a sitemap entry and a breadcrumb can
 * never disagree about a page's title or path.
 *
 * Structured data here describes only what is true and verifiable on the
 * page: no ratings, no reviews, no awards, no client results.
 */
import type { Metadata } from "next";
import {
  BRAND_NAME,
  BRAND_DESCRIPTOR,
  MARKETING_CONTACT,
  MARKETING_PAGES,
  marketingOrigin,
  marketingPage,
} from "@/lib/marketing/constants";

/** The marketing host serves the homepage at `/`; `/home` is its app path. */
export function canonicalPath(path: string): string {
  return path === "/home" ? "/" : path;
}

export function canonicalUrl(path: string): string {
  return `${marketingOrigin()}${canonicalPath(path)}`;
}

export function marketingMetadata(path: string, kind: "website" | "article" = "website"): Metadata {
  const page = marketingPage(path);
  const url = canonicalUrl(path);
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: url },
    robots: { index: true, follow: true },
    openGraph: {
      type: kind,
      url,
      siteName: BRAND_NAME,
      title: page.title,
      description: page.description,
      locale: "en_US",
      ...(kind === "article" ? { modifiedTime: page.updated } : {}),
    },
    twitter: { card: "summary", title: page.title, description: page.description },
  };
}

export type JsonLdObject = Record<string, unknown>;

const ORGANIZATION_ID = () => `${marketingOrigin()}/#organization`;
const WEBSITE_ID = () => `${marketingOrigin()}/#website`;

export function organizationLd(): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": ORGANIZATION_ID(),
    name: BRAND_NAME,
    url: `${marketingOrigin()}/`,
    description: BRAND_DESCRIPTOR,
    founder: { "@type": "Person", name: MARKETING_CONTACT.founder },
    knowsAbout: [
      "AI visibility measurement",
      "AI recommendation benchmarking",
      "Citation analysis of AI answers",
      "Real estate marketing",
    ],
    ...(MARKETING_CONTACT.legalEntity ? { legalName: MARKETING_CONTACT.legalEntity } : {}),
    ...(MARKETING_CONTACT.email ? { email: MARKETING_CONTACT.email } : {}),
  };
}

export function websiteLd(): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": WEBSITE_ID(),
    name: BRAND_NAME,
    url: `${marketingOrigin()}/`,
    publisher: { "@id": ORGANIZATION_ID() },
    inLanguage: "en-US",
  };
}

export function breadcrumbLd(path: string): JsonLdObject {
  const page = marketingPage(path);
  const crumbs: { name: string; path: string }[] = [{ name: BRAND_NAME, path: "/home" }];
  if (page.section === "research" && path !== "/research") {
    crumbs.push({ name: marketingPage("/research").title, path: "/research" });
  }
  if (path !== "/home") crumbs.push({ name: page.title, path });
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: canonicalUrl(c.path),
    })),
  };
}

export function faqLd(items: readonly { q: string; a: string }[]): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };
}

export function articleLd(path: string, opts: { published: string; benchmarkWindow: string }): JsonLdObject {
  const page = marketingPage(path);
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: page.title,
    description: page.description,
    url: canonicalUrl(path),
    datePublished: opts.published,
    dateModified: page.updated,
    inLanguage: "en-US",
    author: { "@id": ORGANIZATION_ID() },
    publisher: { "@id": ORGANIZATION_ID() },
    isPartOf: { "@id": WEBSITE_ID() },
    about: "How AI assistants recommend real estate agents and teams",
    temporalCoverage: opts.benchmarkWindow,
  };
}

/** Only for pages that publish a genuinely structured, denominator-bearing
 * table with a described collection method (the research reports). */
export function datasetLd(path: string, opts: { published: string; temporalCoverage: string; spatialCoverage: string; variables: string[] }): JsonLdObject {
  const page = marketingPage(path);
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: page.title,
    description: page.description,
    url: canonicalUrl(path),
    datePublished: opts.published,
    dateModified: page.updated,
    creator: { "@id": ORGANIZATION_ID() },
    license: "Figures may be quoted with attribution and a link to this page; raw answers are not distributed.",
    isAccessibleForFree: true,
    temporalCoverage: opts.temporalCoverage,
    spatialCoverage: opts.spatialCoverage,
    measurementTechnique: `Repeated API prompting of search-enabled AI assistants; immutable raw capture; recommendation classification with human review; see ${canonicalUrl("/methodology")}`,
    variableMeasured: opts.variables,
  };
}

/** All registry pages as absolute canonical URLs (sitemap, llms.txt). */
export function publicPageUrls(): { url: string; updated: string; title: string; description: string; section: string }[] {
  return MARKETING_PAGES.map((p) => ({
    url: canonicalUrl(p.path),
    updated: p.updated,
    title: p.title,
    description: p.description,
    section: p.section,
  }));
}
