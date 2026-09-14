/** The eight questions to ask any AI-visibility vendor, with Recommended
 * First's verified answers. Reused by the tools and alternatives pages. */
export const EVALUATION_QUESTIONS: readonly { question: string; why: string; rfAnswer: string }[] = [
  { question: "Which systems are measured, through what surface?", why: "An API instrument and a consumer app are different things; a score that blends them hides the difference.", rfAnswer: "The OpenAI model (gpt-5.4-mini, web search, API) and Perplexity (sonar, API), labelled as such on every page." },
  { question: "Are repetitions run, and how many?", why: "One answer is an anecdote; assistants vary between asks.", rfAnswer: "4 per assistant per question; the pattern is the finding." },
  { question: "Are raw answers kept and shown?", why: "An absence can only be verified against the complete answer set.", rfAnswer: "Immutable raw capture; the full appendix ships with every private report." },
  { question: "Does every number come with a denominator and date?", why: "3 of 40 is a different claim from 30 of 400; last month is not today.", rfAnswer: "Always; the public registry refuses a number without both." },
  { question: "How are recommendations classified, and who reviews the edge cases?", why: "Name collisions and near-misses are common in real estate.", rfAnswer: "Alias scan, LLM classifier with confidence, verifier, human review below 0.7, versioned parser stamped on every row." },
  { question: "Are citations counted per answer or per URL?", why: "Per-URL counts inflate a domain that repeats itself.", rfAnswer: "Once per answer per domain." },
  { question: "Is any outcome guaranteed or any causal effect claimed?", why: "No one controls the model.", rfAnswer: "No guarantees; movement is reported, cause is not claimed." },
  { question: "Is the methodology public and versioned?", why: "A method that cannot be inspected cannot be trusted.", rfAnswer: "Methodology, definitions, research reports and an anonymized dataset are public." },
];
