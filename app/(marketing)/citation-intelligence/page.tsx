/** Citation intelligence: the exact fields, taxonomy and scoring the
 * platform uses for sources cited by AI answers. Describes what exists. */
import type { Metadata } from "next";
import { JsonLd } from "@/components/marketing/json-ld";
import { ArticleSection, ArticleShell, DataTable, Definitions } from "@/components/marketing/research";
import { breadcrumbLd, marketingMetadata } from "@/lib/marketing/seo";

const PATH = "/citation-intelligence";
export const metadata: Metadata = marketingMetadata(PATH);

export default function CitationIntelligencePage() {
  return (
    <ArticleShell
      path={PATH}
      eyebrow="Product"
      lede="Citation intelligence is the part of the platform that records which sources an AI answer drew on, classifies them, maps them to competitors, and ranks which sources would matter most for a client. This page lists exactly what is captured and how it is scored, so a reader can judge the evidence rather than take our word."
      meta={[
        { label: "Applies to", value: "Every benchmark since 2026-07-28" },
        { label: "Versions", value: "source-classifier-v2, market-citations-v1, acvs-v1" },
      ]}
      related={["/methodology", "/research/ai-citation-sources-real-estate", "/research/jersey-city-ai-visibility-report"]}
    >
      <JsonLd data={breadcrumbLd(PATH)} />
      <ArticleSection title="What is captured per answer">
        <Definitions
          items={[
            { term: "url, domain", definition: "Each citation the provider returned with the answer, with tracking parameters stripped. Extracted from the stored raw payload, so it can be re-derived at any time." },
            { term: "kind", definition: "in_text (a link inside the answer text) or search (a search-result attachment)." },
            { term: "owner", definition: "The tracked company whose domain the citation belongs to, when it is one; otherwise third party." },
            { term: "immutability", definition: "Citation rows are insert-only, like raw answers. Reclassification writes new versions; nothing is edited in place." },
          ]}
        />
      </ArticleSection>
      <ArticleSection title="Source classification taxonomy">
        <DataTable
          caption="source_type values (source-classifier-v2). Each domain also carries a relationship: owned, competitor or third_party, relative to the client."
          columns={["Type", "Meaning"]}
          rows={[
            ["portal", "National listing portals (for example zillow.com, realtor.com, homes.com)"],
            ["directory", "Agent directories and matching services"],
            ["brokerage", "A brokerage or rival brand's own site"],
            ["client_site", "The client's own domain"],
            ["review", "Review platforms"],
            ["social", "Social networks"],
            ["video", "Video platforms"],
            ["news", "National or trade press"],
            ["local_press", "Local news and neighborhood publications, extended per market"],
            ["industry_ranking", "Independent industry rankings (for example RealTrends)"],
            ["government", ".gov domains"],
            ["other", "Everything else"],
          ]}
        />
      </ArticleSection>
      <ArticleSection title="Competitor source mapping">
        <p>For a market, the source graph aggregates every citation across its runs: per domain, the number of citations, the number and share of answers citing it, how many runs and which assistants cited it, its top URLs, and which companies were mentioned or recommended in the answers that cited it. For each tracked team it records how often its own domain was cited and in which third-party domains it is present. A graph is only reported when at least 10 citations exist. Per client, a citation profile lists each competitor&rsquo;s cited domains and the source gap: domains competitors are cited from where the client is absent.</p>
      </ArticleSection>
      <ArticleSection title="Entity clarity">
        <p>Before any count, the classifier decides whether a mention is the same entity as the client (name collisions with another tracked brand are flagged as entity ambiguity). Every name and alias is registered per market, alias collisions are blocked, and a claimed zero is only released when every registered name has been searched across all valid answers. Detectors flag two entity conditions: unbranded mention rate below 10% while the top rival is above 30%, and branded recognition below 50%, which usually means a name collision or a missing public record.</p>
      </ArticleSection>
      <ArticleSection title="Evidence gap scoring">
        <p>Gap findings are typed (entity, branded_recognition, recommendation, citation, category_share, source_target, displacement), each with severity, an opportunity score, a confidence in 0 to 1, and an epistemic label (observation, supported finding, working hypothesis, unknown) with the evidence ids behind it. Opportunity score = 100 × (0.30 × category value + 0.25 × severity + 0.20 × execution + 0.15 × attainability + 0.10 × speed). Bands: do now at 70 or more, do next at 50, test at 30, otherwise low priority.</p>
      </ArticleSection>
      <ArticleSection title="Source priority (ACVS)">
        <p>Each candidate domain gets an AI Citation Value Score from ten components, weighted: citation frequency 0.15, prompt relevance 0.10, commercial intent 0.15, cross-engine presence 0.10, recommendation influence 0.15, competitor density 0.10, client gap 0.10, feasibility 0.05, source quality 0.05, persistence 0.05. Missing components are redistributed, never guessed. Source quality by type ranges from 1.0 for news, government and industry rankings to 0.2 for the client&rsquo;s own site. A score of 50 or more is treated as strong; the score, its components and a plain-language explanation are stored with the version that produced them.</p>
      </ArticleSection>
      <ArticleSection title="Remeasurement and link health">
        <p>Every evidence URL is re-checked on a rolling basis and recorded as healthy, redirected, broken, unavailable or superseded in an append-only ledger; a broken link is shown as broken, never dropped. Engagements freeze measurement snapshots over immutable runs and compare them at mid-term and end-of-term; a changed instrument is reported as not comparable. Technical scans of a client&rsquo;s own site record robots, sitemaps, pages fetched and prioritized findings under the same do-now, do-next, test bands.</p>
      </ArticleSection>
      <ArticleSection title="Where this appears">
        <p>Inside the platform: the market sources view, the per-project citation sources view with ACVS, competitor citation profiles, the evidence gaps view and the technical scan view. In every audit and private report: the section &ldquo;Where AI got its information&rdquo;, which lists the top cited domains for that benchmark with their category (owned, platform, earned, competitor).</p>
      </ArticleSection>
      <ArticleSection title="What citation intelligence does not claim">
        <p>A cited domain is evidence that the assistant consulted it, not proof that it caused the recommendation. Scores rank where to look; they do not predict that appearing on a source will change an answer. Provider citation lists are partial and change over time.</p>
      </ArticleSection>
    </ArticleShell>
  );
}
