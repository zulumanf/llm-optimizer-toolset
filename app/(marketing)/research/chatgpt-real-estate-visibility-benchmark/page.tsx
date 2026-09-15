/** Flagship benchmark page: definitions, chart-ready tables and citation
 * format. Every number is read from the approved-claims registry. The name
 * follows the public route; the instrument note says what it actually is. */
import type { Metadata } from "next";
import { JsonLd } from "@/components/marketing/json-ld";
import { ArticleSection, ArticleShell, CiteThis, DataTable, Definitions, DownloadLinks, InstrumentNote, SourceLinks, UpdateHistory } from "@/components/marketing/research";
import { APPROVED_CLAIMS, claim, claimNumber, domainRows, pct } from "@/lib/marketing/claims";
import { articleLd, breadcrumbLd, canonicalUrl, datasetLd, marketingMetadata } from "@/lib/marketing/seo";

const PATH = "/research/chatgpt-real-estate-visibility-benchmark";
const PUBLISHED = "2026-09-14";
const VERSION = "v1.0 (2026-09-14)";
export const metadata: Metadata = marketingMetadata(PATH, "article");

export default function FlagshipBenchmarkPage() {
  const agg = claim("corpus-aggregate");
  const n = (k: string) => claimNumber(agg.id, k);
  const oa = n("openai_answers");
  const px = n("perplexity_answers");
  const markets = APPROVED_CLAIMS.filter((c) => c.status === "approved" && c.id.startsWith("mkt-"));
  const jc = claim("jc-2026-08-31-by-provider");
  const cats = claim("corpus-prompt-categories");
  const catRows = Object.keys(cats.values).filter((k) => k.endsWith(":prompts")).map((k) => k.split(":")[1] as string)
    .map((c) => [c, cats.values[`category:${c}:prompts`] as number, cats.values[`category:${c}:runs`] as number] as const).sort((a, b) => b[1] - a[1]);
  const classes = claim("corpus-source-classes");
  const classRows = Object.keys(classes.values).filter((k) => k.endsWith(":pairs")).map((k) => k.split(":")[1] as string)
    .map((c) => [c, classes.values[`class:${c}:pairs`] as number, classes.values[`class:${c}:domains`] as number] as const).sort((a, b) => b[1] - a[1]);
  const domains = domainRows("corpus-top-domains").slice(0, 10);
  return (
    <ArticleShell
      path={PATH}
      eyebrow="Flagship benchmark"
      lede={`When buyers and sellers ask an AI assistant who to hire, how often does it name someone, whom does it concentrate on, and what does it cite? Across ${n("runs")} benchmark runs in ${n("projects")} U.S. markets, the OpenAI web-search API instrument named a specific agent or team in ${n("openai_answersWithRecommendation").toLocaleString("en-US")} of ${oa.toLocaleString("en-US")} answers (${pct(n("openai_answersWithRecommendation"), oa)}) and Perplexity in ${n("perplexity_answersWithRecommendation").toLocaleString("en-US")} of ${px.toLocaleString("en-US")} (${pct(n("perplexity_answersWithRecommendation"), px)}). This page defines every term, publishes the chart-ready tables, and states what the benchmark cannot show.`}
      meta={[
        { label: "Benchmark window", value: agg.benchmarkDate },
        { label: "Markets", value: `${n("projects")} U.S. metropolitan markets` },
        { label: "Instruments", value: "the OpenAI model (gpt-5.4-mini, web search, API); Perplexity (sonar, API)" },
        { label: "Prompts × repetitions", value: "up to 64 prompts × 4 repetitions per assistant per market (16 × 4 for Jersey City)" },
        { label: "Valid answers", value: `${oa.toLocaleString("en-US")} OpenAI, ${px.toLocaleString("en-US")} Perplexity` },
        { label: "Version", value: VERSION },
      ]}
      related={["/methodology", "/citation-intelligence", "/research/ai-citation-sources-real-estate", "/research/jersey-city-ai-visibility-report", "/research/real-estate-ai-recommendation-statistics", "/research/real-estate-ai-visibility-index"]}
    >
      <JsonLd
        data={[
          breadcrumbLd(PATH),
          articleLd(PATH, { published: PUBLISHED, benchmarkWindow: agg.benchmarkDate }),
          datasetLd(PATH, { published: PUBLISHED, temporalCoverage: agg.benchmarkDate.replace(" to ", "/"), spatialCoverage: "17 metropolitan markets, United States", variables: ["answers naming a specific agent or team", "distinct entities recommended per market", "answers citing a domain", "prompt category coverage"] }),
        ]}
      />
      <InstrumentNote />
      <ArticleSection title="Executive summary">
        <p>The benchmark asks the same frozen set of buyer and seller questions of two search-enabled assistants, four times each, and counts what comes back. In the window above, {pct(n("openai_answersWithRecommendation"), oa)} of OpenAI-model answers and {pct(n("perplexity_answersWithRecommendation"), px)} of Perplexity answers named at least one specific agent or team as a recommendation; the rest gave general guidance, named only brokerages or portals, or declined to pick. In every completed market, the most-recommended entity on the OpenAI model appeared in fewer than one answer in eight, and between {Math.min(...markets.map((m) => m.values.openai_entitiesRecommended as number))} and {Math.max(...markets.map((m) => m.values.openai_entitiesRecommended as number))} different entities were recommended per market. Citations concentrate on national listing portals: zillow.com, realtor.com and homes.com lead every market.</p>
      </ArticleSection>
      <ArticleSection title="What the benchmark measures">
        <p>Outputs, not internals. For each answer we record whether it names any agent or team, which entities it recommends, in what position, and which URLs it cites. We have no access to any model&rsquo;s ranking system and make no claim about why an answer was produced. The OpenAI web-search benchmark calls the OpenAI Responses API with the web search tool enabled and provider-default sampling; the Perplexity benchmark calls the Perplexity API (sonar). Both are recorded per answer.</p>
      </ArticleSection>
      <ArticleSection title="Why AI answers vary">
        <p>The same question asked twice of the same model returns different text, and often different names, because sampling is stochastic and the web-search step retrieves different pages on different calls. That is why every prompt is asked 4 separate times per assistant and why a single answer is treated as an anecdote. Answers also drift over weeks as model builds and indexes change, so every figure carries its capture date, and two measurements taken with different instruments are reported as not comparable rather than compared.</p>
      </ArticleSection>
      <ArticleSection title="Prompt taxonomy">
        <p>Questions are generated deterministically from a versioned market pack: a question template crossed with area, property type and price tier, with the city always state-qualified. Five categories exist (recommendation, comparison, how-to, branded, problem); the corpus is almost entirely recommendation-intent, as the coverage table shows. Questions that name the entity under test are excluded from its counts.</p>
        <DataTable caption="Prompt-category coverage: frozen prompts per category across the corpus runs, and the number of runs containing that category." columns={["Category", "Frozen prompts", "Runs containing it"]} rows={catRows.map((r) => [r[0], r[1], r[2]])} />
      </ArticleSection>
      <ArticleSection title="Definitions">
        <Definitions
          items={[
            { term: "Valid answer", definition: "A captured response with no API error and no refusal, on a prompt not held out from scoring. Only valid answers enter a denominator." },
            { term: "Named", definition: "The answer contains the name of at least one specific agent or team (brokerages and portals alone do not count)." },
            { term: "Mentioned", definition: "A specific tracked entity appears in the answer, whether or not the answer recommends it." },
            { term: "Recommended", definition: "The answer says to use or contact that entity, as judged by the versioned classifier. Recommendation share = answers recommending the entity ÷ valid answers, one credit per answer." },
            { term: "Cited", definition: "The provider attached the URL to the answer as a source. Citation share of a domain = answers citing that domain ÷ valid answers." },
            { term: "Retrieved but not cited", definition: "A page the search step may have read without attaching it to the answer. Not observable through the APIs used here; never counted." },
            { term: "Source domain", definition: "The registered domain of a cited URL, with tracking parameters stripped." },
            { term: "Answer-domain pair", definition: "One answer citing one domain at least once; repeated citations of a domain inside one answer count once." },
            { term: "Not observed", definition: "Zero occurrences in the valid answers of a completed run with every registered alias searched. Distinct from not tested (no run covers it) and unknown (the run is partial or the entity is unverified)." },
          ]}
        />
      </ArticleSection>
      <ArticleSection title="Results: named-agent rate by instrument">
        <DataTable
          caption={`Answers naming at least one specific agent or team as a recommendation, ${agg.benchmarkDate}, ${n("runs")} runs.`}
          columns={["Instrument", "Valid answers", "Answers with a recommendation", "Share", "Answers with a citation", "Share"]}
          rows={[
            ["the OpenAI model (gpt-5.4-mini, web search, API)", oa, n("openai_answersWithRecommendation"), pct(n("openai_answersWithRecommendation"), oa), n("openai_answersWithCitation"), pct(n("openai_answersWithCitation"), oa)],
            ["Perplexity (sonar, API)", px, n("perplexity_answersWithRecommendation"), pct(n("perplexity_answersWithRecommendation"), px), n("perplexity_answersWithCitation"), pct(n("perplexity_answersWithCitation"), px)],
          ]}
        />
      </ArticleSection>
      <ArticleSection title="Results: recommendation rate by market">
        <DataTable
          caption="Completed market benchmarks (256 valid answers per assistant unless stated) plus the 64-answer Jersey City weekly baseline. Entities are not named."
          columns={["Market", "Capture date", "OpenAI: with recommendation", "OpenAI: entities", "OpenAI: top entity", "Perplexity: with recommendation", "Perplexity: entities", "Perplexity: top entity"]}
          rows={[
            ...markets.map((m) => [m.market ?? m.id, m.benchmarkDate, `${m.values.openai_answersWithRecommendation} / ${m.values.openai_answers}`, m.values.openai_entitiesRecommended as number, `${m.values.openai_topEntityRecommendations} / ${m.values.openai_answers}`, `${m.values.perplexity_answersWithRecommendation} / ${m.values.perplexity_answers}`, m.values.perplexity_entitiesRecommended as number, `${m.values.perplexity_topEntityRecommendations} / ${m.values.perplexity_answers}`]),
            ["Jersey City, NJ (16 × 4)", jc.benchmarkDate, `${jc.values.openai_answersWithRecommendation} / ${jc.values.openai_answers}`, jc.values.openai_entitiesRecommended as number, `${jc.values.openai_topEntityRecommendations} / ${jc.values.openai_answers}`, `${jc.values.perplexity_answersWithRecommendation} / ${jc.values.perplexity_answers}`, jc.values.perplexity_entitiesRecommended as number, `${jc.values.perplexity_topEntityRecommendations} / ${jc.values.perplexity_answers}`],
          ]}
        />
      </ArticleSection>
      <ArticleSection title="Results: citation-source frequency">
        <DataTable caption={`Top 10 domains by distinct answers citing them, ${agg.benchmarkDate}. Full top 20 with indexed frequency on the citation-sources report.`} columns={["Domain", "Answers citing it", "OpenAI model", "Perplexity"]} rows={domains.map((d) => [d.domain, d.total, d.openai ?? 0, d.perplexity ?? 0])} />
      </ArticleSection>
      <ArticleSection title="Results: source-class distribution">
        <DataTable caption="Answer-domain pairs per source class using the platform's stored label; 'other' is unlabelled, and most cited domains are unlabelled." columns={["Source class", "Answer-domain pairs", "Distinct domains"]} rows={classRows.map((r) => [r[0], r[1], r[2]])} />
      </ArticleSection>
      <ArticleSection title="Authority versus AI visibility">
        <p>Where a licensed production record (RealTrends verified closed volume, same year, same entity level) exists for the teams in a market, the platform places recommendation counts next to it. No such contrast is published on this page yet: the one candidate (Greenville, SC, 2026-08-31) is held until the zero-count and entity-resolution checks of the evidence release gate have been run for the entity concerned and the licence terms for quoting production figures are confirmed. It will appear here anonymized, with both numbers and their sources, or not at all.</p>
      </ArticleSection>
      <ArticleSection title="Methodology">
        <p>Frozen, versioned prompt sets; 4 repetitions per assistant; raw answers stored immutably before any parsing; a deterministic alias pass followed by a language-model classifier with a confidence score, an independent verifier on low-confidence rows and human review below 0.7, with corrections written as new revisions; citations extracted from the stored payload; counts recomputed from the raw rows by a verification script before publication. The full methodology, including the evidence release gate, is on the methodology page.</p>
      </ArticleSection>
      <ArticleSection title="Valid-answer rules and failure handling">
        <p>A call that errors or is refused is recorded as failed and excluded from every denominator; it is never counted as a zero for anyone. A run with failed calls is labelled partial and its per-assistant denominators shrink accordingly; several Perplexity runs in the cohort of 2026-08-31 are partial for this reason, which is why the two instruments cover different run sets. Prompts held out from scoring are excluded from denominators.</p>
      </ArticleSection>
      <ArticleSection title="Model and provider distinction">
        <p>&ldquo;ChatGPT&rdquo; in this page&rsquo;s title is the consumer product most readers know. The instrument is the OpenAI model behind it, called through the OpenAI API with web search enabled and provider-default settings. Consumer sessions add personalization, memory, location and interface choices we do not reproduce, so a reader&rsquo;s own ChatGPT answer may differ. The platform supports staff-recorded consumer-session observations as a separate, manually collected tier; none are included in these figures.</p>
      </ArticleSection>
      <ArticleSection title="Anonymization policy">
        <p>No agent, team, prospect or client is named on any public page. Entity-level figures are published only as counts (how many entities, how often the top one appeared). Cited domains are named when they are public websites of portals, directories, brokerages, publishers or other businesses; domains owned by individual agents or teams in a sample are bucketed. The public dataset applies the same rules and additionally names a domain only if it was cited in at least two markets.</p>
      </ArticleSection>
      <ArticleSection title="Limitations">
        <p>API captures, not consumer sessions. One capture window per market. Our question set, not observed buyer queries, and almost entirely recommendation-intent. Markets chosen for our own prospecting, weighted to the mid-Atlantic and Southeast. Provider citation lists are partial. Nothing here says a recommendation produced a client, that an absence cost one, why an entity was recommended, or how many buyers ask these questions. Classifications can be revised; when a recount changes a published figure the update history says so.</p>
      </ArticleSection>
      <DownloadLinks />
      <UpdateHistory items={[{ date: PUBLISHED, note: "First publication, v1.0." }, ...(agg.updateHistory ?? [])]} />
      <SourceLinks items={[{ label: "Methodology", href: "/methodology" }, { label: "AI Citation Sources in Real Estate", href: "/research/ai-citation-sources-real-estate" }, { label: "Jersey City AI Visibility Report", href: "/research/jersey-city-ai-visibility-report" }, { label: "Public dataset release notes (repository)", href: "/research/ai-citation-sources-real-estate#downloads" }]} />
      <CiteThis title="ChatGPT Real Estate Visibility Benchmark" market={`${n("projects")} U.S. markets`} captureDate={agg.benchmarkDate} version={VERSION} url={canonicalUrl(PATH)} />
    </ArticleShell>
  );
}
