import type { Metadata } from "next";
import { JsonLd } from "@/components/marketing/json-ld";
import { ArticleSection, ArticleShell } from "@/components/marketing/research";
import { FAQ } from "@/lib/marketing/faq";
import { breadcrumbLd, faqLd, marketingMetadata } from "@/lib/marketing/seo";

const PATH = "/faq";
export const metadata: Metadata = marketingMetadata(PATH);

export default function FaqPage() {
  return (
    <ArticleShell
      path={PATH}
      eyebrow="FAQ"
      lede="Direct answers. Where the honest answer is no, it says no."
      meta={[{ label: "Questions", value: String(FAQ.length) }]}
      related={["/methodology", "/research", "/about"]}
    >
      <JsonLd data={[breadcrumbLd(PATH), faqLd(FAQ)]} />
      {FAQ.map((item) => (
        <ArticleSection key={item.q} title={item.q}>
          <p>{item.a}</p>
        </ArticleSection>
      ))}
    </ArticleShell>
  );
}
