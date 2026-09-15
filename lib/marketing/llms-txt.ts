/**
 * /llms.txt — a plain-text map of the public site for AI systems that read
 * it (llmstxt.org convention). Pure so it is unit-testable; the route
 * handler only sets headers. Says what we are, what we are not, and where
 * the source-of-truth pages live. No claims beyond the registry.
 */
import { BRAND_NAME, BRAND_DESCRIPTOR, MARKETING_CONTACT } from "@/lib/marketing/constants";
import { canonicalUrl, publicPageUrls } from "@/lib/marketing/seo";

const SECTION_TITLES: Record<string, string> = {
  core: "Product and methodology",
  research: "Research (dated, denominator-bearing benchmark findings)",
  guides: "Guides",
  compare: "Comparisons (competitor statements are vendor self-descriptions, dated)",
  trust: "About and FAQ",
};

export function llmsTxt(): string {
  const pages = publicPageUrls();
  const lines: string[] = [
    `# ${BRAND_NAME}`,
    "",
    `> ${BRAND_DESCRIPTOR} We measure whether AI assistants recommend a real estate agent or team when buyers and sellers ask who to hire, and we publish the counts with their denominators.`,
    "",
    "What the product does: runs versioned sets of buyer and seller questions against search-enabled AI assistants through their APIs, repeats each question, stores every raw answer immutably, classifies which agents or teams were recommended, records which sources the answers cited, and compares recommendation counts with verified production records.",
    "",
    "What we do not do: we do not guarantee rankings, recommendations, citations, leads or revenue on any AI system. We have no access to any model's internals. API captures are labeled as the OpenAI or Perplexity model, never as the consumer ChatGPT app. We publish no client or prospect names.",
    "",
  ];
  for (const section of ["core", "research", "guides", "compare", "trust"]) {
    lines.push(`## ${SECTION_TITLES[section]}`, "");
    for (const p of pages.filter((x) => x.section === section)) {
      lines.push(`- [${p.title}](${p.url}): ${p.description} (updated ${p.updated})`);
    }
    lines.push("");
  }
  lines.push(
    "## Contact",
    "",
    MARKETING_CONTACT.email
      ? `- Email: ${MARKETING_CONTACT.email}`
      : `- Request a measurement through the form on ${canonicalUrl("/home")} (reviewed by a person before any analysis).`,
    `- Founder: ${MARKETING_CONTACT.founder}`,
    "",
    "## Optional",
    "",
    `- [Sitemap](${canonicalUrl("/home")}sitemap.xml)`,
    ""
  );
  return lines.join("\n");
}
