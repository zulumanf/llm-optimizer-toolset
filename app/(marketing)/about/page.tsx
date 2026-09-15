/** About: only verified facts. Unverified fields render as "not published". */
import type { Metadata } from "next";
import { JsonLd } from "@/components/marketing/json-ld";
import { ArticleSection, ArticleShell, Definitions } from "@/components/marketing/research";
import { MARKETING_CONTACT } from "@/lib/marketing/constants";
import { breadcrumbLd, marketingMetadata } from "@/lib/marketing/seo";

const PATH = "/about";
export const metadata: Metadata = marketingMetadata(PATH);
const NOT_PUBLISHED = "Not published yet";

export default function AboutPage() {
  return (
    <ArticleShell
      path={PATH}
      eyebrow="About"
      lede="Recommended First is a measurement practice for real estate teams: we count whether AI assistants recommend a team when buyers and sellers ask who to hire, publish the counts with their denominators, and work on the evidence behind the answers. It is operated by a small team and built on our own measurement platform."
      meta={[{ label: "Founder", value: MARKETING_CONTACT.founder }]}
      related={["/methodology", "/faq", "/research"]}
    >
      <JsonLd data={breadcrumbLd(PATH)} />
      <ArticleSection title="Facts">
        <Definitions
          items={[
            { term: "What we are", definition: "An independent measurement and advisory practice for real estate agents and teams. Not a software product for sale, not a lead-generation service, not an agency that sells rankings." },
            { term: "Founder", definition: MARKETING_CONTACT.founder },
            { term: "Legal entity", definition: MARKETING_CONTACT.legalEntity ?? NOT_PUBLISHED },
            { term: "Postal address", definition: MARKETING_CONTACT.postalAddress ?? NOT_PUBLISHED },
            { term: "Contact", definition: MARKETING_CONTACT.email ?? "Through the request form on the homepage; a person reads every request before any analysis." },
            { term: "Exclusivity", definition: "We do not engineer the same advantage for direct competitors in one market. This is conflict-of-interest management, not scarcity marketing." },
          ]}
        />
      </ArticleSection>
      <ArticleSection title="What we publish and what we do not">
        <p>We publish our methodology, the fields and scoring our platform uses, and aggregate, anonymized findings from our own benchmarks. We do not publish client names, client results, testimonials, or per-agent counts, and we do not publish third-party statistics we have not verified. A case study appears only with the client&rsquo;s written approval and verified measurements.</p>
      </ArticleSection>
      <ArticleSection title="What we will not promise">
        <p>Rankings, recommendations, citations, leads or revenue on any AI system. We have no access to any model&rsquo;s internals. What we promise is a measurement you can inspect and a record of what changed and when.</p>
      </ArticleSection>
    </ArticleShell>
  );
}
