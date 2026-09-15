/**
 * Public methodology page (spec 061, brief §51). Unusually transparent on
 * purpose: the transparency is part of the product. Everything stated here
 * describes how the measurement platform actually works — versioned prompt
 * sets, immutable capture, repeat sampling, confidence classification. If
 * practice changes, this page changes with it.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/marketing/json-ld";
import { breadcrumbLd, marketingMetadata } from "@/lib/marketing/seo";
import { Newsreader } from "next/font/google";
import { CheckVisibilityCta, Eyebrow } from "@/components/marketing/ui";
import { marketingPage } from "@/lib/marketing/constants";

const serif = Newsreader({ subsets: ["latin"], weight: ["400", "500"] });

export const metadata: Metadata = marketingMetadata("/methodology");

const SECTIONS: { title: string; paragraphs: string[] }[] = [
  {
    title: "What we measure",
    paragraphs: [
      "We measure how AI assistants represent and recommend real estate agents and teams: whether a brand is mentioned, whether it is recommended, in what position, alongside which competitors, and supported by which citations. We measure outputs, not internals. We have no access to any model's ranking systems and never claim otherwise.",
    ],
  },
  {
    title: "Prompt universe construction",
    paragraphs: [
      "Each engagement starts from a structured set of questions real buyers and sellers ask: seller-intent, buyer-intent, neighborhood-specific, property-segment-specific, and comparison questions. The set is written for the client's actual market, then locked and versioned before testing begins. Re-testing later uses the same versioned set, so changes in results reflect changes in the answers, not changes in the questions.",
      "Market benchmarks expand a versioned template pack deterministically (no language model writes the questions): question template by area, property type and price tier, with the city always qualified by its state so that Wilmington, Delaware is never measured as Wilmington, North Carolina. A market benchmark holds up to 64 questions; prospect benchmarks hold 16. Questions that name the brand under test are excluded from recommendation counts, because an answer echoing our own question is not visibility.",
    ],
  },
  {
    title: "Model selection and current instruments",
    paragraphs: [
      "Coverage targets the leading AI answer and recommendation platforms. The exact platforms for an engagement are chosen for relevance to the client's market and technical feasibility, and are stated in the measurement plan. We do not list platforms we cannot operationally test.",
      "Instruments in the standard benchmark as of September 2026: the OpenAI model gpt-5.4-mini (2026-03-17 build) with the web search tool enabled, called through the OpenAI Responses API; and Perplexity sonar, called through the Perplexity API. Sampling parameters are provider defaults and are recorded with every answer. These are API captures, not sessions in the consumer ChatGPT app, and we label them as the OpenAI model rather than ChatGPT. Anthropic and Google adapters exist in the platform and are used only when an engagement calls for them.",
    ],
  },
  {
    title: "Testing procedure",
    paragraphs: [
      "Every prompt is asked multiple separate times per platform; the standard benchmark uses 4 repetitions per assistant, so a 64-question, two-assistant benchmark yields 512 captured answers. AI answers vary between asks, so a single response is an anecdote; the pattern across repeated responses is the finding. Each raw response is captured verbatim and stored immutably before any parsing or scoring. Raw responses are never edited, and re-running a measurement never overwrites a previous one.",
      "Failed answers are recorded as failed: an errored or refused call is excluded from the denominator and reported as a coverage gap, never filled in and never counted as a zero for anyone. A run in which some calls failed is labeled partial and its denominators shrink accordingly.",
    ],
  },
  {
    title: "AI Recommendation Share",
    paragraphs: [
      "Our primary KPI: the percentage of relevant tested responses in which the brand appears as a recommendation. We distinguish being mentioned (named at all) from being recommended (the answer says to use them). Counts are reported with their sample sizes, because 3 of 40 is a different claim than 30 of 400.",
      "Classification runs in two stages. A deterministic pass scans each answer for the brand's registered name and aliases and extracts URLs and list structure. A language-model classifier (mention-parser-v2) then judges, for each candidate, whether it is the same entity, whether it was recommended, its list position and sentiment, and records a confidence. Rows below 0.7 confidence go to a second, independent verifier and then to human review; corrections are written as new revisions, never over the original. A parser version is stamped on every row.",
    ],
  },
  {
    title: "Citation and source analysis",
    paragraphs: [
      "Where platforms expose citations, we record which sources the answers drew on and how often. This shows which surfaces the answers lean on in a given market, and where a client is absent from them. Citation presence is evidence for diagnosis, not proof of causation, and we label it accordingly.",
      "Citations are extracted from the stored raw payload, so they can be re-derived at any time: URL citation annotations from the OpenAI Responses API, and the citations and search results arrays from Perplexity. Each citation keeps its URL, domain and kind (in-text or search result). When we count how often a domain is cited we count distinct answers citing it, so an answer that cites zillow.com three times counts once. Cited links are re-checked periodically and a link that breaks is shown as broken, not silently dropped.",
    ],
  },
  {
    title: "Entity analysis",
    paragraphs: [
      "We examine how consistently the brand is represented across the sources AI systems can access: names, roles, markets, specializations, and the agreement between them. Fragmented or contradictory entity information is a common, fixable finding.",
    ],
  },
  {
    title: "Competitive benchmarking",
    paragraphs: [
      "Every measurement includes the competitors named in the same answers. Visibility is relative: 20% recommendation share means one thing when the leader holds 25%, another when the leader holds 70%.",
      "Where a licensed production record exists (RealTrends verified closed volume and sides for the same year), we place recommendation counts next to it. The comparison is only made on the same measure, the same year and the same entity level (team to team, individual to individual); a mismatch is reported when a competitor with lower production on that measure was recommended more often, and the benchmark is no older than 14 days. The two numbers are kept separate: production explains nothing about the AI answer and the AI answer explains nothing about production.",
    ],
  },
  {
    title: "Diagnostic framework",
    paragraphs: [
      "The AI Visibility Index summarizes multiple observable dimensions (recommendation presence, prompt coverage, source coverage, entity consistency, competitive position) into one diagnostic composite. It exists to make progress trackable, and it is versioned: when the scoring method changes, new scores are computed forward and old scores are never rewritten. It is not a proprietary ranking factor and does not represent knowledge of any model's internals.",
    ],
  },
  {
    title: "Intervention tracking",
    paragraphs: [
      "Interventions are documented as discrete, dated actions with their rationale and the evidence that motivated them. This is what makes verification meaningful: a retest can be compared against a record of exactly what changed and when.",
    ],
  },
  {
    title: "Retesting",
    paragraphs: [
      "Follow-up measurement reruns the same versioned prompt set on the same platforms, then compares against the baseline. Differences are reported with sample sizes and confidence, including the differences that went the wrong way. A failed measurement is recorded as failed, never filled in.",
      "Scheduled baselines run weekly on the same frozen prompt set. A benchmark older than 90 days is treated as stale and is not used in new findings without an explicit, dated acknowledgement. If the instrument changes between two measurements (a different model build, a different repetition count), the pair is reported as not comparable rather than compared.",
    ],
  },
  {
    title: "Confidence classification",
    paragraphs: [
      "Every conclusion carries one of four labels. Observed fact: directly captured. Supported finding: backed by multiple pieces of evidence. Working hypothesis: a plausible explanation requiring further testing. Unknown: the evidence is insufficient, and we say so. We do not report false precision; a confidence percentage appears only when an actual statistical model produced it.",
    ],
  },
  {
    title: "Known limitations",
    paragraphs: [
      "AI outputs are probabilistic and change over time, including for reasons unrelated to anything we do. Correlation between a signal and an outcome is not causation. Platform citation data is partial. Sample sizes bound what can be claimed. These limitations appear in every report, next to the findings they qualify, because a methodology that hides its limits isn't one.",
      "What this measurement cannot prove: that a recommendation produced a client, that an absence cost one, how many buyers actually ask AI assistants these questions, or what a consumer sees in a logged-in ChatGPT, Gemini or Google AI Overview session. An absence claim (recommended 0 times) is only made when every registered name and alias of the entity has been searched across the complete set of valid answers and the run is complete.",
    ],
  },
  {
    title: "Methodology versioning",
    paragraphs: [
      "Prompt sets, scoring methods, and parsers are versioned. Historical measurements are never modified; new versions apply forward. When this page's methodology changes, the change is deliberate and dated.",
    ],
  },
];

export default function MethodologyPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <JsonLd data={breadcrumbLd("/methodology")} />
      <Eyebrow>Methodology</Eyebrow>
      <h1
        className={`${serif.className} mt-3 text-balance text-2xl font-medium tracking-tight sm:text-4xl`}
      >
        How we measure AI visibility.
      </h1>
      <p className="mt-2 text-xs text-muted-foreground">
        Last updated {marketingPage("/methodology").updated}. Instruments and
        parameters named here are the ones in use on that date.
      </p>
      <p className="mt-4 max-w-[65ch] text-sm leading-relaxed text-muted-foreground">
        Our measurement methodology, published in full. It is designed around
        the realities of AI systems: outputs vary, models change, and
        correlation is not causation. Transparency about that is not a
        weakness of the product; it is the product.
      </p>

      <div className="mt-12 space-y-10">
        {SECTIONS.map((section, i) => (
          <section key={section.title}>
            <h2 className="text-lg font-medium">
              <span className="text-muted-foreground tabular-nums">
                {String(i + 1).padStart(2, "0")}.
              </span>{" "}
              {section.title}
            </h2>
            {section.paragraphs.map((p) => (
              <p
                key={p.slice(0, 32)}
                className="mt-2 max-w-[65ch] text-sm leading-relaxed text-muted-foreground"
              >
                {p}
              </p>
            ))}
          </section>
        ))}
      </div>

      <nav aria-label="Related" className="mt-12 border-t pt-6 text-sm text-muted-foreground">
        Related: <Link href="/citation-intelligence" className="underline underline-offset-4 hover:text-foreground">Citation intelligence</Link>
        {" · "}
        <Link href="/research" className="underline underline-offset-4 hover:text-foreground">Research</Link>
        {" · "}
        <Link href="/faq" className="underline underline-offset-4 hover:text-foreground">FAQ</Link>
      </nav>

      <div className="mt-14 border-t pt-8">
        <p className={`${serif.className} max-w-[50ch] text-balance text-lg`}>
          Before you optimize AI visibility, measure it.
        </p>
        <div className="mt-4">
          <CheckVisibilityCta />
        </div>
      </div>
    </div>
  );
}
