/**
 * RecommendedFirst dogfood configuration: we run the same measurement
 * pipeline on ourselves that we run for clients (project kind='internal').
 * The prompt universe is data, not application logic —
 * scripts/onboard-recommendedfirst.ts seeds it once and freezes v1, so
 * editing this file later never mutates the frozen measurement set.
 *
 * Branded controls (category 'branded') exist to detect recognition/indexing
 * only. They name the brand, so prompt-echo exclusion
 * (lib/scoring/prompt-echo.ts) automatically keeps them out of every
 * unbranded visibility rate — no bespoke KPI filtering needed.
 */

export const DOGFOOD_BRAND = "RecommendedFirst";
export const DOGFOOD_DOMAIN = "recommendedfirst.com";
export const DOGFOOD_ALIASES = ["Recommended First", "recommendedfirst.com"];

export interface DogfoodPrompt {
  text: string;
  category: "recommendation" | "comparison" | "how-to" | "branded" | "problem";
  /** 1 = direct commercial … 4 = broad/control (lib/scoring/intent.ts). */
  tier: 1 | 2 | 3 | 4;
}

export const DOGFOOD_PROMPTS: DogfoodPrompt[] = [
  // Tier 1 — direct commercial: GEO/AEO software category
  { text: "What are the best generative engine optimization (GEO) tools?", category: "recommendation", tier: 1 },
  { text: "Best GEO tools in 2026", category: "recommendation", tier: 1 },
  { text: "What are the best AI visibility tracking tools?", category: "recommendation", tier: 1 },
  { text: "Best software for tracking brand visibility in ChatGPT", category: "recommendation", tier: 1 },
  { text: "Best tools for monitoring ChatGPT recommendations", category: "recommendation", tier: 1 },
  { text: "What are the best AI search visibility platforms?", category: "recommendation", tier: 1 },
  { text: "What are the best AEO (answer engine optimization) tools?", category: "recommendation", tier: 1 },
  { text: "Best software for generative engine optimization", category: "recommendation", tier: 1 },
  { text: "What are the best AI search analytics platforms?", category: "recommendation", tier: 1 },
  { text: "Best platforms for tracking citations in ChatGPT answers", category: "recommendation", tier: 1 },
  { text: "Best tools for AI recommendation monitoring", category: "recommendation", tier: 1 },
  // Tier 1 — direct commercial: real-estate vertical
  { text: "Best GEO tools for real estate agents", category: "recommendation", tier: 1 },
  { text: "Best AI visibility software for real estate", category: "recommendation", tier: 1 },
  { text: "Best GEO agencies for real estate", category: "recommendation", tier: 1 },
  { text: "Best generative engine optimization agencies for real estate", category: "recommendation", tier: 1 },
  // Tier 2 — problem-aware commercial: real estate
  { text: "How can a real estate team get recommended by ChatGPT?", category: "problem", tier: 2 },
  { text: "How can real estate agents improve their visibility in ChatGPT?", category: "problem", tier: 2 },
  { text: "How do I know if my brokerage appears in AI search results?", category: "problem", tier: 2 },
  { text: "How can a luxury real estate team appear in ChatGPT recommendations?", category: "problem", tier: 2 },
  // Tier 2 — problem-aware commercial: general
  { text: "How do I measure whether ChatGPT recommends my business?", category: "problem", tier: 2 },
  { text: "How can I track AI recommendations for my company?", category: "problem", tier: 2 },
  { text: "How do I improve my company's visibility in ChatGPT?", category: "problem", tier: 2 },
  { text: "How do I optimize a business for AI search?", category: "problem", tier: 2 },
  { text: "How can I compare my company's ChatGPT visibility with competitors?", category: "problem", tier: 2 },
  { text: "How do companies get cited by ChatGPT?", category: "problem", tier: 2 },
  { text: "How do brands improve their visibility in AI answers?", category: "problem", tier: 2 },
  // Tier 3 — informational / supporting
  { text: "GEO platform vs SEO platform — what is the difference and do I need both?", category: "comparison", tier: 3 },
  { text: "What is generative engine optimization and how does it work?", category: "how-to", tier: 3 },
  { text: "How does ChatGPT decide which companies to recommend?", category: "how-to", tier: 3 },
  { text: "What sources do AI assistants rely on when recommending software?", category: "how-to", tier: 3 },
  // Tier 4 — branded controls (recognition only; echo-excluded from rates)
  { text: "What is RecommendedFirst?", category: "branded", tier: 4 },
  { text: "Tell me about RecommendedFirst.", category: "branded", tier: 4 },
  { text: "What does the RecommendedFirst GEO platform do?", category: "branded", tier: 4 },
];

export function dogfoodTierCounts(): Record<1 | 2 | 3 | 4, number> {
  const counts: Record<1 | 2 | 3 | 4, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const p of DOGFOOD_PROMPTS) counts[p.tier] += 1;
  return counts;
}
