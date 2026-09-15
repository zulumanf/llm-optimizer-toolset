/** Index page: honest status of a per-market index. No composite score is
 * published until a versioned method exists and coverage is comparable. */
import type { Metadata } from "next";
import { JsonLd } from "@/components/marketing/json-ld";
import { ArticleSection, ArticleShell, CiteThis, DataTable, Definitions, InstrumentNote, SourceLinks, UpdateHistory } from "@/components/marketing/research";
import { APPROVED_CLAIMS, claim, claimNumber, pct } from "@/lib/marketing/claims";
import { articleLd, breadcrumbLd, canonicalUrl, marketingMetadata } from "@/lib/marketing/seo";

const PATH = "/research/real-estate-ai-visibility-index";
const PUBLISHED = "2026-09-14";
export const metadata: Metadata = marketingMetadata(PATH, "article");

export default function VisibilityIndexPage() {
  const agg = claim("corpus-aggregate");
  const markets = APPROVED_CLAIMS.filter((c) => c.status === "approved" && c.id.startsWith("mkt-"));
  return (
    <ArticleShell
      path={PATH}
      eyebrow="Research report"
      lede="An index that ranks markets or teams by AI visibility does not yet exist here, and this page says so. What exists is a per-market coverage table from completed benchmarks and a defined method for what an index would need before it is published. The table below is coverage, not a ranking."
      meta={[
        { label: "Status", value: "v0 — coverage table only; no composite score" },
        { label: "Benchmark window", value: agg.benchmarkDate },
        { label: "Instruments", value: "the OpenAI model (gpt-5.4-mini, web search, API); Perplexity (sonar, API)" },
      ]}
      related={["/research/chatgpt-real-estate-visibility-benchmark", "/research/real-estate-ai-recommendation-statistics", "/methodology"]}
    >
      <JsonLd data={[breadcrumbLd(PATH), articleLd(PATH, { published: PUBLISHED, benchmarkWindow: agg.benchmarkDate })]} />
      <InstrumentNote />
      <ArticleSection title="Executive summary">
        <p>Five completed market benchmarks (64 prompts × 4 repetitions per assistant, 256 valid answers each) and the Jersey City baseline give comparable coverage figures: how many answers recommended anyone, how many different entities were recommended, and how large the single most-recommended entity was. Nine further markets from the same cohort are partial on Perplexity and are excluded until re-run. A composite index would need a versioned formula, equal coverage across markets and at least two capture dates; none of those conditions is met, so no index value is published.</p>
      </ArticleSection>
      <ArticleSection title="Coverage table (not a ranking)">
        <DataTable
          caption="Per market and assistant: share of valid answers with at least one recommendation, distinct entities recommended, and the most-recommended entity's count. Markets are listed by capture date, not by any score."
          columns={["Market", "Capture date", "OpenAI: with recommendation", "OpenAI: entities", "OpenAI: top entity share", "Perplexity: with recommendation", "Perplexity: entities", "Perplexity: top entity share"]}
          rows={markets.map((m) => [
            m.market ?? m.id,
            m.benchmarkDate,
            pct(m.values.openai_answersWithRecommendation as number, m.values.openai_answers as number),
            m.values.openai_entitiesRecommended as number,
            pct(m.values.openai_topEntityRecommendations as number, m.values.openai_answers as number),
            pct(m.values.perplexity_answersWithRecommendation as number, m.values.perplexity_answers as number),
            m.values.perplexity_entitiesRecommended as number,
            pct(m.values.perplexity_topEntityRecommendations as number, m.values.perplexity_answers as number),
          ])}
        />
      </ArticleSection>
      <ArticleSection title="What an index would require">
        <Definitions
          items={[
            { term: "A versioned formula", definition: "Named components with fixed weights (for example recommendation coverage, entity concentration, citation coverage), published before any value is computed, with new versions applied forward only." },
            { term: "Comparable coverage", definition: "Every market measured with the same prompt pack size, the same repetitions, the same instruments and a complete run on each; partial runs excluded." },
            { term: "At least two capture dates", definition: "An index reading without a prior reading has no direction; weekly baselines exist for Jersey City only." },
            { term: "No entity-level ranking", definition: "The index would describe markets, never rank agents or teams, and would never be presented as a proprietary ranking factor of any AI system." },
          ]}
        />
      </ArticleSection>
      <ArticleSection title="Limitations">
        <p>Coverage figures depend on our question set and on the day of capture. A higher share of answers with a recommendation is not better or worse for any team; it describes how willing the assistant was to name someone for those questions. Perplexity and OpenAI figures are not comparable with each other because the instruments cite and answer differently.</p>
      </ArticleSection>
      <UpdateHistory items={[{ date: PUBLISHED, note: "First publication as v0 coverage table." }, ...markets.flatMap((m) => (m.updateHistory ?? []).map((u) => ({ ...u, note: `${m.market}: ${u.note}` })))]} />
      <SourceLinks items={[{ label: "Flagship benchmark", href: "/research/chatgpt-real-estate-visibility-benchmark" }, { label: "Methodology", href: "/methodology" }]} />
      <CiteThis title="Real Estate AI Visibility Index (v0 coverage table)" market={`${claimNumber(agg.id, "projects")} U.S. markets`} captureDate={agg.benchmarkDate} version="v0 (2026-09-14)" url={canonicalUrl(PATH)} />
    </ArticleShell>
  );
}
