import type { Metadata } from "next";
import { JsonLd } from "@/components/marketing/json-ld";
import { ArticleSection, ArticleShell, DataTable, SourceLinks } from "@/components/marketing/research";
import { EVALUATION_QUESTIONS } from "@/lib/marketing/evaluation";
import { VENDORS } from "@/lib/marketing/vendors";
import { breadcrumbLd, marketingMetadata } from "@/lib/marketing/seo";

const PATH = "/best-ai-visibility-tools-for-real-estate";
export const metadata: Metadata = marketingMetadata(PATH);

export default function ToolsGuidePage() {
  return (
    <ArticleShell
      path={PATH}
      eyebrow="Guide"
      lede="There is no ranking on this page, because we have not tested other vendors' products and will not pretend to. What we can offer is the set of questions a real estate team should ask any AI visibility tool, our own verified answers, and other vendors' self-descriptions quoted from their sites with retrieval dates."
      meta={[{ label: "Vendor statements retrieved", value: "2026-09-14" }]}
      related={["/recommended-first-alternatives", "/methodology", "/chatgpt-visibility-audit-for-real-estate"]}
    >
      <JsonLd data={breadcrumbLd(PATH)} />
      <ArticleSection title="Eight questions to ask any tool">
        <DataTable caption="Questions, why they matter, and Recommended First's verified answer." columns={["Question", "Why it matters", "Recommended First"]} rows={EVALUATION_QUESTIONS.map((q) => [q.question, q.why, q.rfAnswer])} />
      </ArticleSection>
      {VENDORS.map((v) => (
        <ArticleSection key={v.key} title={`${v.name} (vendor self-description)`}>
          <p>Quoted from {v.name}&rsquo;s own website; not tested or verified by Recommended First.</p>
          <DataTable caption={`Statements retrieved ${v.facts[0]?.retrieved}.`} columns={["Attribute", "Vendor statement", "Source"]} rows={v.facts.map((f) => [f.attribute, f.statement, f.sourceUrl])} />
        </ArticleSection>
      ))}
      <ArticleSection title="How to read vendor claims">
        <p>Ask for the denominator behind any score, the instrument behind any &ldquo;ChatGPT&rdquo; figure, and the raw answers behind any absence. A percentage without a count, a lead-increase figure without a control, or a ranking of AI systems without a capture date should be treated as marketing, whoever publishes it, including us.</p>
      </ArticleSection>
      <SourceLinks items={VENDORS.map((v) => ({ label: `${v.name} website`, href: v.website, note: "vendor site, retrieved 2026-09-14" }))} />
    </ArticleShell>
  );
}
