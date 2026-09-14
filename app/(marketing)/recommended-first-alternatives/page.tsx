import type { Metadata } from "next";
import { JsonLd } from "@/components/marketing/json-ld";
import { ArticleSection, ArticleShell, DataTable, Definitions, SourceLinks } from "@/components/marketing/research";
import { EVALUATION_QUESTIONS } from "@/lib/marketing/evaluation";
import { VENDORS } from "@/lib/marketing/vendors";
import { breadcrumbLd, marketingMetadata } from "@/lib/marketing/seo";

const PATH = "/recommended-first-alternatives";
export const metadata: Metadata = marketingMetadata(PATH);

export default function AlternativesPage() {
  return (
    <ArticleShell
      path={PATH}
      eyebrow="Comparison"
      lede="Recommended First is an operated measurement engagement for real estate teams, not self-serve software. If that is not what you need, this page says who should look elsewhere and what to verify before choosing any vendor. Other products are described only in their own words, with retrieval dates."
      meta={[{ label: "Vendor statements retrieved", value: "2026-09-14" }]}
      related={["/best-ai-visibility-tools-for-real-estate", "/recommended-first-vs-sorn-ai", "/recommended-first-vs-rankfender", "/about"]}
    >
      <JsonLd data={breadcrumbLd(PATH)} />
      <ArticleSection title="When Recommended First is not the right fit">
        <Definitions
          items={[
            { term: "You want a self-serve dashboard for many brands", definition: "We run engagements one market at a time with exclusivity; a monitoring SaaS is a better fit." },
            { term: "You want promised rankings or a quick hack", definition: "We make no guarantees and publish no ranking factors; no vendor can honestly promise these, but some will." },
            { term: "You need consumer-app measurements", definition: "Our standard instrument is the OpenAI API with web search plus Perplexity; consumer sessions are recorded manually and only for validation." },
            { term: "You are outside residential real estate", definition: "Prompt packs, production records and source taxonomy are built for real estate teams." },
          ]}
        />
      </ArticleSection>
      <ArticleSection title="Vendors that describe themselves as AI visibility platforms">
        {VENDORS.map((v) => (
          <DataTable key={v.key} caption={`${v.name}: self-description quoted from the vendor's site, retrieved ${v.facts[0]?.retrieved}; not tested by Recommended First.`} columns={["Attribute", "Vendor statement"]} rows={v.facts.map((f) => [f.attribute, f.statement])} />
        ))}
      </ArticleSection>
      <ArticleSection title="What to verify before choosing anyone">
        <ul className="list-disc space-y-1 pl-5">
          {EVALUATION_QUESTIONS.map((q) => (
            <li key={q.question}>{q.question}</li>
          ))}
        </ul>
      </ArticleSection>
      <SourceLinks items={VENDORS.map((v) => ({ label: `${v.name} website`, href: v.website, note: "vendor site, retrieved 2026-09-14" }))} />
    </ArticleShell>
  );
}
