import type { Metadata } from "next";
import { JsonLd } from "@/components/marketing/json-ld";
import { ArticleSection, ArticleShell, Definitions } from "@/components/marketing/research";
import { breadcrumbLd, marketingMetadata } from "@/lib/marketing/seo";

const PATH = "/ai-search-optimization-for-real-estate-agents";
export const metadata: Metadata = marketingMetadata(PATH);

export default function OptimizationGuidePage() {
  return (
    <ArticleShell
      path={PATH}
      eyebrow="Guide"
      lede="Optimization here means changing the inputs an AI assistant can observe about a team, then remeasuring on the same frozen questions. It does not mean influencing a model, and it comes with no guarantee. This page lists the kinds of work that follow a measurement and the rules that keep the results honest."
      meta={[{ label: "Evidence rule", value: "movement is reported; cause is not claimed" }]}
      related={["/citation-intelligence", "/methodology", "/chatgpt-visibility-audit-for-real-estate", "/research/ai-citation-sources-real-estate"]}
    >
      <JsonLd data={breadcrumbLd(PATH)} />
      <ArticleSection title="Kinds of intervention">
        <Definitions
          items={[
            { term: "Entity clarity", definition: "One consistent name, role, market and specialization across the sources assistants read; alias collisions and name conflation resolved first, because a misattributed answer cannot be counted." },
            { term: "Citation sources", definition: "Presence on the domains the assistant already cites in your market (portals, directories, local press, rankings), prioritized by observed citation frequency, topic relevance, competitor presence, source credibility, freshness and how natural a contribution is. Domain-authority metrics are not used." },
            { term: "Authority signals", definition: "Independent, verifiable records (verified production, rankings, press) linked to the correct entity; self-reported and sponsored signals are discounted." },
            { term: "Technical discoverability", definition: "Your own site crawlable and unambiguous: robots, sitemap, structured data, one entity per page." },
          ]}
        />
      </ArticleSection>
      <ArticleSection title="Remeasurement rules">
        <p>Baseline before any change on a frozen question set; one recorded intervention per change with URL, date and hypothesis; a control entity that received no change; held-out questions never touched; follow-up runs on the same instruments; and a report that states before and after counts for subject, control and held-out questions. If the model build or repetition count changed between runs, the pair is reported as not comparable.</p>
      </ArticleSection>
      <ArticleSection title="What we do not do">
        <p>No fake reviews, manufactured forum threads, hidden text, prompt injection, link schemes or spam pages. No claim that a publication or backlink caused a recommendation. No promise of rankings, citations, leads or revenue.</p>
      </ArticleSection>
    </ArticleShell>
  );
}
