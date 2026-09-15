import type { Metadata } from "next";
import { JsonLd } from "@/components/marketing/json-ld";
import { ArticleSection, ArticleShell, DataTable, SourceLinks } from "@/components/marketing/research";
import { RF_FACTS, vendor } from "@/lib/marketing/vendors";
import { breadcrumbLd, marketingMetadata } from "@/lib/marketing/seo";

const PATH = "/recommended-first-vs-rankfender";
export const metadata: Metadata = marketingMetadata(PATH);
const V = vendor("rankfender");

export default function ComparisonPage() {
  return (
    <ArticleShell
      path={PATH}
      eyebrow="Comparison"
      lede={`Two different things: Recommended First is an operated, denominator-first measurement engagement for real estate teams; ${V.name} describes itself as an AI visibility monitoring platform. We have not used ${V.name}. Everything in its column is quoted from its own website with a retrieval date, and anything we could not verify is marked as such.`}
      meta={[{ label: "Vendor statements retrieved", value: V.facts[0]?.retrieved ?? "unknown" }]}
      related={["/recommended-first-alternatives", "/best-ai-visibility-tools-for-real-estate", "/methodology"]}
    >
      <JsonLd data={breadcrumbLd(PATH)} />
      <ArticleSection title="Recommended First (verified against the platform)">
        <DataTable caption="What Recommended First does, as documented on the methodology and citation-intelligence pages." columns={["Attribute", "Recommended First"]} rows={RF_FACTS.map((f) => [f.attribute, f.statement])} />
      </ArticleSection>
      <ArticleSection title={`${V.name} (vendor self-description)`}>
        <DataTable caption={`Quoted from ${V.name}'s website; not tested or verified by Recommended First. Attributes not listed are unknown to us.`} columns={["Attribute", "Vendor statement", "Source"]} rows={V.facts.map((f) => [f.attribute, f.statement, f.sourceUrl])} />
      </ArticleSection>
      <ArticleSection title="Not verified by us">
        <p>Pricing, accuracy, repetition counts, raw-answer access, classification method and any outcome claim of {V.name} are unknown to Recommended First. We publish no judgement of them. Ask the same eight questions of both vendors and compare the answers with denominators.</p>
      </ArticleSection>
      <SourceLinks items={[{ label: `${V.name} website`, href: V.website, note: "vendor site, retrieved 2026-09-14" }, { label: "Recommended First methodology", href: "/methodology" }]} />
    </ArticleShell>
  );
}
