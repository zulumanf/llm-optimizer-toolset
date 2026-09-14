/**
 * Third-party vendor facts used on comparison pages. Every entry is the
 * vendor's own self-description, quoted from the cited URL on the retrieval
 * date. Recommended First has not used or tested these products; nothing
 * here is an evaluation, and unknown attributes stay "not verified".
 */
export type VendorFact = { attribute: string; statement: string; sourceUrl: string; retrieved: string };

export type Vendor = { key: string; name: string; website: string; facts: readonly VendorFact[] };

const RETRIEVED = "2026-09-14";

export const VENDORS: readonly Vendor[] = [
  {
    key: "sorn-ai",
    name: "Sorn AI",
    website: "https://sorn.ai/",
    facts: [
      { attribute: "Systems monitored (vendor statement)", statement: "Monitors ChatGPT, Gemini, Perplexity and Claude in parallel.", sourceUrl: "https://go.sorn.ai/", retrieved: RETRIEVED },
      { attribute: "Cadence (vendor statement)", statement: "Weekly visibility scores across four LLMs.", sourceUrl: "https://go.sorn.ai/", retrieved: RETRIEVED },
      { attribute: "Experiments (vendor statement)", statement: "An 'Experiment Engine' that runs controlled tests against prompt clusters.", sourceUrl: "https://go.sorn.ai/", retrieved: RETRIEVED },
      { attribute: "Setup (vendor statement)", statement: "Described as running within 15 minutes.", sourceUrl: "https://go.sorn.ai/", retrieved: RETRIEVED },
    ],
  },
  {
    key: "rankfender",
    name: "Rankfender",
    website: "https://rankfender.com/",
    facts: [
      { attribute: "Systems monitored (vendor statement)", statement: "Monitors seven AI systems, including ChatGPT, Gemini, Perplexity and Claude.", sourceUrl: "https://rankfender.com/en/features/", retrieved: RETRIEVED },
      { attribute: "Metrics (vendor statement)", statement: "0–100 scores per platform, trend data, query-level attribution, competitive share of voice, sentiment analysis.", sourceUrl: "https://rankfender.com/en/learn/ai-visibility/", retrieved: RETRIEVED },
      { attribute: "Real estate (vendor statement)", statement: "Publishes a real-estate solution page.", sourceUrl: "https://rankfender.com/en/ai-visibility-for/real-estate/", retrieved: RETRIEVED },
      { attribute: "Outcome claim (vendor statement, not verified)", statement: "States an average 37% increase in qualified leads for its clients. Recommended First has not verified this and publishes no comparable figure of its own.", sourceUrl: "https://rankfender.com/en/about/", retrieved: RETRIEVED },
    ],
  },
];

export function vendor(key: string): Vendor {
  const v = VENDORS.find((x) => x.key === key);
  if (!v) throw new Error(`Unknown vendor ${key}`);
  return v;
}

/** What Recommended First actually does, verified against the platform. */
export const RF_FACTS: readonly { attribute: string; statement: string }[] = [
  { attribute: "Systems measured", statement: "The OpenAI model (gpt-5.4-mini, web search, API) and Perplexity (sonar, API). Anthropic and Google adapters exist and are used only when an engagement calls for them. No consumer-app scraping." },
  { attribute: "Unit of measurement", statement: "Counts of captured answers with their denominators: named, mentioned, recommended, cited. No 0–100 visibility score is published as a ranking; the diagnostic composite is versioned and labelled." },
  { attribute: "Repetition and capture", statement: "Frozen prompt sets, 4 repetitions per assistant, raw answers stored immutably before classification, failed calls excluded from denominators." },
  { attribute: "Classification", statement: "Alias scan, language-model classifier with confidence, independent verifier, human review below 0.7, corrections as new revisions." },
  { attribute: "Citations", statement: "Extracted from provider payloads; domain counted once per answer; source taxonomy and per-project citation profiles." },
  { attribute: "Production comparison", statement: "Recommendation counts placed next to licensed RealTrends verified production, same year, same measure, same entity level; kept separate, never blended." },
  { attribute: "Public evidence", statement: "Methodology, definitions, research reports and an anonymized dataset are published with denominators and dates." },
  { attribute: "Guarantees", statement: "None. No promised rankings, recommendations, citations, leads or revenue." },
  { attribute: "Delivery model", statement: "An operated measurement and advisory engagement for real estate teams, not self-serve software." },
  { attribute: "Exclusivity", statement: "Direct competitors in one market are not both engineered for the same advantage." },
];
