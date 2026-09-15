/** Statistics page scoped strictly to our own benchmark corpus. It says out
 * loud that it holds no consumer search-volume data. */
import type { Metadata } from "next";
import { JsonLd } from "@/components/marketing/json-ld";
import { ArticleSection, ArticleShell, CiteThis, DataTable, Definitions, InstrumentNote, SourceLinks, UpdateHistory } from "@/components/marketing/research";
import { canonicalUrl } from "@/lib/marketing/seo";
import { APPROVED_CLAIMS, claim, claimNumber, pct } from "@/lib/marketing/claims";
import { articleLd, breadcrumbLd, marketingMetadata } from "@/lib/marketing/seo";

const PATH = "/research/real-estate-ai-recommendation-statistics";
const PUBLISHED = "2026-09-13";
export const metadata: Metadata = marketingMetadata(PATH, "article");

export default function StatisticsPage() {
  const agg = claim("corpus-aggregate");
  const n = (k: string) => claimNumber(agg.id, k);
  const oa = n("openai_answers");
  const px = n("perplexity_answers");
  const markets = APPROVED_CLAIMS.filter((c) => c.status === "approved" && c.id.startsWith("mkt-"));
  return (
    <ArticleShell
      path={PATH}
      eyebrow="Research report"
      lede="Statistics from our own captured answers, not from consumer search logs or any adoption survey. They answer one narrow question: when a search-enabled AI assistant is asked who to hire in a U.S. real-estate market, how often does it name someone, how concentrated are its picks, and how often does it cite sources? We hold no data on how many buyers ask these questions."
      meta={[
        { label: "Benchmark window", value: agg.benchmarkDate },
        { label: "Answers", value: `${oa.toLocaleString("en-US")} OpenAI, ${px.toLocaleString("en-US")} Perplexity` },
        { label: "Instruments", value: "OpenAI gpt-5.4-mini + web search (API); Perplexity sonar (API)" },
      ]}
      related={["/methodology", "/research/ai-citation-sources-real-estate", "/research/jersey-city-ai-visibility-report", "/faq"]}
    >
      <JsonLd data={[breadcrumbLd(PATH), articleLd(PATH, { published: PUBLISHED, benchmarkWindow: agg.benchmarkDate })]} />
      <InstrumentNote />
      <ArticleSection title="How often an assistant names a specific agent or team">
        <DataTable
          caption={`Answers naming at least one specific agent or team as a recommendation, ${agg.benchmarkDate}, ${n("runs")} runs in ${n("projects")} markets.`}
          columns={["Assistant", "Valid answers", "Answers with a recommendation", "Share", "Answers with a citation", "Share"]}
          rows={[
            ["OpenAI model (gpt-5.4-mini + web search, API)", oa, n("openai_answersWithRecommendation"), pct(n("openai_answersWithRecommendation"), oa), n("openai_answersWithCitation"), pct(n("openai_answersWithCitation"), oa)],
            ["Perplexity (sonar, API)", px, n("perplexity_answersWithRecommendation"), pct(n("perplexity_answersWithRecommendation"), px), n("perplexity_answersWithCitation"), pct(n("perplexity_answersWithCitation"), px)],
          ]}
        />
        <p>
          The other answers gave general guidance, named only brokerages or portals, or declined to pick. Question sets mix direct recommendation asks with neighborhood, property-type and price-tier variants, so the share is a property of our question set as much as of the assistant.
        </p>
      </ArticleSection>
      <ArticleSection title="How concentrated the recommendations are, by market">
        <DataTable
          caption="Completed market benchmarks, 64 questions × 4 repetitions = 256 valid answers per assistant. 'Entities' is the number of different agents or teams recommended at least once; 'top entity' is the highest single-entity count out of 256. Entities are not named."
          columns={["Market", "Date", "OpenAI: answers with a recommendation", "OpenAI: entities", "OpenAI: top entity", "Perplexity: answers with a recommendation", "Perplexity: entities", "Perplexity: top entity"]}
          rows={markets.map((m) => [
            m.market ?? m.id,
            m.benchmarkDate,
            `${m.values.openai_answersWithRecommendation as number} / ${m.values.openai_answers as number}`,
            m.values.openai_entitiesRecommended as number,
            `${m.values.openai_topEntityRecommendations as number} / ${m.values.openai_answers as number}`,
            `${m.values.perplexity_answersWithRecommendation as number} / ${m.values.perplexity_answers as number}`,
            m.values.perplexity_entitiesRecommended as number,
            `${m.values.perplexity_topEntityRecommendations as number} / ${m.values.perplexity_answers as number}`,
          ])}
        />
        <p>
          Concentration varies by market and by assistant. In every market listed, the most-recommended entity on the OpenAI model appeared in fewer than one answer in eight. The Wilmington, Delaware figures were recounted on 2026-09-14 after a classification revision (see update history).
        </p>
      </ArticleSection>
      <ArticleSection title="Statistics we do not have">
        <p>We have not measured, and therefore do not state: how many buyers or sellers use AI assistants to choose an agent; what share of real-estate searches happen in AI assistants versus web search; conversion from an AI recommendation to a listing appointment; or results inside consumer apps such as ChatGPT, Gemini or Google AI Overviews. Any such figure attributed to Recommended First is not ours.</p>
      </ArticleSection>
      <ArticleSection title="Definitions">
        <Definitions
          items={[
            { term: "Valid answer", definition: "A captured response with no API error and no refusal. Failed calls are excluded from denominators and reported as coverage." },
            { term: "Recommendation", definition: "The answer says to use or contact a specific agent or team, per the versioned classifier; questions that name the entity are excluded from its count." },
            { term: "Top entity", definition: "The single agent or team with the most answers recommending it in that market and assistant." },
          ]}
        />
      </ArticleSection>
      <ArticleSection title="Limitations">
        <p>API captures with provider-default sampling; one benchmark day per market; our question sets rather than observed buyer queries; markets chosen for prospecting rather than sampled. None of these figures predicts a future answer or a business outcome.</p>
      </ArticleSection>
      <ArticleSection title="Verification">
        <p>Figures are read from the approved-claims registry and recounted from the immutable raw answers with the platform&rsquo;s verification script (last verified {agg.lastVerified}).</p>
      </ArticleSection>
      <UpdateHistory items={[{ date: PUBLISHED, note: "First publication." }, ...(agg.updateHistory ?? []), ...markets.flatMap((m) => (m.updateHistory ?? []).map((u) => ({ ...u, note: `${m.market}: ${u.note}` })))]} />
      <SourceLinks items={[{ label: "Methodology", href: "/methodology" }, { label: "Public dataset downloads", href: "/research/ai-citation-sources-real-estate#downloads" }, { label: "Flagship benchmark", href: "/research/chatgpt-real-estate-visibility-benchmark" }]} />
      <CiteThis title="AI Recommendation Statistics for Real Estate" market={`${n("projects")} U.S. markets`} captureDate={agg.benchmarkDate} version="v1.0 (2026-09-14)" url={canonicalUrl(PATH)} />
    </ArticleShell>
  );
}
