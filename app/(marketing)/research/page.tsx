/** Research index: every published, denominator-bearing finding, with its
 * status. Pages that need more data are listed as such, not padded. */
import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/marketing/json-ld";
import { ArticleSection, ArticleShell } from "@/components/marketing/research";
import { MARKETING_PAGES } from "@/lib/marketing/constants";
import { breadcrumbLd, marketingMetadata } from "@/lib/marketing/seo";
import { claimNumber } from "@/lib/marketing/claims";

export const metadata: Metadata = marketingMetadata("/research");

export default function ResearchIndexPage() {
  const reports = MARKETING_PAGES.filter((p) => p.section === "research" && p.path !== "/research");
  const runs = claimNumber("corpus-aggregate", "runs");
  const projects = claimNumber("corpus-aggregate", "projects");
  return (
    <ArticleShell
      path="/research"
      eyebrow="Research"
      lede="Findings from our own benchmarks of how search-enabled AI assistants answer when buyers and sellers ask who to hire. Every page states the benchmark date, the instruments, the denominator and what the numbers cannot show. No page names an agent, team or client."
      meta={[
        { label: "Corpus", value: `${runs} benchmark runs in ${projects} U.S. markets` },
        { label: "Window", value: "2026-07-30 to 2026-09-07" },
      ]}
      related={["/methodology", "/citation-intelligence"]}
    >
      <JsonLd data={breadcrumbLd("/research")} />
      <ArticleSection title="Published reports">
        <ul className="space-y-4">
          {reports.map((p) => (
            <li key={p.path}>
              <Link href={p.path} className="font-medium text-foreground underline underline-offset-4">
                {p.title}
              </Link>
              <p className="mt-1">{p.description}</p>
              <p className="mt-1 text-xs">
                Updated <time dateTime={p.updated}>{p.updated}</time>
              </p>
            </li>
          ))}
        </ul>
      </ArticleSection>
      <ArticleSection title="How to cite these pages">
        <p>
          Quote the count and its denominator together, the benchmark date, and the instrument (for example: &ldquo;the OpenAI model, gpt-5.4-mini with web search, via API&rdquo;). Link to the page. Figures are recounted from the immutable raw answers before publication, and the recount script is part of the platform.
        </p>
      </ArticleSection>
      <ArticleSection title="What is not here">
        <p>
          We do not publish consumer search-behavior statistics, national market-share figures, or third-party survey numbers, because we have not collected or verified any. Pages that would need such data say so instead of estimating.
        </p>
      </ArticleSection>
    </ArticleShell>
  );
}
