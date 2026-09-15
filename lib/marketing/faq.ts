/**
 * Public FAQ — one list, rendered on /faq and (abridged) on the homepage,
 * and emitted as FAQPage structured data. Answers state what the platform
 * actually does today; anything not operational is said not to be.
 */
export type FaqItem = { q: string; a: string };

export const FAQ: readonly FaqItem[] = [
  {
    q: "Can you guarantee that ChatGPT will recommend us?",
    a: "No. AI outputs are probabilistic, models change frequently, and we do not control their recommendation systems. We improve measurable inputs and representation, then track whether observable outcomes change.",
  },
  {
    q: "Which AI systems do you actually test today?",
    a: "Our standard benchmark asks the OpenAI model (gpt-5.4-mini with web search, through the API) and Perplexity (sonar, through the API). Adapters for Anthropic and Google models exist in the platform but are not part of the standard benchmark. The exact instruments are named in every report.",
  },
  {
    q: "Are your results the same as what ChatGPT shows a buyer?",
    a: "Not necessarily. We capture direct answers from the OpenAI model through its API with web search enabled, not screenshots of the consumer ChatGPT app. The two share a model but not every setting, so we label captures as the OpenAI model and invite readers to verify with their own ChatGPT session.",
  },
  {
    q: "How is this different from SEO?",
    a: "SEO focuses on the discoverability and ranking of webpages. AI visibility examines whether AI systems understand and surface the brand itself across recommendation-oriented questions. The disciplines overlap, but the measurement problem is different.",
  },
  {
    q: "How do you know what influences an AI answer?",
    a: "We distinguish between what we can directly observe and what we infer. We capture model outputs, citations, sources, competitive patterns, and entity information. When causation cannot be established, we label conclusions as hypotheses rather than facts.",
  },
  {
    q: "How many questions and repetitions are in a benchmark?",
    a: "A market benchmark uses a versioned set of up to 64 buyer and seller questions, each asked 4 times per assistant, so a two-assistant benchmark yields up to 512 captured answers. Smaller prospect benchmarks use 16 questions. Every count we publish states its denominator.",
  },
  {
    q: "What happens to answers that fail?",
    a: "An answer that errors or is refused is recorded as failed and excluded from the denominator. It is never filled in, and coverage is reported next to every rate. A single failed answer is not treated as a zero.",
  },
  {
    q: "How long does this take?",
    a: "Measurement can begin immediately after onboarding. Underlying signals and recommendation outcomes move on different timelines, so we track leading indicators as well as recommendation results rather than promising a fixed deadline.",
  },
  {
    q: "Is this just content creation?",
    a: "No. Content may be one intervention, but the system also covers entity clarity, third-party authority, citations, structured information, technical accessibility, and topical associations, depending on what the diagnosis actually shows.",
  },
  {
    q: "Do we need to replace our SEO agency?",
    a: "Usually not. Strong SEO, PR, and content work supports AI visibility. Our job is to identify the additional recommendation-specific gaps and coordinate with existing partners where useful.",
  },
  {
    q: "Do you publish client results or case studies?",
    a: "Not yet. We publish aggregate, anonymized benchmark findings on the research pages. A named case study appears only with the client's written approval and verified measurements.",
  },
  {
    q: "What access do you need?",
    a: "It depends on the engagement. We minimize required permissions and define exactly what is needed during onboarding.",
  },
  {
    q: "What happens if our AI visibility is already strong?",
    a: "Then the audit should show that. We would rather tell you there is no meaningful problem than manufacture one.",
  },
];

/** Homepage shows the first N; the full list lives on /faq. */
export const HOME_FAQ_COUNT = 6;
