"use client";

/**
 * Interactive AI Visibility Audit demo (spec 061, brief §10–11). The hero
 * object of the site: an analyst's instrument, not a decorative image.
 *
 * Every value is a hand-written fixture. The switcher exists to teach one
 * idea: visibility is a distribution across assistants and questions, not
 * one ranking. Values are labeled illustrative at the point of display and
 * must never be presented as measurements.
 */
import { useState } from "react";
import { ShareBar, DataPoint, IllustrativeLabel } from "@/components/marketing/ui";

const MODELS = ["ChatGPT", "Gemini", "Claude", "Perplexity"] as const;

const PROMPTS = [
  "Who are the best luxury real estate agents in Manhattan?",
  "Who should I use to sell my Tribeca apartment?",
  "Top listing agents for $5M+ properties in NYC",
  "Best agent for luxury sellers in SoHo",
] as const;

const TEAMS = ["Your team", "Competitor A", "Competitor B", "Competitor C"] as const;

/**
 * shares[model][prompt] = [Your team, Competitor A, Competitor B, Competitor C]
 * as percentages of qualifying answers. Fixtures, chosen to show the same
 * story from different angles: the subject trails everywhere, by different
 * margins, and no two assistants agree exactly.
 */
const SHARES: Record<(typeof MODELS)[number], number[][]> = {
  ChatGPT: [
    [8, 62, 47, 31],
    [4, 58, 39, 22],
    [11, 51, 44, 27],
    [6, 66, 35, 18],
  ],
  Gemini: [
    [12, 54, 41, 36],
    [7, 49, 33, 28],
    [9, 57, 38, 24],
    [14, 46, 42, 21],
  ],
  Claude: [
    [6, 59, 52, 29],
    [9, 63, 37, 31],
    [5, 48, 41, 33],
    [8, 55, 46, 26],
  ],
  Perplexity: [
    [15, 47, 43, 38],
    [11, 52, 36, 29],
    [13, 44, 39, 32],
    [9, 58, 34, 27],
  ],
};

export function AuditDemo() {
  const [model, setModel] = useState<(typeof MODELS)[number]>("ChatGPT");
  const [promptIdx, setPromptIdx] = useState(0);

  const values = SHARES[model][promptIdx]!;
  const you = values[0]!;
  const topRival = Math.max(...values.slice(1));
  const gap = topRival - you;

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      {/* toolbar */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b px-5 py-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            AI visibility audit
          </p>
          <p className="mt-1 text-sm font-medium">Manhattan luxury real estate</p>
        </div>
        <div className="text-right">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Measurement window
          </p>
          <p className="mt-1 text-sm text-muted-foreground">Illustrative example — not a production benchmark. Columns are fictional; production benchmarks use the OpenAI model (gpt-5.4-mini, web search, API) and Perplexity (sonar, API).</p>
        </div>
      </div>

      {/* model tabs */}
      <div
        className="flex gap-1 overflow-x-auto border-b px-3 py-2"
        role="group"
        aria-label="AI assistant"
      >
        {MODELS.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={model === m}
            onClick={() => setModel(m)}
            className={`shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              model === m
                ? "bg-secondary font-medium"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {/* prompt selector */}
      <div
        className="flex gap-2 overflow-x-auto border-b px-5 py-3"
        role="group"
        aria-label="Question tested"
      >
        {PROMPTS.map((p, i) => (
          <button
            key={p}
            type="button"
            aria-pressed={promptIdx === i}
            onClick={() => setPromptIdx(i)}
            className={`shrink-0 rounded-md border px-3 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              promptIdx === i
                ? "border-foreground/40 font-medium"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {p}
          </button>
        ))}
      </div>

      <div className="px-5 py-5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Prompt
        </p>
        <p className="mt-1 max-w-[65ch] text-sm font-medium">
          &ldquo;{PROMPTS[promptIdx]}&rdquo;
        </p>

        <p className="mt-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          AI recommendation share · {model}
        </p>
        <div className="mt-2">
          {TEAMS.map((team, i) => (
            <ShareBar key={team} name={team} pct={values[i]!} isSubject={i === 0} />
          ))}
        </div>

        <div className="mt-6 grid grid-cols-2 gap-6 border-t pt-5 sm:grid-cols-3">
          <DataPoint
            label="Real-world position"
            value="#1"
            sub="Top-ranked producer (in this illustration)"
          />
          <DataPoint
            label="AI recommendation share"
            value={`${you}%`}
            sub="Of tested answers"
            negative
          />
          <DataPoint
            label="Gap to most-recommended"
            value={`−${gap} pts`}
            sub="Vs the leading competitor"
            negative
          />
        </div>

        <div className="mt-6 border-t pt-5">
          <p className="max-w-[52ch] text-lg font-medium tracking-tight">
            A team can lead its market in the real world and still be largely
            absent from AI answers.
          </p>
          <p className="mt-1.5 max-w-[65ch] text-sm text-muted-foreground">
            That discrepancy is the visibility gap we measure. Each assistant and
            each question gives a different reading; the pattern across all of
            them is the finding.
          </p>
        </div>
      </div>

      <div className="border-t bg-muted/40 px-5 py-3">
        <IllustrativeLabel />
      </div>
    </div>
  );
}
