/** Corpus-wide citation-source table across all real-estate market
 * benchmarks in the window; registry-fed, no entity names. */
import type { Metadata } from "next";
import { JsonLd } from "@/components/marketing/json-ld";
import { ArticleSection, ArticleShell, CiteThis, DataTable, Definitions, DownloadLinks, InstrumentNote, SourceLinks, UpdateHistory } from "@/components/marketing/research";
import { claim, claimNumber, domainRows, pct } from "@/lib/marketing/claims";
import { articleLd, breadcrumbLd, canonicalUrl, datasetLd, marketingMetadata } from "@/lib/marketing/seo";

const PATH = "/research/ai-citation-sources-real-estate";
const PUBLISHED = "2026-09-13";
export const metadata: Metadata = marketingMetadata(PATH, "article");

export default function CitationSourcesPage() {
  const agg = claim("corpus-aggregate");
  const n = (k: string) => claimNumber(agg.id, k);
  const rows = domainRows("corpus-top-domains");
  const portalMax = rows[0]?.total ?? 0;
  const classes = claim("corpus-source-classes");
  const classRows = Object.keys(classes.values)
    .filter((k) => k.endsWith(":pairs"))
    .map((k) => k.split(":")[1] as string)
    .map((c) => [c, classes.values[`class:${c}:pairs`] as number, classes.values[`class:${c}:domains`] as number] as const)
    .sort((a, b) => b[1] - a[1]);
  const oa = n("openai_answers");
  const px = n("perplexity_answers");
  return (
    <ArticleShell
      path={PATH}
      eyebrow="Research report"
      lede={`Across ${n("runs")} benchmark runs in ${n("projects")} U.S. real-estate markets, we recorded ${n("answerDomainPairs").toLocaleString("en-US")} distinct answer-domain citation pairs across ${n("domains").toLocaleString("en-US")} domains. National listing portals dominate; the table below gives the top 20 domains with the count for each assistant.`}
      meta={[
        { label: "Benchmark window", value: agg.benchmarkDate },
        { label: "Answers", value: `${oa.toLocaleString("en-US")} OpenAI, ${px.toLocaleString("en-US")} Perplexity` },
        { label: "Instruments", value: "OpenAI gpt-5.4-mini + web search (API); Perplexity sonar (API)" },
      ]}
      related={["/citation-intelligence", "/methodology", "/research/jersey-city-ai-visibility-report", "/research/real-estate-ai-search-statistics"]}
    >
      <JsonLd
        data={[
          breadcrumbLd(PATH),
          articleLd(PATH, { published: PUBLISHED, benchmarkWindow: agg.benchmarkDate }),
          datasetLd(PATH, {
            published: PUBLISHED,
            temporalCoverage: agg.benchmarkDate.replace(" to ", "/"),
            spatialCoverage: "17 metropolitan markets, United States",
            variables: ["answers citing a domain, by assistant"],
          }),
        ]}
      />
      <InstrumentNote />
      <ArticleSection title="Answer-first summary">
        <p>
          When asked to recommend a real estate agent or team, {n("openai_answersWithCitation").toLocaleString("en-US")} of {oa.toLocaleString("en-US")} OpenAI-model answers ({pct(n("openai_answersWithCitation"), oa)}) and {n("perplexity_answersWithCitation").toLocaleString("en-US")} of {px.toLocaleString("en-US")} Perplexity answers ({pct(n("perplexity_answersWithCitation"), px)}) carried at least one citation. The three most-cited domains were zillow.com, realtor.com and homes.com. Perplexity cites more domains per answer than the OpenAI model, which is why its column is larger on most rows.
        </p>
      </ArticleSection>
      <ArticleSection title="Top 20 cited domains">
        <DataTable
          caption={`Distinct answers citing each domain, ${agg.benchmarkDate}. Denominators: ${oa.toLocaleString("en-US")} OpenAI answers, ${px.toLocaleString("en-US")} Perplexity answers. Indexed frequency (listing portals = 100): the most-cited listing portal, zillow.com, is set to 100 and every other domain is its answer count as a share of that.`}
          columns={["Domain", "Answers citing it", "OpenAI model", "Perplexity", "Indexed frequency (listing portals = 100)"]}
          rows={rows.map((r) => [r.domain, r.total, r.openai ?? 0, r.perplexity ?? 0, portalMax > 0 ? Math.round((r.total / portalMax) * 100) : 0])}
        />
      </ArticleSection>
      <ArticleSection title="Units: what an answer-domain pair is and is not">
        <p>
          The corpus unit is the answer-domain pair: one answer citing one domain at least once. It is not a unique-answer count across domains, because one answer usually cites several domains (the {n("answerDomainPairs").toLocaleString("en-US")} pairs come from {n("openai_answersWithCitation").toLocaleString("en-US")} + {n("perplexity_answersWithCitation").toLocaleString("en-US")} citing answers). A domain&rsquo;s row is therefore the number of answers in which it appeared, not a share of all citations. A URL returned as a search result but not attached to the final answer is not in this corpus: only what the provider returned as a citation of the answer is counted, and a retrieved page that was read but not cited is unobserved here.
        </p>
      </ArticleSection>
      <ArticleSection title="Source-class distribution">
        <DataTable
          caption="Answer-domain pairs and distinct domains per source class, using the platform's stored label per domain. 'other' includes every domain the classifier has not labelled; most cited domains are in that bucket, so read this as coverage of the labelled lists, not as a complete taxonomy of the web."
          columns={["Source class", "Answer-domain pairs", "Distinct domains"]}
          rows={classRows.map((r) => [r[0], r[1], r[2]])}
        />
      </ArticleSection>
      <ArticleSection title="How the counts were made">
        <p>
          Citations are extracted from each stored raw answer: URL citation annotations from the OpenAI Responses API and the citations and search-results arrays from Perplexity. Each citation keeps its URL and domain. A domain is counted once per answer no matter how many URLs from it that answer cites. Runs are market benchmarks of up to 64 questions, 4 repetitions per assistant, on frozen prompt sets; QA fixtures and non-real-estate projects are excluded. Answers that errored or were refused are excluded from the denominators.
        </p>
      </ArticleSection>
      <ArticleSection title="Markets in the corpus">
        <p>
          Jersey City NJ; Wilmington DE; Annapolis MD; Princeton NJ; Charleston SC; Savannah GA; Greenville SC; Raleigh NC; Wilmington NC; Richmond VA; Virginia Beach VA; Knoxville TN; Grand Rapids MI; Indianapolis IN; St. Louis MO; Colorado Springs CO; Reno NV. Markets were chosen for our own prospecting, not sampled to represent the country; treat the corpus as a set of case markets.
        </p>
      </ArticleSection>
      <ArticleSection title="Definitions">
        <Definitions
          items={[
            { term: "Citation", definition: "A URL the assistant attached to its answer as a source, as returned by the provider's API. In-text links and search-result attachments are both counted." },
            { term: "Answers citing a domain", definition: "The number of distinct answers in which that domain appears at least once among the citations." },
            { term: "Portal / directory / brokerage", definition: "Our source taxonomy labels each domain (portal, directory, brokerage, review, social, news, local press, industry ranking, government, other); the table shows raw domains so readers can apply their own labels." },
          ]}
        />
      </ArticleSection>
      <ArticleSection title="Exclusion rules and expired domains">
        <p>Excluded from the corpus: QA fixture runs, runs on non-real-estate projects, answers that errored or were refused, the mock and Google providers (used only in early trials), and prompts held out from scoring. Domains are never removed for being unexpected: a painting contractor&rsquo;s blog that AI assistants cite for realtor listicles stays in the data. Cited URLs are re-checked on a rolling basis and recorded as healthy, redirected, broken, unavailable or superseded; a domain that has since expired keeps its historical count, because the count records what the assistant cited on the benchmark day, and the link state is reported next to it inside the platform.</p>
      </ArticleSection>
      <div id="downloads">
        <DownloadLinks />
      </div>
      <ArticleSection title="Limitations">
        <p>Citation lists reflect what each provider returns through its API on the benchmark day, which is partial and changes. A cited domain is not necessarily the source of the recommendation in the answer, and a domain cited often is not thereby one that an agent should try to appear on; we make no causal claim. The corpus is our prospecting markets over six weeks, weighted toward the mid-Atlantic and Southeast, and one assistant (Perplexity) was added on 2026-08-17, so the two columns cover different run sets.</p>
      </ArticleSection>
      <ArticleSection title="Verification">
        <p>Figures are read from the approved-claims registry and recounted from the immutable raw answers with the platform&rsquo;s verification script (last verified {agg.lastVerified}).</p>
      </ArticleSection>
      <UpdateHistory items={[{ date: PUBLISHED, note: "First publication." }, { date: "2026-09-14", note: "Added indexed frequency column, source-class table, unit explanation, exclusion rules and dataset downloads." }]} />
      <SourceLinks items={[{ label: "Methodology", href: "/methodology" }, { label: "Citation intelligence (fields and taxonomy)", href: "/citation-intelligence" }, { label: "Flagship benchmark", href: "/research/chatgpt-real-estate-visibility-benchmark" }]} />
      <CiteThis title="AI Citation Sources in Real Estate" market={`${n("projects")} U.S. markets`} captureDate={agg.benchmarkDate} version="v1.0 (2026-09-14)" url={canonicalUrl(PATH)} />
    </ArticleShell>
  );
}
