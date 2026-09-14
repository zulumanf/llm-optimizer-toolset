/** Jersey City report: aggregate figures from one frozen benchmark run, all
 * read from the approved-claims registry. Entities are never named. */
import type { Metadata } from "next";
import { JsonLd } from "@/components/marketing/json-ld";
import { ArticleSection, ArticleShell, CiteThis, DataTable, Definitions, InstrumentNote, SourceLinks, UpdateHistory } from "@/components/marketing/research";
import { claim, claimNumber, domainRows, pct } from "@/lib/marketing/claims";
import { articleLd, breadcrumbLd, canonicalUrl, datasetLd, marketingMetadata } from "@/lib/marketing/seo";

const PATH = "/research/jersey-city-ai-visibility-report";
const PUBLISHED = "2026-09-13";
export const metadata: Metadata = marketingMetadata(PATH, "article");

export default function JerseyCityReportPage() {
  const s = claim("jc-2026-08-31-summary");
  const n = (k: string) => claimNumber(s.id, k);
  const p = (k: string) => claimNumber("jc-2026-08-31-by-provider", k);
  const answers = n("answers");
  const domains = domainRows("jc-2026-08-31-top-domains");
  return (
    <ArticleShell
      path={PATH}
      eyebrow="Research report"
      lede={`When two search-enabled AI assistants were asked ${n("prompts")} buyer and seller questions about hiring a real estate agent in Jersey City, New Jersey, ${n("answersWithRecommendation")} of ${answers} answers named at least one specific agent or team, and ${n("entitiesRecommended")} different entities were recommended in total. This page reports the counts, the sources the answers cited, and what the numbers cannot show.`}
      meta={[
        { label: "Benchmark date", value: s.benchmarkDate },
        { label: "Market", value: "Jersey City, NJ" },
        { label: "Answers", value: `${answers} captured, ${answers} valid` },
        { label: "Instruments", value: "OpenAI gpt-5.4-mini + web search (API); Perplexity sonar (API)" },
      ]}
      related={["/methodology", "/citation-intelligence", "/research/ai-citation-sources-real-estate", "/research/real-estate-ai-search-statistics"]}
    >
      <JsonLd
        data={[
          breadcrumbLd(PATH),
          articleLd(PATH, { published: PUBLISHED, benchmarkWindow: s.benchmarkDate }),
          datasetLd(PATH, {
            published: PUBLISHED,
            temporalCoverage: s.benchmarkDate,
            spatialCoverage: "Jersey City, New Jersey, United States",
            variables: ["answers with at least one recommendation", "distinct entities recommended", "answers citing a domain"],
          }),
        ]}
      />
      <InstrumentNote />
      <ArticleSection title="What we asked and how">
        <p>
          The benchmark used a frozen set of {n("prompts")} recommendation-intent questions written for Jersey City (who to hire to buy or sell, by neighborhood and property type). Each question was asked 4 separate times of each assistant through its API on {s.benchmarkDate}, for {answers} answers. Every raw answer was stored before classification. {n("captured") - answers === 0 ? "No call failed or was refused, so the denominator is the full set." : ""}
        </p>
        <p>
          Recommendation classification followed the published methodology: a deterministic alias scan, a language-model classifier with a confidence score, an independent verifier on low-confidence rows, and human review below 0.7. Counts below are per answer: an entity recommended twice in one answer counts once.
        </p>
      </ArticleSection>
      <ArticleSection title="Recommendation counts">
        <DataTable
          caption={`Per assistant, ${p("openai_answers")} answers each. "Most-recommended entity" is the highest single-entity count; the entity is not named.`}
          columns={["Assistant", "Valid answers", "Answers with a citation", "Distinct entities recommended", "Most-recommended entity"]}
          rows={[
            ["OpenAI model (gpt-5.4-mini + web search, API)", p("openai_answers"), p("openai_answersWithCitation"), p("openai_entitiesRecommended"), `${p("openai_topEntityRecommendations")} of ${p("openai_answers")}`],
            ["Perplexity (sonar, API)", p("perplexity_answers"), p("perplexity_answersWithCitation"), p("perplexity_entitiesRecommended"), `${p("perplexity_topEntityRecommendations")} of ${p("perplexity_answers")}`],
          ]}
        />
        <p>
          Across both assistants, {n("answersWithRecommendation")} of {answers} answers ({pct(n("answersWithRecommendation"), answers)}) named at least one specific agent or team. The remaining answers gave general advice, named only brokerages or portals, or declined to pick. The most-recommended entity on the OpenAI model appeared in {p("openai_topEntityRecommendations")} of {p("openai_answers")} answers; no entity appeared in a majority of answers on either assistant.
        </p>
      </ArticleSection>
      <ArticleSection title="Where the answers got their information">
        <p>
          The {answers} answers carried {n("answerDomainPairs").toLocaleString("en-US")} distinct answer-domain citation pairs across {n("domains")} domains. The table lists the most-cited domains. Domains owned by individual agents or teams in the sample are withheld from this table and described as agent- or team-owned websites. One cited domain, hobokenpainter.com ({claimNumber("jc-2026-08-31-top-domains", "domain:hobokenpainter.com")} answers), is a painting contractor&rsquo;s blog carrying realtor listicles; it was verified live on 2026-09-14 and is shown because it is a third-party business site, not an agent domain.
        </p>
        <DataTable
          caption={`Number of answers (out of ${answers}) citing each domain at least once.`}
          columns={["Domain", "Answers citing it"]}
          rows={domains.map((d) => [d.domain, d.total])}
        />
      </ArticleSection>
      <ArticleSection title="Definitions">
        <Definitions
          items={[
            { term: "Answer", definition: "One captured response to one question from one assistant. Errored or refused calls are excluded from every denominator." },
            { term: "Recommendation", definition: "The answer says to use or contact a specific agent or team, as judged by the versioned classifier. Being mentioned without being recommended does not count." },
            { term: "Distinct entities recommended", definition: "The number of different agents or teams recommended at least once across the answers." },
            { term: "Answer-domain pair", definition: "One answer citing one domain at least once. Repeated citations of the same domain inside one answer count once." },
          ]}
        />
      </ArticleSection>
      <ArticleSection title="Limitations and what this does not show">
        <p>These are API captures of the OpenAI and Perplexity models with provider-default sampling, not sessions in the consumer ChatGPT or Perplexity apps; a buyer&rsquo;s own session may differ. A single benchmark day is a snapshot: answers change between runs and model builds. The question set is ours, not a sample of what buyers actually type, so no figure here says how many buyers ask AI assistants these questions.</p>
        <p>Nothing on this page says that a recommendation produced a client, that an absence cost one, or why a given entity was recommended. Citation presence is evidence for diagnosis, not proof of cause. Individual results for named agents or teams are not published.</p>
      </ArticleSection>
      <ArticleSection title="Verification">
        <p>Every figure on this page is read from an approved-claims registry that is recounted from the immutable raw answers with the platform&rsquo;s verification script (last verified {s.lastVerified}). If a recount ever disagrees, the page is corrected and the date above changes.</p>
      </ArticleSection>
      <UpdateHistory items={[{ date: PUBLISHED, note: "First publication." }, ...(s.updateHistory ?? []), ...(claim("jc-2026-08-31-by-provider").updateHistory ?? [])]} />
      <SourceLinks items={[{ label: "Methodology", href: "/methodology" }, { label: "Public dataset (benchmark RF rows for Jersey City)", href: "/research/ai-citation-sources-real-estate#downloads" }, { label: "Citation intelligence", href: "/citation-intelligence" }]} />
      <CiteThis title="Jersey City AI Visibility Report" market="Jersey City, NJ" captureDate={s.benchmarkDate} version="v1.0 (2026-09-14)" url={canonicalUrl(PATH)} />
    </ArticleShell>
  );
}
